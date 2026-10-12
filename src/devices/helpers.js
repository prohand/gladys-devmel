// -----------------------------------------------------------------------------
// Small helpers shared by every device module.
// -----------------------------------------------------------------------------

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
 * What Gladys was last shown for each device, and for its last order what it
 * showed before and after: the box can say, after Gladys was answered and
 * shown the new state (`wait: false`), that the order never reached the air —
 * and a plug shown ON that never heard the order is a plug shown wrong.
 *
 * A state is a plain object of feature values (`{ onOff: 1 }`).
 */
export class ShownStates {
  constructor() {
    /** @type {Map<string, object>} keyed by platform id */
    this.shown = new Map();
    /** @type {Map<string, object>} the last order of each device */
    this.orders = new Map();
  }

  get(platformId) {
    return this.shown.get(platformId);
  }

  /** What Gladys was just shown: a remote followed, a state restored. */
  set(platformId, state) {
    this.shown.set(platformId, state);
  }

  /**
   * A new order is on its way to the radio. The one before is forgotten first:
   * waiting in the queue, or answered by the box before the service answered
   * Gladys, the new order is not recorded yet — and a verdict meant for it
   * must find nothing to undo rather than undo the order before.
   */
  begin(platformId) {
    this.orders.delete(platformId);
  }

  /** The service took the order, and Gladys is about to be shown `after`. */
  sent(platformId, after) {
    this.orders.set(platformId, { before: this.shown.get(platformId), after });
    this.shown.set(platformId, after);
  }

  /**
   * The box said the last order never went out. Returns the state to show
   * again, or null when there is none: the state before it was never known,
   * or a remote changed the state since — that one is right.
   */
  undo(platformId) {
    const order = this.orders.get(platformId);
    this.orders.delete(platformId);
    if (
      !order ||
      order.before === undefined ||
      !sameState(this.shown.get(platformId), order.after)
    ) {
      return null;
    }
    this.shown.set(platformId, order.before);
    return order.before;
  }
}

function sameState(a, b) {
  if (!a || !b) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}
