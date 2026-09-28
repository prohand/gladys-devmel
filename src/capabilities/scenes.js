// -----------------------------------------------------------------------------
// Scene triggers (Gladys 5.1+): what HAPPENED on the radio, handed to the scene
// editor.
//
// Two triggers, declared in the manifest `scene_triggers`:
//
//   remote_pressed  a remote was pressed — the wall remote attached to a
//                   shutter, a keyfob declared as a sensor, a spare remote
//                   attached to a button. Its order already moves the device
//                   it drives; the trigger is for everything ELSE a scene can
//                   do with that press ("the living-room remote says down: close
//                   every shutter of the floor").
//   order_failed    the box did not carry an order Gladys gave it. Nothing
//                   acknowledges a radio order, so this is the only failure a
//                   scene can ever be told about — worth a notification.
//
// The doctrine of the core, in two lines: an event is not a state (the shutter
// position stays a feature), and one event per transition — a remote held down
// emits a frame every half second, and each press arrives as several frames.
// Hence the debounce below, and the "never throw": a scene event that could not
// be delivered must never cost the radio path the frame it came from.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { COMMANDS, READINGS } from '../devmel/notes.js';
import { describeFailure } from '../devmel/events.js';

const logger = createLogger({ name: 'scenes' });

/** Keys of the manifest `scene_triggers`. Never renamed: scenes store them. */
export const SCENE_TRIGGERS = {
  REMOTE_PRESSED: 'remote_pressed',
  ORDER_FAILED: 'order_failed',
};

/** Keys of the manifest `scene_actions`. Same rule. */
export const SCENE_ACTIONS = {
  SET_KNOWN_POSITION: 'set_known_position',
  REARM_LISTENING: 'rearm_listening',
};

/** The orders a remote press is reported as — the `order` filter of the trigger. */
export const REMOTE_ORDERS = {
  UP: 'up',
  DOWN: 'down',
  STOP: 'stop',
  FAVORITE: 'favorite',
  ON: 'on',
  OFF: 'off',
  TOGGLE: 'toggle',
};

/**
 * A press is several frames (the remote repeats itself for as long as the
 * button is held): the same order from the same device within this window is
 * the same press.
 */
export const PRESS_WINDOW_MS = 1500;

/** A failing box fails every order: one event per device and reason per minute. */
export const FAILURE_WINDOW_MS = 60 * 1000;

/**
 * The orders a decoded frame carries, as the trigger names them. A sensor
 * reading (a temperature) is not an order and gives nothing.
 *
 * @param {Array<object>} readings see `decodeNotes`
 * @returns {Array<string>} distinct orders, in the order they came
 */
export function ordersOf(readings) {
  const orders = [];
  for (const reading of readings ?? []) {
    const order = orderOf(reading);
    if (order && !orders.includes(order)) {
      orders.push(order);
    }
  }
  return orders;
}

function orderOf(reading) {
  switch (reading?.command) {
    case COMMANDS.UP:
      return REMOTE_ORDERS.UP;
    case COMMANDS.DOWN:
      return REMOTE_ORDERS.DOWN;
    case COMMANDS.STOP:
      return REMOTE_ORDERS.STOP;
    case COMMANDS.FAVORITE:
      return REMOTE_ORDERS.FAVORITE;
    default:
      break;
  }
  if (reading?.kind === READINGS.TOGGLE) {
    return REMOTE_ORDERS.TOGGLE;
  }
  if (reading?.kind === READINGS.LEVEL) {
    return Number(reading.value) > 0 ? REMOTE_ORDERS.ON : REMOTE_ORDERS.OFF;
  }
  return null;
}

/**
 * Why an order failed, as a short code a scene can filter or print: the name
 * the box gave the failure when it gave one, else what the transport says.
 */
export function failureReason(err) {
  if (err?.eventType !== undefined && err?.eventType !== null) {
    return eventReason(err.eventType);
  }
  const status = Number(err?.status);
  if (err?.status !== undefined && err?.status !== null && Number.isFinite(status)) {
    return `HTTP_${status}`;
  }
  return err?.transport === 'unreachable' ? 'UNREACHABLE' : 'ERROR';
}

/** The name of a failing event type: `SYNCHRONIZATION`, or `EVENT_300` when unknown. */
export function eventReason(type) {
  return describeFailure(type).name ?? `EVENT_${Number(type)}`;
}

export class SceneEvents {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] clock, so tests can date the presses
   */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, number>} last time each event key was fired */
    this.fired = new Map();
  }

  /**
   * A remote was heard giving `order` to `device`.
   *
   * @param {object} gladys the SDK instance
   * @param {object} press
   * @param {string} press.externalId the Gladys device it drives
   * @param {string} press.name its name, for the scene variables
   * @param {string} press.order one of REMOTE_ORDERS
   * @param {object} [press.channel] the emitter, pid/addr
   * @returns {Promise<boolean>} whether an event was published
   */
  async remotePressed(gladys, { externalId, name, order, channel }) {
    if (!this.admit(`press:${externalId}:${order}`, PRESS_WINDOW_MS)) {
      return false;
    }
    return this.publish(gladys, SCENE_TRIGGERS.REMOTE_PRESSED, {
      device: externalId,
      device_name: name,
      order,
      pid: toNumberOrNull(channel?.id),
      addr: toNumberOrNull(channel?.source),
    });
  }

  /**
   * An order Gladys gave did not go out.
   *
   * @param {object} gladys the SDK instance
   * @param {object} failure
   * @param {string} failure.externalId the Gladys device it was for
   * @param {string} failure.name its name
   * @param {string} failure.reason short code (see `failureReason`)
   * @param {string} [failure.message] the line the logs say about it
   */
  async orderFailed(gladys, { externalId, name, reason, message }) {
    if (!this.admit(`failure:${externalId}:${reason}`, FAILURE_WINDOW_MS)) {
      return false;
    }
    return this.publish(gladys, SCENE_TRIGGERS.ORDER_FAILED, {
      device: externalId,
      device_name: name,
      reason,
      message: String(message ?? '').slice(0, 1000),
    });
  }

  /** Is this event new, or the same one again within its window? */
  admit(key, windowMs) {
    const now = this.now();
    const last = this.fired.get(key);
    if (last !== undefined && now - last < windowMs) {
      return false;
    }
    this.fired.set(key, now);
    // Bounded: a key per device and order, but the air is public.
    if (this.fired.size > 256) {
      this.fired.delete(this.fired.keys().next().value);
    }
    return true;
  }

  async publish(gladys, key, data) {
    if (typeof gladys?.publishSceneEvent !== 'function') {
      return false;
    }
    try {
      await gladys.publishSceneEvent(key, data);
      logger.debug(`Scene event ${key}: ${JSON.stringify(data)}`);
      return true;
    } catch (err) {
      // A Gladys too old for scene triggers answers 404, a burst 429: neither is
      // a reason to lose the frame this event came from.
      logger.debug(`Could not publish the scene event ${key}: ${err.message}`);
      return false;
    }
  }
}

function toNumberOrNull(value) {
  const number = Number(value);
  return value === undefined || value === null || !Number.isFinite(number) ? null : number;
}

/** The scene events of the running integration. */
export const sceneEvents = new SceneEvents();
