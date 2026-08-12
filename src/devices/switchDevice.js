// -----------------------------------------------------------------------------
// Device type: SWITCH (airsend.cloud type 4097)
//
// A binary radio actuator: a plug, a relay, a light behind an ON/OFF remote.
// The command is one STATE note (ON / OFF).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES } from '../config.js';
import { READINGS, stateNote, STATE_VALUES } from '../devmel/notes.js';
import { idsFor, isOn, publishState, sendNotes } from './helpers.js';

const KEY = 'switch';

const logger = createLogger({ name: KEY });

const FEATURE = { ON_OFF: 'on-off' };

export const switchDevice = {
  key: KEY,
  types: [DEVICE_TYPES.SWITCH],

  buildDevice(gladys, device) {
    const ids = idsFor(gladys, KEY, device);
    return {
      name: device.name,
      external_id: ids.device,
      features: [
        {
          name: 'On/Off',
          external_id: ids.feature(FEATURE.ON_OFF),
          category: DEVICE_FEATURE_CATEGORIES.SWITCH,
          type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
          read_only: false,
          // 433 MHz is a one-way protocol: nothing confirms the order was
          // received. States pushed by a bound box refresh the value later.
          has_feedback: false,
          keep_history: true,
        },
      ],
    };
  },

  async onSetValue(gladys, { device, feature, value, client, callbackUrl }) {
    const on = isOn(value);
    logger.info(`"${device.name}" -> ${on ? 'ON' : 'OFF'}`);
    await sendNotes(client, device, [stateNote(on ? STATE_VALUES.ON : STATE_VALUES.OFF)], {
      uid: feature.external_id,
      callbackUrl,
    });
    await publishState(gladys, feature.external_id, on ? 1 : 0);
  },

  async applyReadings(gladys, { device, readings, createdAt }) {
    const ids = idsFor(gladys, KEY, device);
    for (const reading of readings) {
      if (reading.kind === READINGS.LEVEL) {
        await publishState(
          gladys,
          ids.feature(FEATURE.ON_OFF),
          reading.value > 0 ? 1 : 0,
          createdAt,
        );
      }
    }
  },

  async identify(_gladys, { device, client, callbackUrl }) {
    await sendNotes(client, device, [stateNote(STATE_VALUES.PING)], { callbackUrl });
  },
};
