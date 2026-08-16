// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike an integration with a fixed catalog, the devices here are the ones the
// user declared in their configuration: this module turns that list into Gladys
// devices, and routes what comes back — a command, a poll, a radio frame — to
// the right module.
//
// Each device module lives in its own file and exposes the same shape:
//   - key                          : the "type" half of the external ids
//   - types                        : the airsend.cloud type numbers it handles
//   - buildDevice(gladys, device)  : the discovery payload (null = not exposed)
//   - onSetValue(gladys, {...})      (optional): run a user command
//   - onPoll(gladys, {...})          (optional): periodic read
//   - applyReadings(gladys, {...})   (optional): publish decoded radio notes
//   - restoreStates(gladys, {...})   (optional): resume from the states Gladys kept
//   - identify(gladys, {...})        (optional): make the device signal itself
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { gateway } from './gateway.js';
import { sensor } from './sensor.js';
import { button } from './button.js';
import { switchDevice } from './switchDevice.js';
import { shutter } from './shutter.js';
import { light } from './light.js';
import { decodeNotes, describeReadings, isSameChannel } from '../devmel/notes.js';
import { heardChannels } from '../devmel/heard.js';
import { idsFor } from './helpers.js';

const logger = createLogger({ name: 'devices' });

export const DEVICE_BLUEPRINTS = [gateway, sensor, button, switchDevice, shutter, light];

/** The module handling an airsend.cloud device type. */
export function findBlueprintByType(rtype) {
  return DEVICE_BLUEPRINTS.find((blueprint) => blueprint.types.includes(rtype));
}

/** Build the discovery payload for Gladys (every configured device). */
export function buildDiscoveredDevices(gladys, config) {
  const devices = [];
  for (const device of config.devmelDevices) {
    const blueprint = findBlueprintByType(device.rtype);
    if (!blueprint) {
      continue;
    }
    const payload = blueprint.buildDevice(gladys, device);
    if (payload) {
      devices.push(payload);
    }
  }
  return devices;
}

/**
 * Find the Devmel device and the module owning a Gladys external id (used to
 * route onSetValue / onPoll / identify).
 *
 * @returns {{ device: object, blueprint: object } | null}
 */
export function findDeviceByExternalId(gladys, config, externalId) {
  for (const device of config.devmelDevices) {
    const blueprint = findBlueprintByType(device.rtype);
    if (blueprint && idsFor(gladys, blueprint.key, device).device === externalId) {
      return { device, blueprint };
    }
  }
  return null;
}

/**
 * Let the modules that track something over time pick it back up from what
 * Gladys already knows. A shutter position is computed from the travel of the
 * motor (see src/devmel/travel.js): without this, restarting the integration
 * would forget where every shutter is and only a full open or close would tell
 * it again.
 *
 * @param {Array<object>} gladysDevices the devices of `gladys.getDevices()`,
 *   whose features carry the last value Gladys stored
 * @returns {Promise<number>} how many devices were restored
 */
export async function restoreDeviceStates(gladys, config, gladysDevices) {
  if (!Array.isArray(gladysDevices)) {
    return 0;
  }
  let restored = 0;
  for (const device of config.devmelDevices) {
    const blueprint = findBlueprintByType(device.rtype);
    if (!blueprint || typeof blueprint.restoreStates !== 'function') {
      continue;
    }
    const externalId = idsFor(gladys, blueprint.key, device).device;
    const known = gladysDevices.find((candidate) => candidate?.external_id === externalId);
    if (!known) {
      continue;
    }
    try {
      await blueprint.restoreStates(gladys, { device, features: known.features ?? [] });
      restored += 1;
    } catch (err) {
      logger.error(`Could not restore the states of "${device.name}"`, err);
    }
  }
  return restored;
}

/** Drop every timer the device modules hold (integration shutdown). */
export function stopDeviceTracking() {
  shutter.travel.clear();
}

/**
 * Build the `publishTransports` payload: whether the local box actually
 * carried the last exchange of each device.
 *
 * Devices never contacted yet report the channel they WOULD use, so the badge
 * is meaningful before the first command instead of empty.
 */
export function buildTransportEntries(gladys, config, client) {
  const entries = [];
  for (const device of config.devmelDevices) {
    const blueprint = findBlueprintByType(device.rtype);
    if (!blueprint || !blueprint.buildDevice(gladys, device)) {
      continue;
    }
    const known = client.transportOf(device);
    const entry = known ?? { transport: expectedTransport(client, device) };
    entries.push({ external_id: idsFor(gladys, blueprint.key, device).device, ...entry });
  }
  return entries;
}

function expectedTransport(client, device) {
  return client.canUseLocal(device) ? 'local' : 'unreachable';
}

/**
 * Handler of the `identify` manifest action: make the chosen device signal
 * itself. `externalId` comes from the action's dynamic select
 * (`"source": "devices"`), filled by Gladys with the integration's own devices.
 */
export async function identifyDevice(gladys, externalId, context) {
  const found = findDeviceByExternalId(gladys, context.config, externalId);
  if (!found || typeof found.blueprint.identify !== 'function') {
    return {
      en: 'This device cannot signal itself.',
      fr: 'Cet appareil ne peut pas se signaler.',
    };
  }
  await found.blueprint.identify(gladys, { ...context, device: found.device });
  return {
    en: `A PING was sent to "${found.device.name}".`,
    fr: `Un PING a été envoyé à « ${found.device.name} ».`,
  };
}

/**
 * Publish the states carried by the radio events the box pushed to the webhook.
 *
 * An event is routed by its channel: every device sharing that channel gets the
 * readings, which is what makes a Gladys device follow the physical remote used
 * on the wall.
 *
 * Every usable frame is also remembered (see src/devmel/heard.js), whether a
 * device claimed it or not: that registry is what the "attach a remote" action
 * turns into a configuration line.
 *
 * @param {object} [registry] where the frames are remembered, injectable so the
 *   tests do not share the registry of the running integration
 * @returns {Promise<number>} how many devices acted on a frame
 */
export async function applyEvents(gladys, config, events, registry = heardChannels) {
  if (!Array.isArray(events)) {
    return 0;
  }
  let applied = 0;
  for (const event of events) {
    const unusable = whyUnusable(event);
    if (unusable) {
      // Never an info line — the air is full of half-decoded frames, and one
      // per press of a neighbour's gate remote is noise. But someone hunting
      // for a remote that never shows up needs to see that something WAS
      // heard, and where it stopped: hence the channel, and the reason.
      logger.debug(`Ignored a radio frame (${unusable}): ${describeChannel(event?.channel)}`);
      continue;
    }

    const readings = decodeNotes(event.thingnotes?.notes);

    // Who the frame belongs to comes BEFORE what it says. An emitter nobody
    // declared is the one thing the user has to be told about, and telling
    // them must not depend on the notes decoding into something we know —
    // an unknown remote is precisely where an unknown note type turns up, and
    // a rolling-code protocol the service only partially decodes carries no
    // usable note at all.
    const listeners = config.devmelDevices.filter((device) => hearsChannel(device, event.channel));
    const heard = registry.record(event.channel, {
      readings,
      claimed: listeners.length > 0,
      timestamp: event.timestamp,
    });
    if (listeners.length === 0) {
      // Worth saying out loud: this is what the wall remote of an equipment
      // already in the list looks like — same protocol, its own address — and
      // the pair below is exactly what `remotes` takes to attach it.
      logger.info(
        `Heard a frame on a channel no device declares: ${describeChannel(event.channel)}` +
          `${readings.length === 0 ? ' (no note the service could decode)' : ''}` +
          '. Add it to the "remotes" of the device it drives to follow it, or run the ' +
          '"Attach a remote" action, which writes that line for you.',
      );
      continue;
    }

    if (readings.length === 0) {
      // The box heard the emitter and named it, but the decoder turned nothing
      // into a command. That is what a partially decoded protocol looks like
      // (`getDecoder: 0` in the channel table): the frame proves the radio
      // works, it just says nothing Gladys can publish.
      //
      // Said out loud the FIRST time such an emitter is heard, because this is
      // the shape of "I attached my wall remote and nothing moves": the frame
      // reaches its device, the device publishes nothing, and until now nothing
      // said so above debug level. Every frame after that goes back to debug —
      // a remote pressed twice a day must not fill the logs with a fact the
      // user has already been told.
      const line =
        `Heard ${describeChannel(event.channel)} for ${names(listeners)}, but no note the ` +
        'service could decode: this protocol is only partially decoded (a rolling-code 868 MHz ' +
        'remote, typically), so its frames prove the radio works and carry no order to replay. ' +
        'Nothing to publish.';
      if (isFirstFrame(heard)) {
        logger.info(line);
      } else {
        logger.debug(line);
      }
      continue;
    }
    const createdAt = toDate(event.timestamp);
    for (const device of listeners) {
      const blueprint = findBlueprintByType(device.rtype);
      if (!blueprint || typeof blueprint.applyReadings !== 'function') {
        // A push-only device type (a plain BUTTON) has nothing to publish when
        // it hears itself: normal, and not worth an info line.
        logger.debug(
          `Heard ${describeChannel(event.channel)} for "${device.name}", a device type that ` +
            'publishes nothing on radio frames',
        );
        continue;
      }
      try {
        const handled = await blueprint.applyReadings(gladys, { device, readings, createdAt });
        if (Number(handled) > 0) {
          if (heard) {
            heard.understood = true;
          }
          applied += 1;
          continue;
        }
        // The frame reached its device and moved nothing. Silence here is the
        // worst answer of all: it looks exactly like a remote that was never
        // attached, and the user has just attached it. So say what the frame
        // decoded to — that is what tells "wrong device declared" apart from
        // "this protocol carries no order Gladys can replay".
        logger.info(
          `Heard ${describeChannel(event.channel)} for "${device.name}", but it says nothing ` +
            `this device can follow: ${describeReadings(readings)}. A rolling-code 868 MHz ` +
            'remote (Profalux, Somfy io) is only partially decoded: its frames prove the radio ' +
            'works, they carry no order to replay.',
        );
      } catch (err) {
        logger.error(`Could not publish the states of "${device.name}"`, err);
      }
    }
  }
  return applied;
}

/**
 * Is this the first frame the registry ever saw from that emitter? What is
 * worth an info line once is noise on every repeat. An unremembered frame (no
 * registry entry) counts as a first one: silence is the worse mistake.
 */
function isFirstFrame(heard) {
  return !heard || Number(heard.frames) <= 1;
}

/** The devices a frame was routed to, quoted as the user named them. */
function names(devices) {
  return devices.map((device) => `"${device.name}"`).join(', ');
}

/** An AirSend channel as the configuration spells it: the `pid`/`addr` pair. */
function describeChannel(channel) {
  const pid = `pid ${channel?.id ?? 'unknown'}`;
  return channel?.source === undefined ? pid : `${pid}, addr ${channel.source}`;
}

/**
 * Does a frame heard on `channel` belong to this device? Its own channel is the
 * obvious one; the emitters declared in `remotes` are the wall remote, the
 * keyfob or the second AirSend driving the same equipment from another address.
 */
export function hearsChannel(device, channel) {
  if (isSameChannel(channel, device.channel)) {
    return true;
  }
  return (device.remotes ?? []).some((remote) => isSameChannel(channel, remote));
}

/**
 * Radio is noisy: the box grades every frame it decodes, and only the reliable
 * ones are worth publishing. Error events (type >= 0x100) are dropped too.
 *
 * Carrying no note is deliberately NOT a reason: a well-graded frame the
 * decoder could not turn into a command still names its emitter, and that is
 * the only thing a partially decoded protocol (a rolling-code 868 MHz remote,
 * typically) ever gives away. Dropping it here made such a remote look exactly
 * like a box that hears nothing — see `applyEvents`.
 *
 * @returns {?string} why the frame goes no further, null when it is usable —
 *   a reason rather than a boolean, because a frame dropped in silence is
 *   indistinguishable from a remote nobody pressed.
 */
function whyUnusable(event) {
  if (!event || typeof event !== 'object' || !event.channel) {
    return 'no channel';
  }
  if (Number(event.type ?? 0) >= 0x100) {
    return `error event, type ${event.type}`;
  }
  if (event.reliability === undefined) {
    return null;
  }
  const reliability = Number(event.reliability);
  if (!(reliability > 0x6 && reliability < 0x47)) {
    return `unreliable, graded ${event.reliability}`;
  }
  return null;
}

function toDate(timestampMs) {
  const timestamp = Number(timestampMs);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}
