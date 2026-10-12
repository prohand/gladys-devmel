// -----------------------------------------------------------------------------
// Device type: DIMMABLE LIGHT (airsend.cloud type 4100)
//
// Two controllable features on one device: on/off and brightness. Both end up
// as the same radio note — a LEVEL between 0 and 100 % — except the explicit
// switch-off, which the protocol spells as a STATE note so the lamp goes back
// to its own "off" instead of a 0 % dim.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createLogger } from '../logging.js';
import { DEVICE_TYPES } from '../config.js';
import { clampLevel, levelNote, READINGS, stateNote, STATE_VALUES } from '../devmel/notes.js';
import { idsFor, isOn, publishState, sendNotes, ShownStates } from './helpers.js';

const KEY = 'light';

const logger = createLogger({ name: KEY });

const FEATURE = {
  ON_OFF: 'on-off',
  BRIGHTNESS: 'brightness',
};

// Brightness to restore when the light is switched back on, per device.
const lastBrightness = new Map();

// What Gladys shows of each light, to undo an order the box never carried; and
// the brightness to restore that the last order replaced, to undo it as well.
const shown = new ShownStates();
const replacedBrightness = new Map();

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
          min: 0,
          max: 1,
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
      // Written down before the radio carries it. Gladys runs the orders for
      // one lamp side by side and the radio sends them in arrival order: an On
      // that arrived while this level still waited for the air restored the
      // level before it, and sent it right after this one.
      const previous = lastBrightness.get(device.platformId);
      shown.begin(device.platformId);
      if (level > 0) {
        lastBrightness.set(device.platformId, level);
      }
      try {
        await sendNotes(client, device, [levelNote(level)], {
          uid: feature.external_id,
          callbackUrl,
        });
      } catch (err) {
        // Never on the air: the lamp is still at the level before.
        if (level > 0 && lastBrightness.get(device.platformId) === level) {
          if (previous === undefined) {
            lastBrightness.delete(device.platformId);
          } else {
            lastBrightness.set(device.platformId, previous);
          }
        }
        throw err;
      }
      shown.sent(device.platformId, { onOff: level > 0 ? 1 : 0, brightness: level });
      replacedBrightness.set(device.platformId, previous);
      await publishState(gladys, feature.external_id, level);
      await publishState(gladys, ids.feature(FEATURE.ON_OFF), level > 0 ? 1 : 0);
      return;
    }

    const on = isOn(value);
    // Switching on means "go back to the last brightness"; the protocol has no
    // "restore" order, so the level is what turns the lamp on.
    const level = lastBrightness.get(device.platformId) ?? 100;
    logger.info(`"${device.name}" -> ${on ? `ON (${level} %)` : 'OFF'}`);
    shown.begin(device.platformId);
    await sendNotes(client, device, [on ? levelNote(level) : stateNote(STATE_VALUES.OFF)], {
      uid: feature.external_id,
      callbackUrl,
    });
    shown.sent(device.platformId, { onOff: on ? 1 : 0, brightness: on ? level : 0 });
    replacedBrightness.delete(device.platformId);
    await publishState(gladys, feature.external_id, on ? 1 : 0);
    await publishState(gladys, ids.feature(FEATURE.BRIGHTNESS), on ? level : 0);
  },

  /**
   * Pick the brightness to restore back up from the one Gladys kept: held in
   * memory only, it was lost on every restart, and the first On afterwards
   * sent the lamp to 100 %. Only when memory knows nothing — this also runs on
   * every reconnection and every saved configuration, when memory is newer.
   */
  restoreStates(gladys, { device, features }) {
    const ids = idsFor(gladys, KEY, device);
    const stored = features?.find(
      (feature) => feature.external_id === ids.feature(FEATURE.BRIGHTNESS),
    );
    const level = clampLevel(stored?.last_value);
    // And what Gladys shows, so the first order after a restart can be undone
    // too (see `notCarried`).
    const onOff = features?.find((feature) => feature.external_id === ids.feature(FEATURE.ON_OFF));
    if (
      !shown.get(device.platformId) &&
      stored?.last_value !== null &&
      Number.isFinite(Number(stored?.last_value)) &&
      onOff?.last_value !== null &&
      Number.isFinite(Number(onOff?.last_value))
    ) {
      shown.set(device.platformId, {
        onOff: Number(onOff.last_value) > 0 ? 1 : 0,
        brightness: level,
      });
    }
    if (lastBrightness.has(device.platformId)) {
      return;
    }
    // An Off publishes 0 %: a lamp off at the restart has nothing to give back.
    if (level > 0) {
      lastBrightness.set(device.platformId, level);
      logger.debug(`"${device.name}" will switch back on at ${level} %`);
    }
  },

  /**
   * The box said, after Gladys was answered and shown the new state, that the
   * last order never reached the air: Gladys is shown the state from before,
   * and the next On restores the brightness from before.
   *
   * @returns {Promise<boolean>} whether anything was taken back
   */
  async notCarried(gladys, { device }) {
    const before = shown.undo(device.platformId);
    if (!before) {
      return false;
    }
    if (replacedBrightness.has(device.platformId)) {
      const previous = replacedBrightness.get(device.platformId);
      if (previous === undefined) {
        lastBrightness.delete(device.platformId);
      } else {
        lastBrightness.set(device.platformId, previous);
      }
      replacedBrightness.delete(device.platformId);
    }
    logger.info(
      `"${device.name}" did not change: shown ${before.onOff ? `ON (${before.brightness} %)` : 'OFF'} again`,
    );
    const ids = idsFor(gladys, KEY, device);
    await publishState(gladys, ids.feature(FEATURE.BRIGHTNESS), before.brightness);
    await publishState(gladys, ids.feature(FEATURE.ON_OFF), before.onOff);
    return true;
  },

  /**
   * Published at the time they are heard: see `LIVE_STATE` in helpers.js.
   *
   * @returns {Promise<number>} how many readings this light acted on.
   */
  async applyReadings(gladys, { device, readings }) {
    const ids = idsFor(gladys, KEY, device);
    let handled = 0;
    for (const reading of readings) {
      if (reading.kind !== READINGS.LEVEL) {
        continue;
      }
      handled += 1;
      if (reading.switched && reading.value > 0) {
        // A plain ON from a wall remote: a dimmer goes back to the level it
        // had, and the one remembered here is the best guess of it. Taken as
        // 100 %, Gladys showed full brightness and the next On it sent did put
        // the lamp at full brightness.
        const brightness = lastBrightness.get(device.platformId) ?? 100;
        shown.set(device.platformId, { onOff: 1, brightness });
        await publishState(gladys, ids.feature(FEATURE.BRIGHTNESS), brightness);
        await publishState(gladys, ids.feature(FEATURE.ON_OFF), 1);
        continue;
      }
      if (reading.value > 0) {
        lastBrightness.set(device.platformId, reading.value);
      }
      shown.set(device.platformId, { onOff: reading.value > 0 ? 1 : 0, brightness: reading.value });
      await publishState(gladys, ids.feature(FEATURE.BRIGHTNESS), reading.value);
      await publishState(gladys, ids.feature(FEATURE.ON_OFF), reading.value > 0 ? 1 : 0);
    }
    return handled;
  },

  async identify(_gladys, { device, client, callbackUrl }) {
    await sendNotes(client, device, [stateNote(STATE_VALUES.PING)], { callbackUrl });
  },
};
