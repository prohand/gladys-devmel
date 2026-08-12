// -----------------------------------------------------------------------------
// Device type: BUTTON (airsend.cloud type 4096)
//
// A single-order remote: garage door, bell, toggling relay. There is no state
// to read, only an order to replay — the TOGGLE note — so the device exposes a
// push button rather than a switch.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES } from '../config.js';
import { stateNote, STATE_VALUES } from '../devmel/notes.js';
import { idsFor, sendNotes } from './helpers.js';

const KEY = 'button';

const logger = createLogger({ name: KEY });

const FEATURE = { PUSH: 'push' };

export const button = {
  key: KEY,
  types: [DEVICE_TYPES.BUTTON],

  buildDevice(gladys, device) {
    const ids = idsFor(gladys, KEY, device);
    return {
      name: device.name,
      external_id: ids.device,
      features: [
        {
          name: device.name,
          external_id: ids.feature(FEATURE.PUSH),
          category: DEVICE_FEATURE_CATEGORIES.BUTTON,
          type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
          read_only: false,
          has_feedback: false,
          keep_history: false,
        },
      ],
    };
  },

  async onSetValue(_gladys, { device, feature, client, callbackUrl }) {
    logger.info(`"${device.name}" -> TOGGLE`);
    await sendNotes(client, device, [stateNote(STATE_VALUES.TOGGLE)], {
      uid: feature.external_id,
      callbackUrl,
    });
  },

  async identify(_gladys, { device, client, callbackUrl }) {
    await sendNotes(client, device, [stateNote(STATE_VALUES.PING)], { callbackUrl });
  },
};
