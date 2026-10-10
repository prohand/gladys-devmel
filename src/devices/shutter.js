// -----------------------------------------------------------------------------
// Device type: SHUTTER (airsend.cloud types 4098 and 4099)
//
// Roller shutters, blinds, awnings, gates. Type 4099 is the same hardware with
// a positionable motor, so it gets one extra feature: both share this module,
// and therefore keep the same Gladys device when the user upgrades the type in
// their configuration.
//
// Gladys spells the shutter state 1 = open, 0 = stop, -1 = closed; the radio
// spells it UP / STOP / DOWN. Devices installed upside down (sun sails,
// projector screens) declare `invert: true` and the two orders are swapped.
//
// The radio never says where a shutter is — it only carries orders. A shutter
// given its travel times (`travel_up` / `travel_down`, in seconds) therefore
// gets its position computed by src/devmel/travel.js, from our own orders and
// from the ones heard on the radio, and resynchronized on every end stop. That
// is what turns "I told it to open" into "it is 40 % open", and it gives a
// position to a plain 4098 too. Without those times the position stays what the
// protocol allows: the destination of the last order.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createLogger } from '../logging.js';
import { DEVICE_TYPES } from '../config.js';
import {
  clampLevel,
  COMMANDS,
  levelNote,
  READINGS,
  stateNote,
  STATE_VALUES,
} from '../devmel/notes.js';
import { DIRECTIONS, ShutterTravel } from '../devmel/travel.js';
import { PRESS_WINDOW_MS } from '../capabilities/scenes.js';
import { idsFor, publishState, sendNotes } from './helpers.js';

const KEY = 'shutter';

const logger = createLogger({ name: KEY });

const FEATURE = {
  STATE: 'state',
  POSITION: 'position',
};

const SHUTTER_STATE = { OPEN: 1, STOP: 0, CLOSED: -1 };

export const shutter = {
  key: KEY,
  types: [DEVICE_TYPES.SHUTTER, DEVICE_TYPES.SHUTTER_POSITION],

  /**
   * Position tracker, shared by every shutter. Held on the blueprint rather
   * than in a module constant so the tests can drive its clock.
   */
  travel: new ShutterTravel(),

  buildDevice(gladys, device) {
    const ids = idsFor(gladys, KEY, device);
    const features = [
      {
        name: 'State',
        external_id: ids.feature(FEATURE.STATE),
        category: DEVICE_FEATURE_CATEGORIES.SHUTTER,
        type: DEVICE_FEATURE_TYPES.SHUTTER.STATE,
        min: -1,
        max: 1,
        read_only: false,
        has_feedback: false,
        keep_history: true,
      },
    ];
    if (hasPosition(device)) {
      features.push({
        name: 'Position',
        external_id: ids.feature(FEATURE.POSITION),
        category: DEVICE_FEATURE_CATEGORIES.SHUTTER,
        type: DEVICE_FEATURE_TYPES.SHUTTER.POSITION,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: false,
        has_feedback: false,
        keep_history: true,
      });
    }
    return { name: device.name, external_id: ids.device, features };
  },

  /**
   * Pick the position tracking back up where it was left: without this, every
   * restart of the integration would start from "position unknown" and wait for
   * the next full travel to know anything again.
   */
  restoreStates(gladys, { device, features }) {
    if (!hasPosition(device)) {
      return;
    }
    const ids = idsFor(gladys, KEY, device);
    const stored = features?.find(
      (feature) => feature.external_id === ids.feature(FEATURE.POSITION),
    );
    if (Number.isFinite(stored?.last_value)) {
      shutter.travel.set(device, stored.last_value);
      logger.debug(`"${device.name}" restored at ${stored.last_value} %`);
    }
  },

  /**
   * Publish the position the travel knows, for a device Gladys only just
   * created: everything published before it existed was dropped. A device
   * updated or re-created with a stored position is picked up from it when the
   * travel knows nothing better.
   */
  async replayStates(gladys, { device, features }) {
    if (!hasPosition(device)) {
      return;
    }
    if (shutter.travel.positionOf(device) === null && !shutter.travel.isMoving(device)) {
      shutter.restoreStates(gladys, { device, features });
    }
    // A moving shutter publishes its position on every tick anyway.
    const position = shutter.travel.positionOf(device);
    if (position === null || shutter.travel.isMoving(device)) {
      return;
    }
    const ids = idsFor(gladys, KEY, device);
    await publishState(gladys, ids.feature(FEATURE.STATE), toShutterState(position));
    await publishPosition(gladys, device, ids, position);
  },

  async onSetValue(gladys, { device, feature, value, client, callbackUrl }) {
    const ids = idsFor(gladys, KEY, device);

    if (feature.external_id === ids.feature(FEATURE.POSITION)) {
      const position = clampLevel(value);
      const radio = { client, callbackUrl, uid: feature.external_id };
      // A 4099 positions itself: the motor is told the percentage and finds it.
      // A timed 4098 has no such motor — it is driven there with a stopwatch.
      if (device.rtype !== DEVICE_TYPES.SHUTTER_POSITION) {
        await driveTo(gladys, device, ids, position, radio);
        return;
      }
      logger.info(`"${device.name}" -> ${position} %`);
      await sendNotes(client, device, [levelNote(device.invert ? 100 - position : position)], {
        uid: radio.uid,
        callbackUrl,
      });
      await goTo(gladys, device, ids, position);
      return;
    }

    const state = Number(value);
    const note = stateNote(toRadioState(state, device.invert));
    logger.info(`"${device.name}" -> ${describe(state)}`);
    await sendNotes(client, device, [note], { uid: feature.external_id, callbackUrl });

    if (state === SHUTTER_STATE.STOP) {
      await freeze(gladys, device, ids);
      return;
    }
    await publishState(gladys, ids.feature(FEATURE.STATE), state);
    await goTo(gladys, device, ids, state === SHUTTER_STATE.OPEN ? 100 : 0, {
      announced: state,
    });
  },

  /**
   * Publish what a radio frame said. Orders (a wall remote pressed by hand, the
   * echo of our own command) start the position tracking; only a reading with
   * no `command` is a position the hardware actually reported.
   *
   * Published at the time they are heard, never dated with the box timestamp:
   * see `LIVE_STATE` in helpers.js.
   *
   * @returns {Promise<number>} how many readings this shutter acted on — zero
   *   means the frame was heard and understood by nobody, which is the one
   *   thing the user must be told (see `applyEvents`).
   */
  async applyReadings(gladys, { device, readings }) {
    const ids = idsFor(gladys, KEY, device);
    let handled = 0;
    for (const reading of readings) {
      if (reading.command === COMMANDS.STOP) {
        // A remote repeats its frame for as long as the button is held: the
        // second STOP of one press is no new order. Read as one, it would stop
        // the shutter the first STOP has just sent to its favorite position.
        if (!isRepeatedStop(device)) {
          await freeze(gladys, device, ids);
        }
      } else if (reading.command === COMMANDS.FAVORITE) {
        await goToFavorite(gladys, device, ids);
      } else if (reading.command === COMMANDS.UP || reading.command === COMMANDS.DOWN) {
        // The reading is in radio coordinates, like every level here: a shutter
        // wired upside down opens by going down.
        const destination = device.invert ? 100 - reading.value : reading.value;
        const announced = toOrderedState(destination);
        await publishState(gladys, ids.feature(FEATURE.STATE), announced);
        await goTo(gladys, device, ids, destination, { announced });
      } else if (reading.kind === READINGS.LEVEL) {
        const position = device.invert ? 100 - reading.value : reading.value;
        shutter.travel.set(device, position);
        await publishPosition(gladys, device, ids, position);
      } else {
        continue;
      }
      handled += 1;
    }
    return handled;
  },

  async identify(_gladys, { device, client, callbackUrl }) {
    await sendNotes(client, device, [stateNote(STATE_VALUES.PING)], { callbackUrl });
  },

  /**
   * Tell the travel where the shutter really is, without moving it: after a
   * power cut, a crank turned by hand, a motor stopped by an obstacle. The
   * `set_known_position` scene action, the same idea as the "set known
   * position" of the time-based covers of Home Assistant.
   */
  async setKnownPosition(gladys, { device, position }) {
    if (!hasPosition(device)) {
      throw new Error(
        `"${device.name}" has no position: give it travel_up / travel_down, or declare it as type 4099`,
      );
    }
    const ids = idsFor(gladys, KEY, device);
    const known = clampLevel(position);
    shutter.travel.set(device, known);
    logger.info(`"${device.name}" is known to be at ${known} %`);
    await publishState(gladys, ids.feature(FEATURE.STATE), toShutterState(known));
    await publishPosition(gladys, device, ids, known);
    return known;
  },
};

/** A shutter shows a position when its motor has one, or when it was timed. */
function hasPosition(device) {
  return device.rtype === DEVICE_TYPES.SHUTTER_POSITION || shutter.travel.tracks(device);
}

/**
 * Send the shutter to a position: track the travel when the shutter was timed,
 * otherwise publish the destination straight away — the protocol offers nothing
 * better, and it is what the official Devmel component does.
 *
 * `announced` is the state already published for the order under way, so the
 * arrival only publishes a state when it says something new (a shutter told to
 * open is "open" both before and after the travel; one told to go to 40 % ends
 * up stopped in between).
 */
async function goTo(gladys, device, ids, destination, { announced = null, onArrival } = {}) {
  const direction = travelDirection(shutter.travel.positionOf(device), destination);
  const moving =
    direction !== null &&
    shutter.travel.move(device, {
      direction,
      target: destination,
      publish: async (position, { done }) => {
        if (!done) {
          await publishPosition(gladys, device, ids, position);
          return;
        }
        // The STOP of a shutter driven to a mid-course position goes out FIRST:
        // a radio order is time-critical, a publication is not, and a Gladys
        // that fails to take the position must not leave the motor running to
        // its end stop.
        try {
          if (onArrival) {
            await onArrival();
          }
        } finally {
          await publishPosition(gladys, device, ids, position);
        }
        const arrived = toShutterState(position);
        if (arrived !== announced) {
          await publishState(gladys, ids.feature(FEATURE.STATE), arrived);
        }
      },
    });
  if (moving) {
    return;
  }
  shutter.travel.set(device, destination);
  await publishPosition(gladys, device, ids, destination);
}

/**
 * Drive a shutter that has no positionable motor to a position, with a
 * stopwatch: start it in the right direction and stop it when the travel says
 * it has arrived. This is what gives a plain 4098 a usable position slider.
 */
async function driveTo(gladys, device, ids, target, { client, callbackUrl, uid }) {
  const current = shutter.travel.positionOf(device);
  // With no reference, the only position this shutter can be sent to is an end
  // stop: the motor stops there by itself, and that is where the reference for
  // every later positioning is established.
  const destination = current === null ? (target < 50 ? 0 : 100) : target;
  const direction = travelDirection(current, destination);
  if (direction === null) {
    logger.info(`"${device.name}" is already at ${destination} %`);
    await publishPosition(gladys, device, ids, destination);
    return;
  }

  const state = direction === DIRECTIONS.UP ? SHUTTER_STATE.OPEN : SHUTTER_STATE.CLOSED;
  logger.info(
    current === null
      ? `"${device.name}" -> ${destination} % (no reference yet: running to the end stop)`
      : `"${device.name}" -> ${destination} % (timed, from ${current} %)`,
  );
  await sendNotes(client, device, [stateNote(toRadioState(state, device.invert))], {
    uid,
    callbackUrl,
  });
  await publishState(gladys, ids.feature(FEATURE.STATE), state);
  await goTo(gladys, device, ids, destination, {
    announced: state,
    onArrival: async () => {
      // At an end stop the motor stops on its own; anywhere else it has to be
      // told, at the very moment the travel says it is there.
      if (destination > 0 && destination < 100) {
        await sendNotes(client, device, [stateNote(STATE_VALUES.STOP)], { uid, callbackUrl });
      }
    },
  });
}

/**
 * Which way the shutter travels to reach `destination`, or null when there is
 * no journey to follow: it is already there, or it starts from an unknown
 * position and is not heading for an end stop — and only an end stop tells us
 * where it truly ended up.
 */
function travelDirection(current, destination) {
  if (current === null) {
    if (destination >= 100) {
      return DIRECTIONS.UP;
    }
    return destination <= 0 ? DIRECTIONS.DOWN : null;
  }
  if (destination === current) {
    return null;
  }
  return destination > current ? DIRECTIONS.UP : DIRECTIONS.DOWN;
}

/**
 * A STOP order: the shutter stays wherever the travel had taken it. Only a
 * shutter that was actually moving has a new position to report — stopping a
 * still one says nothing Gladys does not already show.
 */
async function freeze(gladys, device, ids) {
  const wasMoving = shutter.travel.isMoving(device);
  // The Somfy "my" button and the STOP order are one and the same frame: it
  // stops a shutter that moves, and sends a still one to the position
  // programmed in its motor. The radio cannot tell the two apart, the travel
  // can — once the user has said what that position is.
  if (!wasMoving && hasFavorite(device)) {
    await goToFavorite(gladys, device, ids);
    return;
  }
  const position = shutter.travel.stop(device);
  await publishState(gladys, ids.feature(FEATURE.STATE), SHUTTER_STATE.STOP);
  if (wasMoving && position !== null) {
    await publishPosition(gladys, device, ids, position);
  }
}

/**
 * The shutter went to the position programmed in the motor itself (the Somfy
 * "my" button). Only the user knows what that position is: without
 * `favorite_position`, the shutter is somewhere in between and saying more
 * would be inventing it.
 */
async function goToFavorite(gladys, device, ids) {
  const favorite = device.favoritePosition;
  if (favorite === null || favorite === undefined) {
    shutter.travel.set(device, null);
    await publishState(gladys, ids.feature(FEATURE.STATE), SHUTTER_STATE.STOP);
    return;
  }
  // Travelled like any other order, so the position follows the shutter
  // instead of jumping there.
  const announced = toShutterState(favorite);
  await publishState(gladys, ids.feature(FEATURE.STATE), announced);
  await goTo(gladys, device, ids, favorite, { announced });
}

function hasFavorite(device) {
  return device.favoritePosition !== null && device.favoritePosition !== undefined;
}

/**
 * When each shutter last heard a STOP on the radio, keyed by platform id —
 * per travel, so that whoever swaps the travel (the tests, with their own
 * clock) starts from a clean slate.
 */
const lastStopHeard = new WeakMap();

/** Is this STOP the same press as the one heard a moment ago? */
function isRepeatedStop(device) {
  const travel = shutter.travel;
  if (!lastStopHeard.has(travel)) {
    lastStopHeard.set(travel, new Map());
  }
  const heard = lastStopHeard.get(travel);
  const now = travel.now();
  const last = heard.get(device.platformId);
  heard.set(device.platformId, now);
  return last !== undefined && now - last < PRESS_WINDOW_MS;
}

/** Publish a position, on the shutters that expose one. */
async function publishPosition(gladys, device, ids, position) {
  if (!hasPosition(device)) {
    return;
  }
  await publishState(gladys, ids.feature(FEATURE.POSITION), position);
}

function toRadioState(state, invert) {
  if (state === SHUTTER_STATE.STOP) {
    return STATE_VALUES.STOP;
  }
  const goingUp = state === SHUTTER_STATE.OPEN;
  return (invert ? !goingUp : goingUp) ? STATE_VALUES.UP : STATE_VALUES.DOWN;
}

function toShutterState(position) {
  if (position >= 100) {
    return SHUTTER_STATE.OPEN;
  }
  return position <= 0 ? SHUTTER_STATE.CLOSED : SHUTTER_STATE.STOP;
}

/** The state an order announces, before the shutter has travelled anywhere. */
function toOrderedState(destination) {
  return destination >= 100 ? SHUTTER_STATE.OPEN : SHUTTER_STATE.CLOSED;
}

function describe(state) {
  if (state === SHUTTER_STATE.OPEN) {
    return 'OPEN';
  }
  return state === SHUTTER_STATE.CLOSED ? 'CLOSE' : 'STOP';
}
