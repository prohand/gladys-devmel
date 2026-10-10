// -----------------------------------------------------------------------------
// Device type: RADIO SENSOR (airsend.cloud type 1)
//
// The push side of the integration: weather sensors and original remotes that
// talk but never listen. Nothing is ever sent to them — their frames arrive
// through the box listening channel and are relayed to Gladys, so this module
// only implements `applyReadings`.
//
// A sensor declares what it emits (`features: [temperature, humidity]` in the
// device list); a remote with no declaration exposes a click feature, which is
// what a bare radio remote is: a trigger for scenes.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES } from '../config.js';
import { READINGS } from '../devmel/notes.js';
import { ordersOf, PRESS_WINDOW_MS } from '../capabilities/scenes.js';
import { idsFor, publishState } from './helpers.js';

const KEY = 'sensor';

const FEATURE = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  ILLUMINANCE: 'illuminance',
  CLICK: 'click',
};

// "Toggle", in the Gladys click catalog: the only order a radio remote sends.
const CLICK_TOGGLE = 52;

/**
 * When each remote last clicked, per order (`platformId:order` -> ms).
 *
 * A press is several frames — the remote repeats itself for as long as the
 * button is held — and a click published per frame ran a scene "on click,
 * toggle the lamp" two or three times per press: back where it started. Same
 * window, same rule as the `remote_pressed` trigger (see scenes.js).
 */
const lastClicks = new Map();

/** Forget the clicks heard (tests). */
export function resetSensorClicks() {
  lastClicks.clear();
}

export const sensor = {
  key: KEY,
  types: [DEVICE_TYPES.SENSOR],

  buildDevice(gladys, device) {
    const ids = idsFor(gladys, KEY, device);
    const builders = {
      temperature: () => ({
        name: 'Temperature',
        external_id: ids.feature(FEATURE.TEMPERATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -50,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      }),
      humidity: () => ({
        name: 'Humidity',
        external_id: ids.feature(FEATURE.HUMIDITY),
        category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      }),
      illuminance: () => ({
        name: 'Illuminance',
        external_id: ids.feature(FEATURE.ILLUMINANCE),
        category: DEVICE_FEATURE_CATEGORIES.LIGHT_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        unit: DEVICE_FEATURE_UNITS.LUX,
        min: 0,
        max: 100000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      }),
      click: () => ({
        name: 'Click',
        external_id: ids.feature(FEATURE.CLICK),
        category: DEVICE_FEATURE_CATEGORIES.BUTTON,
        type: DEVICE_FEATURE_TYPES.BUTTON.CLICK,
        min: 0,
        max: 104,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      }),
    };

    return {
      name: device.name,
      external_id: ids.device,
      features: device.features.map((feature) => builders[feature]()),
    };
  },

  /**
   * Publish what a frame said. `now` is the clock the presses are dated with,
   * injectable for the tests.
   *
   * @returns {Promise<number>} how many readings this sensor acted on — a
   *   repeated frame of a press already clicked counts: it was understood.
   */
  async applyReadings(gladys, { device, readings, createdAt, now = Date.now() }) {
    const ids = idsFor(gladys, KEY, device);
    const declared = new Set(device.features);
    let handled = 0;
    for (const reading of readings) {
      const feature = FEATURE_BY_READING[reading.kind];
      if (!feature || !declared.has(feature)) {
        continue;
      }
      handled += 1;
      if (feature === FEATURE.CLICK) {
        if (isSamePress(device, reading, now)) {
          continue;
        }
        await publishState(gladys, ids.feature(feature), CLICK_TOGGLE, createdAt);
        continue;
      }
      await publishState(gladys, ids.feature(feature), reading.value, createdAt);
    }
    return handled;
  },
};

/** Is this frame the same press as a click published a moment ago? */
function isSamePress(device, reading, now) {
  const key = `${device.platformId}:${ordersOf([reading])[0] ?? reading.kind}`;
  const last = lastClicks.get(key);
  if (last !== undefined && now - last < PRESS_WINDOW_MS) {
    return true;
  }
  lastClicks.set(key, now);
  return false;
}

const FEATURE_BY_READING = {
  [READINGS.TEMPERATURE]: FEATURE.TEMPERATURE,
  [READINGS.HUMIDITY]: FEATURE.HUMIDITY,
  [READINGS.ILLUMINANCE]: FEATURE.ILLUMINANCE,
  // A remote press reaches us either as a TOGGLE note or as the ON/OFF level
  // of a two-button remote: both are a click.
  [READINGS.TOGGLE]: FEATURE.CLICK,
  [READINGS.LEVEL]: FEATURE.CLICK,
};
