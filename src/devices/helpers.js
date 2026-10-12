// -----------------------------------------------------------------------------
// Small helpers shared by every device module.
// -----------------------------------------------------------------------------

import { toThingUid } from '../devmel/client.js';

/**
 * Build the Gladys external ids of a Devmel device. The blueprint key is the
 * "type" part (`switch`, `shutter`…) and the AirSend id/channel the platform
 * part, so ids stay stable as long as the user does not renumber their
 * hardware.
 */
export function idsFor(gladys, blueprintKey, device) {
  return gladys.externalIds(blueprintKey, device.platformId);
}

/**
 * Send notes to a device and publish the resulting states.
 *
 * Radio commands are fire-and-forget by default (a 433 MHz shutter never
 * acknowledges), so `has_feedback` is false on those features and the value we
 * just sent is the value Gladys shows — unless the device is bound and the box
 * pushes the confirmation back, in which case the state is refreshed again.
 */
export async function sendNotes(client, device, notes, options = {}) {
  try {
    return await client.transfer(device, notes, {
      uid: options.uid ?? device.platformId,
      wait: options.wait ?? device.wait,
      callbackUrl: options.callbackUrl,
      stale: options.stale,
    });
  } catch (err) {
    if (err && typeof err === 'object') {
      err[RADIO_FAILURE] = true;
    }
    throw err;
  }
}

/** Marks an error thrown by the radio order itself (see `isRadioFailure`). */
const RADIO_FAILURE = Symbol('radio failure');

/**
 * Did this error come from the radio order, rather than from what followed it?
 *
 * A command sends its order, then publishes the new state. Gladys refusing that
 * state (429 once timed shutters fill the states allowed per minute, a 500)
 * fired `order_failed` with an HTTP_429 reason, "the box did not carry an
 * order", for a shutter that had moved.
 */
export function isRadioFailure(err) {
  return Boolean(err?.[RADIO_FAILURE]);
}

/** `true` when the value published by Gladys means "on". */
export function isOn(value) {
  return Number(value) > 0;
}

/**
 * Publish one feature state, dating it when it comes from a radio event that
 * arrived late.
 *
 * Events relayed by Gladys Plus can arrive late or out of order, so the box
 * timestamp — not the arrival time — is what the history of a SENSOR records
 * for a late frame. A frame heard just now is published undated: Gladys runs
 * the scene triggers on undated states only (see `pastDateOf`).
 *
 * LIVE_STATE: never what a shutter, a switch or a light publishes. Gladys
 * files a dated state as a past one, and only makes it the current value when
 * it is newer than the one it holds. Those devices are also published by the
 * integration itself — an order from Gladys, every step of a shutter travel —
 * stamped with the clock of the Gladys host. A box clock a few seconds behind
 * it, or a frame relayed a bit late, and the press of the wall remote went to
 * the history only: the shutter moved, Gladys kept showing where it was before.
 */
export async function publishState(gladys, featureExternalId, value, createdAt) {
  await gladys.publishState(
    featureExternalId,
    createdAt ? { state: value, created_at: createdAt } : value,
  );
}

/**
 * What Gladys was last shown for each device, and for each of its recent
 * orders what it showed before and after: the box can say, after Gladys was
 * answered and shown the new state (`wait: false`), that an order never
 * reached the air — and a plug shown ON that never heard the order is a plug
 * shown wrong.
 *
 * Several orders, not one: the box judges them in the order they went out,
 * possibly once two more were given (ON, OFF, ON clicked faster than it
 * answers), and each failure must be applied to the order it is about.
 *
 * A state is a plain object of feature values (`{ onOff: 1 }`).
 */
export class ShownStates {
  constructor() {
    /** @type {Map<string, object>} keyed by platform id */
    this.shown = new Map();
    /** @type {Map<string, Array<object>>} the recent orders of each device, oldest first */
    this.orders = new Map();
    /** @type {Set<string>} devices with an order on its way to the radio */
    this.pending = new Set();
  }

  get(platformId) {
    return this.shown.get(platformId);
  }

  /** What Gladys was just shown: a remote followed, a state restored. */
  set(platformId, state) {
    this.shown.set(platformId, state);
  }

  /**
   * A new order is on its way to the radio. Until the service takes it, the
   * newest order recorded is not the device's last one: answered by the box
   * before the service answered Gladys, a verdict meant for the new order
   * must find nothing to undo rather than undo the order before.
   */
  begin(platformId) {
    this.pending.add(platformId);
  }

  /**
   * The service took the order, and Gladys is about to be shown `after`.
   * `uid` is the one the order was sent under and `seq` its number (see
   * `SentOrders.settle`): a verdict names its order by them, and one on
   * another order of the device (a PING) must undo nothing.
   */
  sent(platformId, after, uid = null, seq = null) {
    const orders = this.orders.get(platformId) ?? [];
    orders.push({
      before: this.shown.get(platformId),
      after,
      uid: uid === null || uid === undefined ? null : toThingUid(uid),
      seq: Number.isFinite(seq) ? seq : null,
    });
    this.orders.set(platformId, orders.slice(-ORDERS_KEPT));
    this.pending.delete(platformId);
    this.shown.set(platformId, after);
  }

  /**
   * The box said an order never went out. Returns the state to show again,
   * or null when there is none: the state before it was never known, a
   * remote changed the state since — that one is right —, the verdict is
   * another order's (see `sent`), or the order was not the last one.
   *
   * An order given before the last one only changes what undoing the next
   * one goes back to: that one replaced a state the device was never in. ON
   * then OFF, both refused, ended shown ON; ON, OFF, ON all refused ended
   * shown ON too, the first failure applied to the second order.
   *
   * @param {object} verdict
   * @param {?string} [verdict.uid] the uid the failed order was sent under
   * @param {?number} [verdict.seq] its number
   * @param {boolean} [verdict.superseded] the same uid carried a newer order
   */
  notCarried(platformId, { uid = null, seq = null, superseded = false } = {}) {
    const orders = this.orders.get(platformId) ?? [];
    const index = this.find(platformId, orders, { uid, seq, superseded });
    if (index < 0) {
      return null;
    }
    const [order] = orders.splice(index, 1);
    const next = orders[index];
    if (next) {
      if (sameState(next.before, order.after)) {
        next.before = order.before;
      }
      return null;
    }
    if (superseded) {
      // The newer order is still on its way to the radio: it is about to be
      // shown, and recorded as replacing what the device really shows.
      if (order.before !== undefined && sameState(this.shown.get(platformId), order.after)) {
        this.shown.set(platformId, order.before);
      }
      return null;
    }
    if (
      order.before === undefined ||
      sameState(order.before, order.after) ||
      !sameState(this.shown.get(platformId), order.after)
    ) {
      return null;
    }
    this.shown.set(platformId, order.before);
    return order.before;
  }

  /**
   * Which recorded order a verdict is about: the one with its number. Orders
   * recorded without one (a driver that does not number them) are found by
   * position, as the last one or the one before it.
   */
  find(platformId, orders, { uid, seq, superseded }) {
    if (Number.isFinite(seq)) {
      const index = orders.findIndex((order) => order.seq === seq);
      if (index >= 0) {
        return index;
      }
    }
    const index = orders.length - (superseded ? 2 : 1) + (this.pending.has(platformId) ? 1 : 0);
    const order = orders[index];
    if (!order || order.seq !== null || (uid !== null && order.uid !== null && order.uid !== uid)) {
      return -1;
    }
    // A failed order before the last one changes the last one only when it
    // was sent under the same uid: both orders are about the same feature.
    if (superseded && orders[index + 1]?.uid !== order.uid) {
      return -1;
    }
    return index;
  }
}

/** Recent orders kept per device, for verdicts that come back late. */
const ORDERS_KEPT = 8;

function sameState(a, b) {
  if (!a || !b) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}
