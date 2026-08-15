// -----------------------------------------------------------------------------
// Which protocol the box must listen to.
//
// `POST /airsend/bind` takes a channel, and it is easy to read that channel as
// "the device I want to hear". It is not: the box has one radio, and binding
// switches it to permanent reception OF ONE PROTOCOL — the same thing Devmel's
// own plugins call "écoute permanente", a single choice per box.
//
// Which protocol? The one the equipment speaks, decoded by the channel the
// AirSend Web Service says decodes it (`GET /channels/`, see
// `AirSendClient.listChannels`). Each entry of that table carries a
// `getDecoder`, and the three cases it spells out are the three sections of the
// Jeedom menu:
//
//   getDecoder === id    the protocol decodes itself   -> listen to it
//   getDecoder === 1     it is part of generic 433 MHz -> listen to channel 1
//   getDecoder === 0     only partially decoded        -> listen to it anyway
//
// So a shutter on protocol 25455 is heard by listening to whatever decodes
// 25455 — which is channel 1 only if the table says so. Listening to 1 because
// it is "the generic one" hears nothing at all for every other protocol, and a
// box that hears nothing looks exactly like a remote nobody pressed.
//
// Hence: deduce the channel from the devices the user declared, and keep the
// configuration field for the cases the table cannot know about (a remote whose
// equipment is not in the list yet).
// -----------------------------------------------------------------------------

import { DEVICE_TYPES, GENERIC_433_CHANNEL } from '../config.js';

/**
 * Index the `GET /channels/` answer by channel id.
 *
 * @param {Array<object>} channels
 * @returns {Map<number, object>}
 */
export function indexChannels(channels) {
  const table = new Map();
  for (const channel of channels ?? []) {
    const id = Number(channel?.id);
    if (Number.isFinite(id)) {
      table.set(id, channel);
    }
  }
  return table;
}

/**
 * The channel that decodes a protocol: itself, unless the table names another
 * one. An unknown protocol decodes itself — the honest guess, and the one that
 * lets listening work before (or without) the channel table.
 */
export function decoderOf(channelId, table) {
  const id = Number(channelId);
  const decoder = Number(table?.get(id)?.getDecoder);
  return Number.isFinite(decoder) && decoder > 0 ? decoder : id;
}

/** Name of a channel, as the AirSend Web Service spells it. */
export function channelName(channelId, table) {
  const name = table?.get(Number(channelId))?.name;
  return name ? String(name) : null;
}

/**
 * What to bind, and what it will let Gladys hear.
 *
 * @param {object} config normalized configuration
 * @param {Map<number, object>} [table] channel table, empty when the service
 *   could not be asked — the deduction then falls back to the protocol of the
 *   devices themselves
 * @returns {{
 *   enabled: boolean, channel: ?number, name: ?string, deduced: boolean,
 *   fallback: boolean, covered: Array<object>, uncovered: Array<object>
 * }}
 */
export function planListening(config, table = new Map()) {
  const devices = listenableDevices(config);

  if (config.listen_channel === 0) {
    return {
      enabled: false,
      channel: null,
      name: null,
      deduced: false,
      fallback: false,
      covered: [],
      uncovered: [],
    };
  }

  const deduced = config.listen_channel === null || config.listen_channel === undefined;
  const channel = deduced ? deduceChannel(devices, table) : config.listen_channel;

  const covered = [];
  const uncovered = [];
  for (const device of devices) {
    (hears(channel, device, table) ? covered : uncovered).push(device);
  }

  return {
    enabled: true,
    channel,
    name: channelName(channel, table),
    deduced,
    // Nothing was declared to deduce from, so channel 1 is a default rather
    // than a deduction — and it is the 433 MHz decoder, deaf to every 868 MHz
    // protocol. Worth telling apart: a box listening to a default nobody chose
    // is silent for exactly the same reason as a box listening to the wrong
    // protocol, and neither looks any different from a remote nobody presses.
    fallback: deduced && devices.length === 0,
    covered,
    uncovered,
  };
}

/** Devices whose frames listening could bring back: everything on the air. */
function listenableDevices(config) {
  return (config.devmelDevices ?? []).filter(
    (device) => device.rtype !== DEVICE_TYPES.BOX && Number(device.channel?.id) > 0,
  );
}

/**
 * The protocol shared by the most declared devices — one radio, one protocol,
 * so the majority is the best a single bind can do. Ties are settled by the
 * lowest channel, which keeps the choice stable across restarts, and a
 * configuration with no radio device at all falls back to generic 433 MHz: it
 * is the only useful thing to listen to before anything is declared.
 */
function deduceChannel(devices, table) {
  const counts = new Map();
  for (const device of devices) {
    for (const channel of channelsOf(device)) {
      const decoder = decoderOf(channel.id, table);
      counts.set(decoder, (counts.get(decoder) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return GENERIC_433_CHANNEL;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/** Is this device (or one of its remotes) heard on that channel? */
function hears(channel, device, table) {
  return channelsOf(device).some((own) => decoderOf(own.id, table) === Number(channel));
}

/** Every channel a device can be heard on: its own, and its other remotes. */
function channelsOf(device) {
  return [device.channel, ...(device.remotes ?? [])].filter((channel) => Number(channel?.id) > 0);
}
