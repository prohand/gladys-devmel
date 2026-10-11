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
import { failureReason, PRESS_WINDOW_MS, sceneEvents } from '../capabilities/scenes.js';
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

  /** Where `order_failed` is fired from, held here for the same reason. */
  scenes: sceneEvents,

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
   *
   * Only when the travel knows nothing. This also runs on every reconnection to
   * Gladys and every saved configuration, and then the value Gladys kept is
   * older than the one in memory: setting it cancelled the movement under way —
   * a shutter driven to 40 % never got its STOP and ran into its end stop,
   * while Gladys stayed on the last position it had been told.
   */
  restoreStates(gladys, { device, features }) {
    if (!hasPosition(device)) {
      return;
    }
    if (shutter.travel.positionOf(device) !== null || shutter.travel.isMoving(device)) {
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
    shutter.restoreStates(gladys, { device, features });
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
        await goTo(gladys, device, ids, destination, { announced: toOrderedState(destination) });
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
 * `announced` is the state the order announces, published here, so the arrival
 * only publishes a state when it says something new (a shutter told to open is
 * "open" both before and after the travel; one told to go to 40 % ends up
 * stopped in between). `direction` is the one the radio order was given, when
 * the caller chose it.
 *
 * Called once the order is on the air, and the travel is armed before anything
 * is published: a publication Gladys refused (429, a timeout) left the STOP of
 * a shutter driven to 40 % unarmed, and one merely slow let a STOP heard
 * meanwhile find a still shutter, then the travel start after it. Nor does a
 * refused state make the order fail: it went out.
 */
async function goTo(
  gladys,
  device,
  ids,
  destination,
  { announced = null, onArrival = null, direction = null } = {},
) {
  const way = direction ?? travelDirection(shutter.travel.positionOf(device), destination);
  const moving =
    way !== null &&
    shutter.travel.move(device, {
      direction: way,
      target: destination,
      arrive: onArrival,
      publish: async (position, { done }) => {
        await publishPosition(gladys, device, ids, position);
        if (!done) {
          return;
        }
        const arrived = toShutterState(position);
        if (arrived !== announced) {
          await publishState(gladys, ids.feature(FEATURE.STATE), arrived);
        }
      },
    });
  if (!moving) {
    shutter.travel.set(device, destination);
  }
  if (announced !== null) {
    try {
      await publishState(gladys, ids.feature(FEATURE.STATE), announced);
    } catch (error) {
      logger.warn(`State of "${device.name}" not published: ${error.message}`);
    }
  }
  if (!moving) {
    await publishPosition(gladys, device, ids, destination);
  }
}

/**
 * Drive a shutter that has no positionable motor to a position, with a
 * stopwatch: start it in the right direction and stop it when the travel says
 * it has arrived. This is what gives a plain 4098 a usable position slider.
 *
 * One positioning at a time per shutter: each decides from where the shutter
 * is, and two sent together (40 %, then 100 %) both read where it was before
 * either had started — the second found it "already at 100 %" and was dropped.
 */
function driveTo(gladys, device, ids, target, radio) {
  const previous = driving.get(device.platformId) ?? Promise.resolve();
  const run = previous.then(() => drive(gladys, device, ids, target, radio));
  const tail = run.catch(() => {});
  driving.set(device.platformId, tail);
  tail.then(() => {
    if (driving.get(device.platformId) === tail) {
      driving.delete(device.platformId);
    }
  });
  return run;
}

/** The positioning under way per shutter, by platform id (see `driveTo`). */
const driving = new Map();

async function drive(gladys, device, ids, target, { client, callbackUrl, uid }) {
  const current = shutter.travel.positionOf(device);
  // With no reference, the only position this shutter can be sent to is an end
  // stop: the motor stops there by itself, and that is where the reference for
  // every later positioning is established.
  const destination = current === null ? (target < 50 ? 0 : 100) : target;
  let direction = travelDirection(current, destination);
  if (direction === null && shutter.travel.isMoving(device)) {
    // Moving, and passing the position asked for right now: "already there"
    // let it run on. An end stop is where it is leaving: it is sent back. A
    // position in between is where it is: it is stopped there.
    if (destination <= 0 || destination >= 100) {
      direction = destination >= 100 ? DIRECTIONS.UP : DIRECTIONS.DOWN;
    } else {
      logger.info(`"${device.name}" -> ${destination} % (passing it: stopped there)`);
      await sendNotes(client, device, [stateNote(STATE_VALUES.STOP)], { uid, callbackUrl });
      await freeze(gladys, device, ids);
      return;
    }
  }
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
  // The order took its time to reach the air, and a shutter already moving
  // that way may have reached the target meanwhile: it is stopped where it is.
  // Tracked as the travel to the target instead, it got no STOP at all (on the
  // target) or one late and in the wrong place (past it).
  const reached = shutter.travel.positionOf(device);
  if (
    reached !== null &&
    destination > 0 &&
    destination < 100 &&
    (direction === DIRECTIONS.UP ? reached >= destination : reached <= destination)
  ) {
    logger.info(`"${device.name}" reached ${destination} % before the order went out: stopped`);
    await sendNotes(client, device, [stateNote(STATE_VALUES.STOP)], { uid, callbackUrl });
    await freeze(gladys, device, ids);
    return;
  }
  await goTo(gladys, device, ids, destination, {
    announced: state,
    direction,
    onArrival: async () => {
      // At an end stop the motor stops on its own; anywhere else it has to be
      // told, at the very moment the travel says it is there.
      if (destination <= 0 || destination >= 100) {
        return;
      }
      try {
        await sendNotes(client, device, [stateNote(STATE_VALUES.STOP)], {
          uid,
          callbackUrl,
          // Dropped if, by its turn on the radio, a newer order has set the
          // shutter off again (a wall remote pressed meanwhile): it would stop
          // the shutter the user just sent somewhere else.
          stale: () => shutter.travel.isMoving(device),
        });
      } catch (err) {
        // The one failure of this order that matters most, and the only one
        // nobody was waiting for: Gladys was answered when the travel started.
        await shutter.scenes.orderFailed(gladys, {
          externalId: ids.device,
          name: device.name,
          reason: failureReason(err),
          message: err.message,
        });
        throw err;
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
  // can — once the user has said what that position is, and only for a shutter
  // it times: an untimed one never "moves" for the travel, and every STOP it
  // was given mid-course was read as "go to your favourite position".
  if (!wasMoving && hasFavorite(device) && shutter.travel.tracks(device)) {
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
  await goTo(gladys, device, ids, favorite, { announced: toShutterState(favorite) });
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
