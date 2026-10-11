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
//   - notCarried(gladys, {...})      (optional): undo an order the box never carried
//   - undeclared(device, readings)   (optional): what the device would publish, if declared
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createLogger } from '../logging.js';
import { gateway } from './gateway.js';
import { sensor } from './sensor.js';
import { button } from './button.js';
import { switchDevice } from './switchDevice.js';
import { shutter } from './shutter.js';
import { light } from './light.js';
import { decodeNotes, describeReadings, isSameChannel } from '../devmel/notes.js';
import { describeEventType, explainFailure, isErrorEvent } from '../devmel/events.js';
import { heardChannels } from '../devmel/heard.js';
import { sentOrders } from '../devmel/orders.js';
import { idsFor } from './helpers.js';
import { DEVICE_TYPES } from '../config.js';
import { eventReason, ordersOf, sceneEvents } from '../capabilities/scenes.js';

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

/**
 * A device the user just created (or updated) in Gladys: publish what the
 * integration already knows about it. Gladys drops the states sent before a
 * device exists, so without this a shutter added after the start showed no
 * position until the next order or the next restart, and a box no sensor value
 * until the end of its `refresh` interval.
 *
 * @param {object} gladysDevice the device Gladys hands to onDeviceCreated /
 *   onDeviceUpdated (its features carry the last values Gladys stored)
 * @param {object} context `{ config, client, callbackUrl }`
 * @returns {Promise<boolean>} whether the device belongs to the configuration
 */
export async function replayDeviceStates(gladys, gladysDevice, context) {
  const found = findDeviceByExternalId(gladys, context.config, gladysDevice?.external_id);
  if (!found) {
    return false;
  }
  if (typeof found.blueprint.replayStates === 'function') {
    await found.blueprint.replayStates(gladys, {
      ...context,
      device: found.device,
      features: gladysDevice.features ?? [],
    });
  }
  return true;
}

/**
 * Settle what the device modules have under way, then drop every timer they
 * hold (integration shutdown): a shutter driven to a position gets its STOP
 * now, and Gladys the position it is left at (see `ShutterTravel.settle`).
 */
export async function stopDeviceTracking() {
  await shutter.travel.settle();
  shutter.travel.clear();
}

/**
 * Milliseconds until a timed shutter has a STOP to send, or null when none is
 * waiting for one (see `ShutterTravel.untilArrival`).
 */
export function stopDueIn() {
  return shutter.travel.untilArrival();
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

/**
 * Gladys takes at most this many transport badges per request (the SDK throws
 * above it, before anything is sent).
 */
const MAX_TRANSPORTS_PER_REQUEST = 100;

/**
 * Publish the transport badge of every device, in as many requests as it
 * takes: a house past a hundred devices sent them all at once, and every
 * (re)connection failed on it.
 */
export async function publishTransportEntries(gladys, config, client) {
  const entries = buildTransportEntries(gladys, config, client);
  for (let start = 0; start < entries.length; start += MAX_TRANSPORTS_PER_REQUEST) {
    await gladys.publishTransports(entries.slice(start, start + MAX_TRANSPORTS_PER_REQUEST));
  }
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
 * Handler of the `set_known_position` scene action: say where a shutter is,
 * without sending it anything. Throws when the device has no position to set —
 * the scene then logs the failure of that one action and carries on.
 *
 * @returns {Promise<number>} the position now known
 */
export async function setKnownPosition(gladys, config, externalId, position) {
  const found = findDeviceByExternalId(gladys, config, externalId);
  if (!found) {
    throw new Error(`No Devmel device ${externalId} in the configuration`);
  }
  if (typeof found.blueprint.setKnownPosition !== 'function') {
    throw new Error(`"${found.device.name}" is not a shutter`);
  }
  const number = Number(position);
  if (position === null || position === undefined || position === '' || !Number.isFinite(number)) {
    throw new Error(`Not a position: ${position}`);
  }
  return found.blueprint.setKnownPosition(gladys, { device: found.device, position: number });
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
 * An order the integration itself sent comes back the very same way (see
 * src/devmel/orders.js) and is handled apart: it was already acted on when it
 * was sent, and reading it again as a fresh order is what sent a shutter being
 * positioned to the top instead of to 40 %.
 *
 * @param {object} [registry] where the frames are remembered, injectable so the
 *   tests do not share the registry of the running integration
 * @param {object} [orders] the orders we sent, same reason
 * @param {object} [scenes] where the scene triggers are fired, same reason
 * @param {object} [client] the AirSend driver, told when a remote gave a device
 *   a newer order than the one it is still repeating (see `client.supersede`)
 * @returns {Promise<number>} how many devices acted on a frame
 */
export async function applyEvents(
  gladys,
  config,
  events,
  registry = heardChannels,
  orders = sentOrders,
  scenes = sceneEvents,
  client = null,
) {
  if (!Array.isArray(events)) {
    return 0;
  }
  let applied = 0;
  for (const event of events) {
    // Ours, coming back? Asked before anything else: an order that failed to
    // go out comes back as an error event, which every test below drops in
    // silence — and it is the one frame that explains a command doing nothing.
    const echo = orders?.match(event);
    if (echo) {
      // Counted, and counted apart: an echo of ours proves the frames have a
      // route back into the integration, which is half of "my remote does not
      // show up" answered before anyone touches a configuration screen.
      registry.received({ own: true });
      applied += await applyOwnEcho(gladys, config, event, echo, { orders, scenes, client });
      continue;
    }

    // Listening turned off (listening channel 0) stops the renewals, but there
    // is no call to end a subscription already made: the box keeps pushing
    // what it hears until it leaves reception. Those frames are what the user
    // asked not to follow any more — a remote still moving shutters while
    // every screen says listening is off. Our own answers above still count.
    if (config.listen_channel === 0) {
      logger.debug(`Listening is off: ignored a frame from ${describeChannel(event?.channel)}`);
      continue;
    }

    const unusable = whyUnusable(event, config);
    registry.received({ dropped: unusable });
    if (unusable) {
      // Remembered all the same when the box named the emitter: a frame graded
      // too low is an emitter heard, and leaving it out of the registry is what
      // made a box drowning in frames report exactly the same "nothing heard"
      // as a box listening to the wrong protocol.
      const dropped = registry.record(event?.channel, {
        dropped: unusable,
        timestamp: event?.timestamp,
      });
      // What it carried, spelled out: it is the whole difference between a
      // frame worth rescuing (it decodes to an order, and "Accept unreliable
      // frames" will let it through) and one that carries nothing to rescue.
      const carried = describeReadings(decodeNotes(event?.thingnotes?.notes));
      const line =
        `Ignored a radio frame (${unusable}): ${describeChannel(event?.channel)}, ` +
        `${carried ? `carrying ${carried}` : 'carrying no note the service could decode'}.`;
      // Said out loud the FIRST time such an emitter turns up, then dropped
      // back to debug: the air is full of half-decoded frames, and one info
      // line per press of a neighbour's gate remote is noise — but a user
      // hunting a remote that never shows up must not have to enable debug
      // logs to learn that something WAS heard.
      if (registry.announce(dropped, 'dropped')) {
        logger.info(`${line} ${adviseOnDropped(event, unusable)}`);
      } else {
        logger.debug(line);
      }
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
      //
      // Once per emitter, like every line here: a remote held down emits a
      // frame every half second, and a log that scrolls is a log nobody reads.
      const line =
        `Heard a frame on a channel no device declares: ${describeChannel(event.channel)}` +
        `${readings.length === 0 ? ' (no note the service could decode)' : ''}` +
        '. Add it to the "remotes" of the device it drives to follow it, or run the ' +
        '"Attach a remote" action, which writes that line for you.';
      if (registry.announce(heard, 'undeclared')) {
        logger.info(line);
      } else {
        logger.debug(line);
      }
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
      if (registry.announce(heard, 'mute')) {
        logger.info(line);
      } else {
        logger.debug(line);
      }
      continue;
    }
    const createdAt = pastDateOf(event.timestamp);
    const pressed = ordersOf(readings);
    for (const device of listeners) {
      // First of all, before anything is published: a repeat of the previous
      // Gladys order may still be waiting its turn on the radio, and once it
      // goes out it undoes what the wall remote just said.
      if (pressed.length > 0) {
        client?.supersede(device);
      }
      // Someone pressed a remote: whatever the device makes of it below, a
      // scene may want to know. A plain BUTTON publishes nothing, and a spare
      // remote attached to one is exactly a scene trigger.
      await firePresses(gladys, scenes, device, pressed, event.channel);
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
          // The one line that says it WORKS, once per emitter and per
          // configuration. Everything else here reports a frame going nowhere,
          // and a user who attached a remote and reads a log full of silence
          // has no way to tell "it is not heard" from "it is heard, followed,
          // and the shutter simply did not move". They are not the same
          // problem, and only this line tells them apart.
          const followed =
            `Heard ${describeChannel(event.channel)} -> "${device.name}" followed it: ` +
            `${describeReadings(readings)}.`;
          if (registry.announce(heard, `followed:${device.platformId}:${shapeOf(readings)}`)) {
            logger.info(followed);
          } else {
            logger.debug(followed);
          }
          continue;
        }
        // The frame reached its device and moved nothing. Silence here is the
        // worst answer of all: it looks exactly like a remote that was never
        // attached, and the user has just attached it. So say what the frame
        // decoded to — that is what tells "wrong device declared" apart from
        // "this protocol carries no order Gladys can replay".
        //
        // And when it decoded fine into readings the device merely does not
        // declare, say that instead: blaming a rolling-code protocol sent the
        // owner of a thermometer pasted without `features` looking for a
        // decoder problem that was a missing word.
        const missing = blueprint.undeclared?.(device, readings) ?? [];
        if (missing.length > 0) {
          if (heard) {
            heard.undeclared = missing;
          }
          const undeclared =
            `Heard ${describeChannel(event.channel)} for "${device.name}": ` +
            `${describeReadings(readings)}, which this device does not declare. Add ` +
            `${missing.map((feature) => `"${feature}"`).join(', ')} to its "features" to ` +
            `publish ${missing.length === 1 ? 'it' : 'them'}.`;
          if (registry.announce(heard, `undeclared:${device.platformId}:${shapeOf(readings)}`)) {
            logger.info(undeclared);
          } else {
            logger.debug(undeclared);
          }
          continue;
        }
        // A frame that did decode to an order (a TOGGLE heard by a switch) is
        // the first case, and blaming partial decoding sent the user after the
        // wrong fix.
        const unfollowed =
          `Heard ${describeChannel(event.channel)} for "${device.name}", but it says nothing ` +
          `this device can follow: ${describeReadings(readings)}. ` +
          (pressed.length > 0
            ? 'That order was decoded, and this device type does nothing with it: check the ' +
              'type declared on airsend.cloud (a remote sending TOGGLE drives a Button, type ' +
              '4096), or that the right remote is attached.'
            : 'A rolling-code 868 MHz remote (Profalux, Somfy io) is only partially decoded: ' +
              'its frames prove the radio works, they carry no order to replay.');
        if (registry.announce(heard, `unfollowed:${device.platformId}:${shapeOf(readings)}`)) {
          logger.info(unfollowed);
        } else {
          logger.debug(unfollowed);
        }
      } catch (err) {
        logger.error(`Could not publish the states of "${device.name}"`, err);
      }
    }
  }
  return applied;
}

/**
 * The echo of an order we sent: what is left of it once the order itself is
 * taken out.
 *
 * The orders it carries are not news — the integration published them, and
 * started the travel of the shutter, at the moment it sent them. That includes
 * the percentage and the ON/OFF it sent, which come back as plain readings: read
 * as a report, the echo of a 4099 sent to 30 % cancelled its travel a second
 * after it set off, and a late one landed over the order given since. What may
 * be news is anything else the frame holds: a device that reports where it
 * actually is answers on this very route, and that reading is worth publishing.
 *
 * Only to the device the order was sent to. Another device that lists that
 * channel in its `remotes` (a group channel driving it with others) never acted
 * on the order: for it, the frame is an order like any other, and dropping it
 * left it showing open while its motor closed.
 *
 * The one echo worth an info line is the one that says the order never made it
 * to the air. Nothing moved, and until now nothing said so: a command that
 * silently fails is exactly the "I have to press Open three times" the user
 * ends up describing.
 *
 * @returns {Promise<number>} how many devices acted on the leftovers
 */
async function applyOwnEcho(gladys, config, event, echo, { orders, scenes, client } = {}) {
  const verdict = orders?.settle?.(echo, event?.type) ?? {
    failed: isErrorEvent(event?.type),
    uncarried: false,
    latest: false,
  };
  if (isErrorEvent(event?.type)) {
    if (!verdict.failed) {
      // One emission refused while another went out, or may still: a repeat
      // that fails changes nothing, the order is on the air.
      logger.debug(
        `One emission of the order sent to "${echo.name}" was not carried, the order is not ` +
          `failed: ${describeEventType(event.type)}`,
      );
      return 0;
    }
    await orderNotCarried(gladys, config, event, echo, verdict, { scenes, client });
    return 0;
  }

  const all = decodeNotes(event?.thingnotes?.notes);
  const said = new Set(
    decodeNotes(orders?.said?.(event?.channel ?? echo.channel) ?? []).map(readingKey),
  );
  const leftovers = all.filter((reading) => !reading.command && !said.has(readingKey(reading)));
  logger.debug(
    `Own order echoed back for "${echo.name}": ${describeChannel(event?.channel)}` +
      `${leftovers.length === 0 ? '' : `, also reporting ${describeReadings(leftovers)}`}`,
  );

  const createdAt = pastDateOf(event.timestamp);
  let applied = 0;
  for (const device of config.devmelDevices.filter((candidate) =>
    hearsChannel(candidate, event.channel),
  )) {
    const own = device.platformId === echo.platformId;
    const readings = own ? leftovers : all;
    const blueprint = findBlueprintByType(device.rtype);
    if (readings.length === 0 || !blueprint || typeof blueprint.applyReadings !== 'function') {
      continue;
    }
    try {
      const handled = await blueprint.applyReadings(gladys, {
        device,
        readings,
        createdAt,
        // Some readings carry no `command` and are orders all the same to the
        // device that hears them (an ON to a shutter): in an echo they are ours.
        echo: own,
      });
      applied += Number(handled) > 0 ? 1 : 0;
    } catch (err) {
      logger.error(`Could not publish the states of "${device.name}"`, err);
    }
  }
  return applied;
}

/**
 * The box said an order failed, every emission of it. Said out loud, fired to
 * the scenes, and — when the box said each time that nothing went out — undone:
 * Gladys was answered when the service took the order (`wait: false`), so the
 * badge, and the travel of a timed shutter with the STOP it would send at the
 * end, still went by an order the motor never heard.
 */
async function orderNotCarried(gladys, config, event, echo, verdict, { scenes, client }) {
  // Named, not numbered. The box says WHERE the order died — refused
  // connection string, link out of step, another client holding the radio —
  // and each of those is a different thing to go and check. A line that
  // called them all "could not transmit" sent every one of them to "Command
  // repeats", which answers none.
  logger.info(
    `The box did not carry the order sent to "${echo.name}". ${explainFailure(event.type)}`,
  );
  const device = config.devmelDevices.find((candidate) => candidate.platformId === echo.platformId);
  const blueprint = device && findBlueprintByType(device.rtype);
  if (!blueprint) {
    return;
  }
  if (scenes) {
    await scenes.orderFailed(gladys, {
      externalId: idsFor(gladys, blueprint.key, device).device,
      name: device.name,
      reason: eventReason(event.type),
      message: explainFailure(event.type),
    });
  }
  // Only the device's last order, and only when nothing can have gone out: a
  // link that dropped mid-exchange (TIMEOUT) may well have moved the motor.
  if (!verdict.uncarried || !verdict.latest) {
    return;
  }
  client?.rememberTransport(device, DEVICE_TRANSPORTS.UNREACHABLE);
  if (typeof blueprint.notCarried === 'function') {
    try {
      await blueprint.notCarried(gladys, { device, since: verdict.since });
    } catch (err) {
      logger.error(`Could not publish the states of "${device.name}"`, err);
    }
  }
}

/** A reading as a key: what an echo says, to compare with what was sent. */
function readingKey(reading) {
  return `${reading.kind}:${reading.command ?? ''}:${reading.switched ? 'switched' : ''}:${reading.value}`;
}

/** Fire the `remote_pressed` trigger for each order a frame gave a device. */
async function firePresses(gladys, scenes, device, pressed, channel) {
  const blueprint = scenes && pressed.length > 0 ? findBlueprintByType(device.rtype) : null;
  if (!blueprint) {
    return;
  }
  const externalId = idsFor(gladys, blueprint.key, device).device;
  for (const order of pressed) {
    await scenes.remotePressed(gladys, { externalId, name: device.name, order, channel });
  }
}

/**
 * What to do about a frame that was dropped on the way in — the part of the
 * line that is worth reading twice.
 *
 * A frame the box graded badly and could not attribute (no address) is not
 * noise from the neighbourhood: it is the box picking up a protocol it is not
 * decoding, which is what listening to the wrong decoder looks like from the
 * inside. The fix is upstream, in the listening channel, and saying so here is
 * cheaper than a debug session.
 */
function adviseOnDropped(event, reason) {
  if (!String(reason).startsWith('unreliable')) {
    return '';
  }
  if (event?.channel?.source === undefined) {
    return (
      `The box picked up protocol ${event?.channel?.id} without decoding it (no address, no ` +
      'grade it trusts). Set the listening channel to that pid so the box listens to its own ' +
      'decoder, and run "Test the connection" to see what it says about it.'
    );
  }
  return (
    'The box is not confident in what it decoded (a remote at the edge of its range, a noisy ' +
    'band). Turn on "Accept unreliable frames" to use it anyway.'
  );
}

/**
 * What a frame said, stripped of its values: `up`, `stop`, `temperature`.
 *
 * Used to throttle the lines above. A remote has several buttons, and each one
 * deserves to be reported once — that is how a user finds out that all three of
 * theirs decode to the same order. A sensor, on the other hand, says the same
 * thing with a different number every five minutes, and keying on the number
 * would turn one line per emitter into one line per reading.
 */
function shapeOf(readings) {
  return readings.map((reading) => reading.command ?? reading.kind).join(',');
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
 *
 * Never the box itself. Its "channel" is the 1 it answers reads on, and its
 * sensors are read inline (`wait: true`), never pushed: what arrives on pid 1
 * with no address is a generic 433 MHz frame from somebody else. Letting the box
 * claim it published a neighbour's thermometer on the box, and hid the frame
 * from "Attach a remote".
 */
export function hearsChannel(device, channel) {
  if (device.rtype === DEVICE_TYPES.BOX) {
    return false;
  }
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
 * The grading window is the one the official Jeedom plugin applies, so a frame
 * Gladys refuses is a frame the reference implementation refuses too. It can be
 * waived, deliberately, with `accept_unreliable`: a remote at the edge of its
 * range is graded badly and still carries the right order, and the user is
 * better placed than we are to decide whether a false trigger now and then
 * costs more than a shutter that ignores half the presses.
 *
 * @returns {?string} why the frame goes no further, null when it is usable —
 *   a reason rather than a boolean, because a frame dropped in silence is
 *   indistinguishable from a remote nobody pressed.
 */
function whyUnusable(event, config = null) {
  if (!event || typeof event !== 'object' || !event.channel) {
    return 'no channel';
  }
  if (isErrorEvent(event.type)) {
    // Never waived: this is not a frame the box heard badly, it is the box
    // reporting that an exchange failed. There is nothing in it to publish.
    return `error event, ${describeEventType(event.type)}`;
  }
  if (event.reliability === undefined) {
    return null;
  }
  const reliability = Number(event.reliability);
  if (!(reliability > 0x6 && reliability < 0x47)) {
    if (config?.accept_unreliable || isDeclaredRemote(event.channel, config)) {
      return null;
    }
    return `unreliable, graded ${event.reliability}`;
  }
  return null;
}

/**
 * Does this frame come from a wall remote the user declared in `remotes`, by
 * its full protocol AND address?
 *
 * The grading window filters the noise of the neighbourhood: half-decoded
 * frames, a neighbour's gate. A frame that decodes to the exact address of a
 * wall remote the user attached is none of those — and dropping it is a press
 * Gladys never hears, a shutter that moved while Gladys shows it where it was.
 * The box grades a remote held a little too close or too long at the very edge
 * of the window (71), and that is the remote on the wall, not noise.
 *
 * Only with an address: a remote declared by its protocol alone would let
 * every badly graded frame of that protocol through.
 */
function isDeclaredRemote(channel, config) {
  if (channel?.source === undefined || channel?.source === null) {
    return false;
  }
  return (config?.devmelDevices ?? []).some((device) =>
    (device.remotes ?? []).some((remote) => isSameChannel(channel, remote)),
  );
}

/**
 * How old a frame must be, by the box timestamp, to be published as a past
 * state rather than as the current one.
 */
const LATE_FRAME_MS = 30 * 1000;

/**
 * The date to publish a frame's readings with: none for a frame heard just
 * now, its box timestamp for one that arrived late.
 *
 * Gladys files a dated state as history and runs no scene trigger on it — only
 * a state published undated is checked against the scenes. Every frame carries
 * a timestamp, and dating them all meant a scene "when the click of the keyfob
 * is pressed" or "when the outdoor temperature drops below 0" never ran. Only
 * a frame relayed well after the fact (Gladys Plus catching up) still keeps
 * its date: it must not pass for the current reading, nor run a scene late.
 */
function pastDateOf(timestampMs, now = Date.now()) {
  const timestamp = Number(timestampMs);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || now - timestamp < LATE_FRAME_MS) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}
