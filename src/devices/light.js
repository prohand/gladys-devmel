// -----------------------------------------------------------------------------
// Device type: DIMMABLE LIGHT (airsend.cloud type 4100)
//
// Two controllable features on one device: on/off and brightness. Both end up
// as the same radio note — a LEVEL between 0 and 100 % — except the explicit
// switch-off, which the protocol spells as a STATE note so the lamp goes back
// to its own "off" instead of a 0 % dim.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES } from '../config.js';
import { clampLevel, levelNote, READINGS, stateNote, STATE_VALUES } from '../devmel/notes.js';
import { idsFor, isOn, publishState, sendNotes } from './helpers.js';

const KEY = 'light';

const logger = createLogger({ name: KEY });

const FEATURE = {
  ON_OFF: 'on-off',
  BRIGHTNESS: 'brightness',
};

// Brightness to restore when the light is switched back on, per device.
const lastBrightness = new Map();

export const light = {
  key: KEY,
  types: [DEVICE_TYPES.LIGHT],

  buildDevice(gladys, device) {
    const ids = idsFor(gladys, KEY, device);
    return {
      name: device.name,
      external_id: ids.device,
      features: [
        {
          name: 'On/Off',
          external_id: ids.feature(FEATURE.ON_OFF),
          category: DEVICE_FEATURE_CATEGORIES.LIGHT,
          type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
          read_only: false,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Brightness',
          external_id: ids.feature(FEATURE.BRIGHTNESS),
          category: DEVICE_FEATURE_CATEGORIES.LIGHT,
          type: DEVICE_FEATURE_TYPES.LIGHT.BRIGHTNESS,
          unit: DEVICE_FEATURE_UNITS.PERCENT,
          min: 0,
          max: 100,
          read_only: false,
          has_feedback: false,
          keep_history: true,
        },
      ],
    };
  },

  async onSetValue(gladys, { device, feature, value, client, callbackUrl }) {
    const ids = idsFor(gladys, KEY, device);

    if (feature.external_id === ids.feature(FEATURE.BRIGHTNESS)) {
      const level = clampLevel(value);
      logger.info(`"${device.name}" -> ${level} %`);
      await sendNotes(client, device, [levelNote(level)], {
        uid: feature.external_id,
        callbackUrl,
      });
      if (level > 0) {
        lastBrightness.set(device.platformId, level);
      }
      await publishState(gladys, feature.external_id, level);
      await publishState(gladys, ids.feature(FEATURE.ON_OFF), level > 0 ? 1 : 0);
      return;
    }

    const on = isOn(value);
    // Switching on means "go back to the last brightness"; the protocol has no
    // "restore" order, so the level is what turns the lamp on.
    const level = lastBrightness.get(device.platformId) ?? 100;
    logger.info(`"${device.name}" -> ${on ? `ON (${level} %)` : 'OFF'}`);
    await sendNotes(client, device, [on ? levelNote(level) : stateNote(STATE_VALUES.OFF)], {
      uid: feature.external_id,
      callbackUrl,
    });
    await publishState(gladys, feature.external_id, on ? 1 : 0);
    await publishState(gladys, ids.feature(FEATURE.BRIGHTNESS), on ? level : 0);
  },

  /** @returns {Promise<number>} how many readings this light acted on. */
  async applyReadings(gladys, { device, readings, createdAt }) {
    const ids = idsFor(gladys, KEY, device);
    let handled = 0;
    for (const reading of readings) {
      if (reading.kind !== READINGS.LEVEL) {
        continue;
      }
      handled += 1;
      if (reading.value > 0) {
        lastBrightness.set(device.platformId, reading.value);
      }
      await publishState(gladys, ids.feature(FEATURE.BRIGHTNESS), reading.value, createdAt);
      await publishState(gladys, ids.feature(FEATURE.ON_OFF), reading.value > 0 ? 1 : 0, createdAt);
    }
    return handled;
  },

  async identify(_gladys, { device, client, callbackUrl }) {
    await sendNotes(client, device, [stateNote(STATE_VALUES.PING)], { callbackUrl });
  },
};
