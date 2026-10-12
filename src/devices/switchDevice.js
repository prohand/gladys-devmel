// -----------------------------------------------------------------------------
// Device type: SWITCH (airsend.cloud type 4097)
//
// A binary radio actuator: a plug, a relay, a light behind an ON/OFF remote.
// The command is one STATE note (ON / OFF).
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { createLogger } from '../logging.js';
import { DEVICE_TYPES } from '../config.js';
import { READINGS, stateNote, STATE_VALUES } from '../devmel/notes.js';
import { idsFor, isOn, publishState, sendNotes, ShownStates } from './helpers.js';

const KEY = 'switch';

const logger = createLogger({ name: KEY });

const FEATURE = { ON_OFF: 'on-off' };

// What Gladys shows of each switch, to undo an order the box never carried.
const shown = new ShownStates();

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
          min: 0,
          max: 1,
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
    shown.begin(device.platformId);
    await sendNotes(client, device, [stateNote(on ? STATE_VALUES.ON : STATE_VALUES.OFF)], {
      uid: feature.external_id,
      callbackUrl,
    });
    shown.sent(device.platformId, { onOff: on ? 1 : 0 }, feature.external_id);
    await publishState(gladys, feature.external_id, on ? 1 : 0);
  },

  /**
   * Pick the state Gladys kept back up, so the first order after a restart can
   * be undone too (see `notCarried`). Only when memory knows nothing: it is
   * newer.
   */
  restoreStates(gladys, { device, features }) {
    if (shown.get(device.platformId)) {
      return;
    }
    const ids = idsFor(gladys, KEY, device);
    const stored = features?.find((feature) => feature.external_id === ids.feature(FEATURE.ON_OFF));
    if (stored?.last_value !== null && Number.isFinite(Number(stored?.last_value))) {
      shown.set(device.platformId, { onOff: Number(stored.last_value) > 0 ? 1 : 0 });
    }
  },

  /**
   * The box said, after Gladys was answered and shown the new state, that the
   * last order never reached the air: Gladys is shown the state from before.
   *
   * An order given before the last one (`superseded`) only changes what
   * undoing the last one goes back to (see `ShownStates`).
   *
   * @returns {Promise<boolean>} whether anything was taken back
   */
  async notCarried(gladys, { device, uid = null, superseded = false }) {
    if (superseded) {
      shown.supersededNotCarried(device.platformId, uid);
      return false;
    }
    const before = shown.undo(device.platformId, uid);
    if (!before) {
      return false;
    }
    logger.info(`"${device.name}" did not switch: shown ${before.onOff ? 'ON' : 'OFF'} again`);
    await publishState(gladys, idsFor(gladys, KEY, device).feature(FEATURE.ON_OFF), before.onOff);
    return true;
  },

  /**
   * Published at the time they are heard: see `LIVE_STATE` in helpers.js.
   *
   * @returns {Promise<number>} how many readings this switch acted on.
   */
  async applyReadings(gladys, { device, readings }) {
    const ids = idsFor(gladys, KEY, device);
    let handled = 0;
    for (const reading of readings) {
      if (reading.kind === READINGS.LEVEL) {
        shown.set(device.platformId, { onOff: reading.value > 0 ? 1 : 0 });
        await publishState(gladys, ids.feature(FEATURE.ON_OFF), reading.value > 0 ? 1 : 0);
        handled += 1;
      }
    }
    return handled;
  },

  async identify(_gladys, { device, client, callbackUrl }) {
    await sendNotes(client, device, [stateNote(STATE_VALUES.PING)], { callbackUrl });
  },
};
