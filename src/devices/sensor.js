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

  async applyReadings(gladys, { device, readings, createdAt }) {
    const ids = idsFor(gladys, KEY, device);
    const declared = new Set(device.features);
    for (const reading of readings) {
      const feature = FEATURE_BY_READING[reading.kind];
      if (!feature || !declared.has(feature)) {
        continue;
      }
      const value = feature === FEATURE.CLICK ? CLICK_TOGGLE : reading.value;
      await publishState(gladys, ids.feature(feature), value, createdAt);
    }
  },
};

const FEATURE_BY_READING = {
  [READINGS.TEMPERATURE]: FEATURE.TEMPERATURE,
  [READINGS.HUMIDITY]: FEATURE.HUMIDITY,
  [READINGS.ILLUMINANCE]: FEATURE.ILLUMINANCE,
  // A remote press reaches us either as a TOGGLE note or as the ON/OFF level
  // of a two-button remote: both are a click.
  [READINGS.TOGGLE]: FEATURE.CLICK,
  [READINGS.LEVEL]: FEATURE.CLICK,
};
