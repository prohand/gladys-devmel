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
  listen_channel: null, // radio protocol to listen to; null = deduced, 0 = disabled
  command_repeat: 1, // extra emissions of an order, the way a remote repeats it
  accept_unreliable: false, // use the frames the box itself grades as doubtful
  poll_frequency: 300, // seconds between two sensor reads
  debug_logs: false, // raise the log level to debug, from the Configuration screen
};

/**
 * The generic 433 MHz decoder. It is a radio channel like any other, and the
 * one the box falls back to when no protocol-specific decoder is known.
 */
export const GENERIC_433_CHANNEL = 1;

/**
 * Ceiling of the repeat settings. Past this the integration is flooding the
 * band rather than making an order more likely to arrive — and the band is
 * shared with every other remote in the house.
 */
export const MAX_COMMAND_REPEAT = 5;

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
    listen_channel: toListenChannel(raw.listen_channel),
    command_repeat: toRepeat(raw.command_repeat, DEFAULT_CONFIG.command_repeat),
    // An emptied number field arrives as '', which `Number()` reads as 0: a
    // refresh interval of zero, and (before `toListenChannel`) a radio listener
    // silently turned off by a field nobody touched.
    poll_frequency: toPositiveNumber(raw.poll_frequency, DEFAULT_CONFIG.poll_frequency),
    use_embedded_service: raw.use_embedded_service !== false,
    accept_unreliable: toBoolean(raw.accept_unreliable, DEFAULT_CONFIG.accept_unreliable),
    debug_logs: toBoolean(raw.debug_logs, DEFAULT_CONFIG.debug_logs),
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
  const parsed = parseDeviceEntries(source);
  if (!parsed) {
    return [];
  }
  const list = parsed.entries;

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

/**
 * The device list as the user wrote it, whichever of the four shapes it takes
 * (see {@link parseDevices}): the parsed root, and its entries paired with the
 * name they are known by.
 *
 * `root` is the object the entries live in, so an edit made to an entry — the
 * `remotes` the "attach a remote" action adds — is an edit to the very list the
 * user pasted, unknown fields and shape included. Rebuilding that list from the
 * normalized devices would quietly drop everything this module does not model.
 *
 * @returns {{root: object, entries: Array<[string, object]>}|null}
 */
export function parseDeviceEntries(source) {
  const root = parseDeviceSource(source);
  if (!root) {
    return null;
  }
  const container = root.devices ?? root;
  const entries = Array.isArray(container)
    ? container.map((entry) => [entry?.name, entry])
    : Object.entries(container);
  return { root, entries };
}

/**
 * The radio channel of a raw entry of that list, read from the flat `pid`/`addr`
 * of the airsend.cloud export as well as from a nested `channel`.
 */
export function channelOfEntry(entry) {
  return entry && typeof entry === 'object' ? normalizeChannel(entry, Number(entry.type)) : null;
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
    // Other emitters that drive the same equipment: the wall remote next to it,
    // a keyfob, a second AirSend. They speak the same protocol from another
    // address, so the box hears them on another channel — and this device is
    // what they act on (see `applyEvents`).
    remotes: normalizeRemotes(firstDefined(entry.remotes, entry.remote), channel),
    // Wait for the radio confirmation before answering. Off by default: most
    // 433 MHz devices are write-only and never acknowledge.
    wait: toBoolean(entry.wait, false),
    // How many extra times an order is sent to THIS device, when the global
    // setting is not what its receiver needs. `null` = follow the global one.
    repeat: toRepeat(firstDefined(entry.repeat, entry.repeats), null),
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

/**
 * The channels of the other emitters declared for a device.
 *
 * The address is what changes from one remote to the next, so the short form is
 * just that — `"remotes": [94311]`, read on the protocol of the device itself,
 * which is what the log of an unclaimed frame prints. A remote on another
 * protocol spells both out: `"remotes": [{ "pid": 1368, "addr": 542 }]`.
 *
 * A protocol on its own — `"remotes": [{ "pid": 14177 }]` — is the last resort,
 * for the frames the box picks up WITHOUT decoding an address (they show up in
 * the logs as a pid and nothing else). It follows exactly those: every
 * unattributed frame of that protocol drives this device, whoever pressed it.
 * Deliberately explicit, because it is the one spelling that can be surprised
 * by a neighbour.
 *
 * @returns {Array<{id: number, source: ?number}>}
 */
function normalizeRemotes(source, channel) {
  if (source === undefined || source === null || source === '') {
    return [];
  }
  const list = Array.isArray(source) ? source : [source];
  const remotes = [];
  for (const entry of list) {
    const flat = typeof entry === 'object' && entry !== null ? entry : { addr: entry };
    const id = firstNumber(flat.pid, flat.id, flat.channelId, flat.channel_id, channel?.id);
    const address = firstNumber(flat.addr, flat.source, flat.address);
    if (id === null) {
      logger.warn(`Ignoring a remote without a protocol: ${JSON.stringify(entry)}`);
      continue;
    }
    if (address === null) {
      // A bare number is an address on the device's own protocol; only an
      // object naming a pid and no address asks for the protocol itself.
      if (typeof entry !== 'object' || entry === null) {
        logger.warn(`Ignoring a remote without an address: ${JSON.stringify(entry)}`);
        continue;
      }
      logger.info(
        `Remote declared on protocol ${id} with no address: this device follows every frame of ` +
          'that protocol the box could not attribute to an emitter.',
      );
      remotes.push({ id, source: undefined });
      continue;
    }
    remotes.push({ id, source: address });
  }
  return remotes;
}

/** First value of the list that is neither undefined nor null. */
function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
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

/**
 * The listening channel, as the user may leave it or fill it.
 *
 * What the box listens to is a *protocol*, not a device: `1` is the generic
 * 433 MHz decoder, and every other value is one of the protocols the AirSend
 * Web Service knows (see src/devmel/listening.js). So:
 *
 *   - `0`            listening off;
 *   - empty, or `1`  deduce it from the device list — `1` is what the field
 *                    defaulted to before it could be deduced, and a deduction
 *                    that finds nothing better falls back to it anyway;
 *   - anything else  that protocol, whatever the device list says.
 *
 * @returns {number|null} the forced channel, 0 to disable, null to deduce
 */
function toListenChannel(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number === GENERIC_433_CHANNEL) {
    return null;
  }
  return number > 0 ? Math.trunc(number) : 0;
}

/**
 * How many EXTRA times an order is sent on the air.
 *
 * Nothing acknowledges a 433 MHz order, so the only defence against a frame
 * lost in the noise is to send it again — which is what a real remote does for
 * as long as the button is held. `0` sends it once and accepts the loss.
 *
 * @returns {number|null} the count, or `fallback` when the field is left empty
 */
function toRepeat(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(MAX_COMMAND_REPEAT, Math.trunc(number)));
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
