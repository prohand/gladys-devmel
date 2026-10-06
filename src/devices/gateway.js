// -----------------------------------------------------------------------------
// Device type: AIRSEND BOX (airsend.cloud type 0)
//
// The gateway itself, not something it controls. It carries a temperature and a
// light sensor, read by polling: unlike the radio devices around it, the box
// answers immediately, so the read is done with `wait: true` and the values
// come back inline.
//
// A box declared without `sensors: true` exposes no feature: it stays in the
// configuration (it holds the connection string and the listening channel) but
// no device is created in Gladys.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createLogger } from '../logging.js';
import { DEVICE_TYPES, gladysPollFrequency } from '../config.js';
import {
  decodeNotes,
  queryNote,
  QUERY_TYPES,
  READINGS,
  stateNote,
  STATE_VALUES,
} from '../devmel/notes.js';
import { idsFor, publishState, sendNotes } from './helpers.js';

const KEY = 'gateway';

const logger = createLogger({ name: KEY });

// Last successful read of each box (platform id -> ms), to honour a `refresh`
// longer than the one-minute Gladys tick.
const lastReadAt = new Map();

/** Forget the read times (tests, configuration change). */
export function resetGatewayReads() {
  lastReadAt.clear();
}

const FEATURE = {
  TEMPERATURE: 'temperature',
  ILLUMINANCE: 'illuminance',
};

export const gateway = {
  key: KEY,
  types: [DEVICE_TYPES.BOX],

  buildDevice(gladys, device) {
    if (!device.sensors) {
      // Nothing to expose: the box is only used as a radio interface.
      return null;
    }
    const ids = idsFor(gladys, KEY, device);
    return {
      name: device.name,
      external_id: ids.device,
      // `refresh` is in seconds: Gladys wants one of its own ticks, in
      // milliseconds (anything else rejects the whole discovery and empties
      // the Discovery tab), and only polls a device carrying `should_poll`.
      should_poll: true,
      poll_frequency: gladysPollFrequency(device.refresh),
      features: [
        {
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
        },
        {
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
        },
      ],
    };
  },

  async onPoll(gladys, { device, client, now = Date.now() }) {
    if (!device.sensors) {
      return;
    }
    // Skip the Gladys ticks inside the configured interval, with half a tick
    // of tolerance (the core's clock lands a few milliseconds short).
    const last = lastReadAt.get(device.platformId);
    const tolerance = gladysPollFrequency(device.refresh) / 2;
    if (last !== undefined && now - last < device.refresh * 1000 - tolerance) {
      return;
    }
    lastReadAt.set(device.platformId, now);
    const readings = [];
    for (const type of [QUERY_TYPES.TEMPERATURE, QUERY_TYPES.ILLUMINANCE]) {
      try {
        const answer = await sendNotes(client, device, [queryNote(type)], { wait: true });
        readings.push(...decodeNotes(answer.notes));
      } catch (err) {
        logger.warn(`Could not read ${type} on "${device.name}": ${err.message}`);
      }
    }
    await gateway.applyReadings(gladys, { device, readings });
  },

  /**
   * Publish the readings of a poll answer or of a pushed radio event.
   *
   * @returns {Promise<number>} how many readings the box published.
   */
  async applyReadings(gladys, { device, readings, createdAt }) {
    const ids = idsFor(gladys, KEY, device);
    let handled = 0;
    for (const reading of readings) {
      if (reading.kind === READINGS.TEMPERATURE) {
        await publishState(gladys, ids.feature(FEATURE.TEMPERATURE), reading.value, createdAt);
      } else if (reading.kind === READINGS.ILLUMINANCE) {
        await publishState(gladys, ids.feature(FEATURE.ILLUMINANCE), reading.value, createdAt);
      } else {
        continue;
      }
      handled += 1;
    }
    return handled;
  },

  /** The box answers a PING, which makes its status LED blink. */
  async identify(_gladys, { device, client }) {
    await sendNotes(client, device, [stateNote(STATE_VALUES.PING)], { wait: true });
  },
};
