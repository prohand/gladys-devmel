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
//   - identify(gladys, {...})        (optional): make the device signal itself
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { gateway } from './gateway.js';
import { sensor } from './sensor.js';
import { button } from './button.js';
import { switchDevice } from './switchDevice.js';
import { shutter } from './shutter.js';
import { light } from './light.js';
import { decodeNotes, isSameChannel } from '../devmel/notes.js';
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
 * Build the `publishTransports` payload: which channel — local box or
 * airsend.cloud — actually carried the last exchange of each device, and
 * whether it was the nominal one.
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
  const preferLocal = client.config?.GLADYS_PREFER_LOCAL !== false;
  const local = client.canUseLocal(device);
  const cloud = client.canUseCloud(device);
  if (preferLocal ? local : cloud) {
    return preferLocal ? 'local' : 'cloud';
  }
  if (preferLocal ? cloud : local) {
    return preferLocal ? 'cloud' : 'local';
  }
  return 'unreachable';
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
 */
export async function applyEvents(gladys, config, events) {
  if (!Array.isArray(events)) {
    return 0;
  }
  let applied = 0;
  for (const event of events) {
    if (!isUsableEvent(event)) {
      continue;
    }
    const readings = decodeNotes(event.thingnotes?.notes);
    if (readings.length === 0) {
      continue;
    }
    const createdAt = toDate(event.timestamp);
    for (const device of config.devmelDevices) {
      if (!isSameChannel(event.channel, device.channel)) {
        continue;
      }
      const blueprint = findBlueprintByType(device.rtype);
      if (!blueprint || typeof blueprint.applyReadings !== 'function') {
        continue;
      }
      try {
        await blueprint.applyReadings(gladys, { device, readings, createdAt });
        applied += 1;
      } catch (err) {
        logger.error(`Could not publish the states of "${device.name}"`, err);
      }
    }
  }
  return applied;
}

/**
 * Radio is noisy: the box grades every frame it decodes, and only the reliable
 * ones are worth publishing. Error events (type >= 0x100) are dropped too.
 */
function isUsableEvent(event) {
  if (!event || typeof event !== 'object' || !event.channel || !event.thingnotes) {
    return false;
  }
  if (Number(event.type ?? 0) >= 0x100) {
    return false;
  }
  if (event.reliability === undefined) {
    return true;
  }
  const reliability = Number(event.reliability);
  return reliability > 0x6 && reliability < 0x47;
}

function toDate(timestampMs) {
  const timestamp = Number(timestampMs);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}
