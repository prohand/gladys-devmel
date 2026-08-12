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
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES } from '../config.js';
import { clampLevel, levelNote, READINGS, stateNote, STATE_VALUES } from '../devmel/notes.js';
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
    if (device.rtype === DEVICE_TYPES.SHUTTER_POSITION) {
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

  async onSetValue(gladys, { device, feature, value, client, callbackUrl }) {
    const ids = idsFor(gladys, KEY, device);

    if (feature.external_id === ids.feature(FEATURE.POSITION)) {
      const position = clampLevel(value);
      logger.info(`"${device.name}" -> ${position} %`);
      await sendNotes(client, device, [levelNote(device.invert ? 100 - position : position)], {
        uid: feature.external_id,
        callbackUrl,
      });
      await publishState(gladys, feature.external_id, position);
      await publishState(gladys, ids.feature(FEATURE.STATE), toShutterState(position));
      return;
    }

    const state = Number(value);
    const note = stateNote(toRadioState(state, device.invert));
    logger.info(`"${device.name}" -> ${describe(state)}`);
    await sendNotes(client, device, [note], { uid: feature.external_id, callbackUrl });
    await publishState(gladys, feature.external_id, state);
    if (device.rtype === DEVICE_TYPES.SHUTTER_POSITION && state !== SHUTTER_STATE.STOP) {
      await publishState(
        gladys,
        ids.feature(FEATURE.POSITION),
        state === SHUTTER_STATE.OPEN ? 100 : 0,
      );
    }
  },

  async applyReadings(gladys, { device, readings, createdAt }) {
    const ids = idsFor(gladys, KEY, device);
    for (const reading of readings) {
      if (reading.kind === READINGS.LEVEL) {
        const position = device.invert ? 100 - reading.value : reading.value;
        await publishState(gladys, ids.feature(FEATURE.STATE), toShutterState(position), createdAt);
        if (device.rtype === DEVICE_TYPES.SHUTTER_POSITION) {
          await publishState(gladys, ids.feature(FEATURE.POSITION), position, createdAt);
        }
      } else if (reading.kind === READINGS.STATE && reading.value === 'stop') {
        await publishState(gladys, ids.feature(FEATURE.STATE), SHUTTER_STATE.STOP, createdAt);
      }
    }
  },

  async identify(_gladys, { device, client, callbackUrl }) {
    await sendNotes(client, device, [stateNote(STATE_VALUES.PING)], { callbackUrl });
  },
};

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

function describe(state) {
  if (state === SHUTTER_STATE.OPEN) {
    return 'OPEN';
  }
  return state === SHUTTER_STATE.CLOSED ? 'CLOSE' : 'STOP';
}
