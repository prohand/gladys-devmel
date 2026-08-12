// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills it in Gladys from the `config_schema` of
// `gladys-assistant-integration.json`; the SDK fetches it (`gladys.getConfig()`)
// and notifies every change (`gladys.onConfigUpdated()`).
//
// The interesting part is the `devices` field: rather than asking the user to
// retype what they already declared in the AirSend app, the integration eats
// the very file airsend.cloud exports (Import/Export → Export YAML). JSON is
// accepted too — it is valid YAML — and the `!secret name` references the
// export contains are resolved against the credentials filled above in the
// same form.
// -----------------------------------------------------------------------------

import { parse as parseYaml } from 'yaml';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'config' });

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  service_url: '', // AirSend Web Service, e.g. http://192.168.1.50:33863/
  spurl: '', // sp://password@[fe80::…]?gw=0&rhost=192.168.1.50
  api_key: '', // airsend.cloud API key (cloud fallback)
  devices: '', // YAML/JSON exported from airsend.cloud
  listen_channel: 1, // radio channel the box forwards to Gladys (0 = disabled)
  poll_frequency: 300, // seconds between two sensor reads
  // Reserved key (NOT in config_schema): because the manifest declares both
  // 'local' and 'cloud' in its `transports` field, Gladys shows a standard
  // "Prefer the local connection" toggle and sends the user's choice here.
  // Read-only for the integration; defaults to true.
  GLADYS_PREFER_LOCAL: true,
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
    api_key: String(raw.api_key ?? DEFAULT_CONFIG.api_key).trim(),
    listen_channel: Number(raw.listen_channel ?? DEFAULT_CONFIG.listen_channel),
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    // The preference is a boolean; anything but an explicit false means true.
    GLADYS_PREFER_LOCAL: raw.GLADYS_PREFER_LOCAL !== false,
  };
  config.devmelDevices = parseDevices(raw.devices, config);
  return config;
}

/**
 * Parse the device list pasted by the user.
 *
 * Accepted shapes, all of them straight out of airsend.cloud or written by
 * hand:
 *   devices: { "Living room shutter": { type: 4098, … } }   (the export)
 *   { "Living room shutter": { … } }                        (without the wrapper)
 *   [ { name: "Living room shutter", type: 4098, … } ]      (a plain list)
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
  const text = String(source);
  if (!text.trim()) {
    return null;
  }
  try {
    // Note: the text is parsed as pasted. Trimming it would dedent the first
    // line only, and YAML refuses a mapping whose keys are not aligned.
    // `!secret spurl` is a Home Assistant tag, meaningless to a YAML parser:
    // turn it into a plain marker resolved by normalizeDevice().
    const parsed = parseYaml(text.replace(/!secret\s+([\w.-]+)/g, '"__secret__:$1"'));
    if (!parsed || typeof parsed !== 'object') {
      logger.error('The device list must be a YAML mapping or a JSON object');
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

  const id = entry.id === undefined || entry.id === null ? null : String(entry.id);
  const channel = normalizeChannel(entry.channel, rtype);
  const spurl = resolveSecret(entry.spurl, config);
  const apiKey = resolveSecret(entry.apiKey ?? entry.api_key, config);

  if (!channel && !id) {
    logger.warn(`Ignoring "${deviceName}": neither a cloud id nor a radio channel`);
    return null;
  }

  const device = {
    name: deviceName,
    rtype,
    id,
    channel,
    spurl,
    apiKey,
    // Wait for the radio confirmation before answering. Off by default: most
    // 433 MHz devices are write-only and never acknowledge.
    wait: toBoolean(entry.wait, false),
    // Some covers are wired the other way round (sun sails, screens).
    invert: toBoolean(entry.invert, false),
    // The AirSend box carries a temperature and a light sensor.
    sensors: toBoolean(entry.sensors, false),
    refresh: toPositiveNumber(entry.refresh, config.poll_frequency),
    features: normalizeFeatures(entry.features),
  };
  device.platformId = buildPlatformId(device);
  return device;
}

function normalizeChannel(channel, rtype) {
  // The box itself always answers on channel 1.
  if (rtype === DEVICE_TYPES.BOX) {
    return { id: 1 };
  }
  if (!channel || typeof channel !== 'object' || channel.id === undefined) {
    return null;
  }
  const normalized = { id: Number(channel.id) };
  for (const field of ['source', 'mac', 'seed']) {
    if (channel[field] !== undefined && channel[field] !== null) {
      normalized[field] = Number(channel[field]);
    }
  }
  return normalized;
}

/**
 * Build the stable, unique id of a device on the Devmel side — what
 * `gladys.externalIds(type, platformId)` needs. Preference order: the cloud id,
 * then the radio channel, then (for a box, which has neither) its address.
 */
function buildPlatformId(device) {
  if (device.id) {
    return slug(device.id);
  }
  if (device.rtype === DEVICE_TYPES.BOX) {
    return slug(hostFromSpurl(device.spurl) ?? device.name);
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

/**
 * Resolve the `!secret name` references of an airsend.cloud export against the
 * credentials the user typed in the configuration form.
 */
function resolveSecret(value, config) {
  if (typeof value !== 'string') {
    return value ? String(value) : null;
  }
  const match = /^__secret__:(.+)$/.exec(value.trim());
  if (!match) {
    return value.trim() || null;
  }
  const name = match[1].toLowerCase();
  if (name.includes('spurl') || name.includes('locator')) {
    return config.spurl || null;
  }
  if (name.includes('key') || name.includes('token')) {
    return config.api_key || null;
  }
  logger.warn(`Unknown secret "${match[1]}", falling back to the global credentials`);
  return null;
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

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
