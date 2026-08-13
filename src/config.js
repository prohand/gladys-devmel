// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills it in Gladys from the `config_schema` of
// `gladys-assistant-integration.json`; the SDK fetches it (`gladys.getConfig()`)
// and notifies every change (`gladys.onConfigUpdated()`).
//
// The interesting part is the `devices` field: rather than asking the user to
// retype what they already declared in the AirSend app, the integration eats
// the very file airsend.cloud exports (Import/Export → Export JSON), pasted as
// is — one line included, which is what the single-line field allows.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { SERVICE_URL as EMBEDDED_SERVICE_URL } from './devmel/service.js';

const logger = createLogger({ name: 'config' });

export { EMBEDDED_SERVICE_URL };

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  use_embedded_service: true, // run the bundled AirSend Web Service ourselves
  service_url: '', // an AirSend Web Service elsewhere, e.g. http://192.168.1.50:33863/
  spurl: '', // sp://password@[fe80::…]?gw=0&rhost=192.168.1.50
  devices: '', // JSON exported from airsend.cloud
  listen_channel: 1, // radio channel the box forwards to Gladys (0 = disabled)
  poll_frequency: 300, // seconds between two sensor reads
};

/** AirSend device types, as numbered by airsend.cloud. */
export const DEVICE_TYPES = {
  BOX: 0,
  SENSOR: 1,
  BUTTON: 4096,
  SWITCH: 4097,
  SHUTTER: 4098,
  SHUTTER_POSITION: 4099,
  LIGHT: 4100,
};

/**
 * Merge the user config with the defaults and parse the device list.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    // Force the types: config may arrive as strings from a form.
    service_url: String(raw.service_url ?? DEFAULT_CONFIG.service_url).trim(),
    spurl: String(raw.spurl ?? DEFAULT_CONFIG.spurl).trim(),
    listen_channel: Number(raw.listen_channel ?? DEFAULT_CONFIG.listen_channel),
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    use_embedded_service: raw.use_embedded_service !== false,
  };

  // Who serves the local channel. A URL typed by the user wins: someone who
  // already runs the service (the Home Assistant add-on, the Jeedom daemon)
  // points at it and we start nothing. Otherwise the bundled one is started
  // inside our own container and answers on the loopback address.
  config.embeddedService = config.use_embedded_service && !config.service_url;
  config.effectiveServiceUrl =
    config.service_url || (config.embeddedService ? EMBEDDED_SERVICE_URL : '');

  config.devmelDevices = parseDevices(raw.devices, config);
  return config;
}

/**
 * Parse the device list pasted by the user.
 *
 * Accepted shapes, all of them straight out of airsend.cloud or written by
 * hand:
 *   { "devices": [ { "name": …, "type": 4098, "pid": …, "addr": … } ] }  (the export)
 *   [ { "name": "Living room shutter", "type": 4098, … } ]               (a plain list)
 *   { "devices": { "Living room shutter": { "type": 4098, … } } }        (keyed by name)
 *   { "Living room shutter": { … } }                                     (without the wrapper)
 *
 * @returns {Array<object>} normalized devices, invalid entries dropped
 */
export function parseDevices(source, config = DEFAULT_CONFIG) {
  const parsed = parseDeviceSource(source);
  if (!parsed) {
    return [];
  }

  const entries = parsed.devices ?? parsed;
  const list = Array.isArray(entries)
    ? entries.map((entry) => [entry?.name, entry])
    : Object.entries(entries);

  const devices = [];
  const seen = new Set();
  for (const [name, entry] of list) {
    const device = normalizeDevice(name, entry, config);
    if (!device) {
      continue;
    }
    if (seen.has(device.platformId)) {
      logger.warn(`Ignoring "${device.name}": another device already uses this id/channel`);
      continue;
    }
    seen.add(device.platformId);
    devices.push(device);
  }
  return devices;
}

function parseDeviceSource(source) {
  if (!source) {
    return null;
  }
  if (typeof source === 'object') {
    return source;
  }
  const text = String(source).trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      logger.error('The device list must be a JSON object or a JSON array');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error(`Could not parse the device list: ${err.message}`);
    return null;
  }
}

function normalizeDevice(name, entry, config) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const deviceName = String(entry.name ?? name ?? '').trim();
  const rtype = Number(entry.type);
  if (!deviceName) {
    logger.warn('Ignoring a device without a name');
    return null;
  }
  if (!Object.values(DEVICE_TYPES).includes(rtype)) {
    logger.warn(`Ignoring "${deviceName}": unsupported device type "${entry.type}"`);
    return null;
  }

  const channel = normalizeChannel(entry, rtype);
  const spurl = firstString(entry.spurl);
  const localIp = firstString(entry.localip, entry.localIp, entry.local_ip);

  if (!channel) {
    logger.warn(
      `Ignoring "${deviceName}": no radio channel (channel.id, or the pid/addr pair of the ` +
        'export)',
    );
    return null;
  }

  const device = {
    name: deviceName,
    rtype,
    channel,
    // Link-local address of the box this device belongs to, as exported by
    // airsend.cloud. Informative: the box is reached through the sp:// URL.
    localIp,
    spurl,
    // Wait for the radio confirmation before answering. Off by default: most
    // 433 MHz devices are write-only and never acknowledge.
    wait: toBoolean(entry.wait, false),
    // Some covers are wired the other way round (sun sails, screens).
    invert: toBoolean(entry.invert, false),
    // How long a full travel takes, in seconds. This is what makes the position
    // of a one-way shutter computable (see src/devmel/travel.js); a single
    // `travel` serves both directions when the motor is symmetrical.
    travelUp: toPositiveNumber(firstNumber(entry.travel_up, entry.travelUp, entry.travel), null),
    travelDown: toPositiveNumber(
      firstNumber(entry.travel_down, entry.travelDown, entry.travel),
      null,
    ),
    // Where the shutter goes when its own "favourite position" order is used
    // (the Somfy "my" button): the hardware knows it, the radio does not say it.
    favoritePosition: toPercentage(firstNumber(entry.favorite_position, entry.favoritePosition)),
    // The AirSend box carries a temperature and a light sensor.
    sensors: toBoolean(entry.sensors, false),
    refresh: toPositiveNumber(entry.refresh, config.poll_frequency),
    features: normalizeFeatures(entry.features),
  };
  device.platformId = buildPlatformId(device);
  return device;
}

/**
 * Where a radio channel field is read from, in order of preference.
 *
 * The airsend.cloud export flattens the channel into the device itself, under
 * other names:
 *
 *   {"devices":[{"name":"Baie vitree","localip":"fe80::…","type":4098,
 *                "pid":25455,"addr":8295}]}
 *
 * `pid` is what the box calls the channel id — the protocol, shared by every
 * device driven the same way — and `addr` the address of the emitter, i.e.
 * `channel.source`. A hand-written list may nest them under `channel:` instead;
 * both spellings describe the same pair.
 */
const CHANNEL_FIELDS = {
  // `id` is deliberately absent from the flat names: at the top level of a
  // device it is the airsend.cloud device id, never the channel.
  id: { nested: ['id'], flat: ['pid', 'channelId', 'channel_id'] },
  source: { nested: ['source'], flat: ['source', 'addr', 'address'] },
  mac: { nested: ['mac'], flat: ['mac'] },
  seed: { nested: ['seed'], flat: ['seed'] },
};

function normalizeChannel(entry, rtype) {
  // The box itself always answers on channel 1.
  if (rtype === DEVICE_TYPES.BOX) {
    return { id: 1 };
  }
  const nested = entry.channel && typeof entry.channel === 'object' ? entry.channel : {};
  const normalized = {};
  for (const [field, names] of Object.entries(CHANNEL_FIELDS)) {
    // A nested `channel` wins over the flat aliases: an export carrying both
    // says the same thing twice, and a hand-written list says what it means.
    const value = firstNumber(
      ...names.nested.map((name) => nested[name]),
      ...names.flat.map((name) => entry[name]),
    );
    if (value !== null) {
      normalized[field] = value;
    }
  }
  return normalized.id === undefined ? null : normalized;
}

/** First value of the list that is a usable number, or null. */
function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return null;
}

/** First value of the list that is a non-empty string, or null. */
function firstString(...values) {
  for (const value of values) {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (text) {
      return text;
    }
  }
  return null;
}

/**
 * Build the stable, unique id of a device on the Devmel side — what
 * `gladys.externalIds(type, platformId)` needs: the radio channel, or (for a
 * box, which shares channel 1 with every other box) its address.
 */
function buildPlatformId(device) {
  if (device.rtype === DEVICE_TYPES.BOX) {
    return slug(hostFromSpurl(device.spurl) ?? device.localIp ?? device.name);
  }
  const parts = [device.channel.id];
  for (const field of ['source', 'mac', 'seed']) {
    if (device.channel[field] !== undefined) {
      parts.push(device.channel[field]);
    }
  }
  return slug(parts.join('-'));
}

/** Extract the box address from a `sp://…@[fe80::…]?…&rhost=192.168.1.50` URL. */
export function hostFromSpurl(spurl) {
  if (!spurl) {
    return null;
  }
  const rhost = /rhost=([^&\s]+)/.exec(spurl);
  if (rhost) {
    return rhost[1];
  }
  const address = /@\[?([^\]/?]+)\]?/.exec(spurl);
  return address ? address[1] : null;
}

/** Readings a generic radio sensor (type 1) exposes in Gladys. */
export const SENSOR_FEATURES = ['temperature', 'humidity', 'illuminance', 'click'];

function normalizeFeatures(features) {
  if (!features) {
    return ['click'];
  }
  const list = (Array.isArray(features) ? features : String(features).split(','))
    .map((feature) => String(feature).trim().toLowerCase())
    .filter((feature) => SENSOR_FEATURES.includes(feature));
  return list.length > 0 ? list : ['click'];
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** A 0-100 percentage, or null when the user did not give one. */
function toPercentage(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
