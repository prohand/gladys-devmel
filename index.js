// -----------------------------------------------------------------------------
// Entry point of the Devmel integration.
//
// Role of this file: wire the SDK to the AirSend driver (src/devmel/) and to the
// device catalog (src/devices/). It holds NO radio logic:
//   1. it instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. it registers the event handlers BEFORE connect();
//   3. it connects, publishes the configured devices and arms the listener.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { applyLogLevel } from './src/logging.js';
import { AirSendClient } from './src/devmel/client.js';
import {
  applyEvents,
  buildDiscoveredDevices,
  buildTransportEntries,
  findDeviceByExternalId,
  identifyDevice,
  restoreDeviceStates,
  stopDeviceTracking,
} from './src/devices/index.js';
import { boxDevices, describeConnection, testConnection } from './src/devmel/connection.js';
import { AirSendService } from './src/devmel/service.js';
import { CallbackServer } from './src/devmel/callback.js';
import { indexChannels, planListening } from './src/devmel/listening.js';
import { heardChannels } from './src/devmel/heard.js';
import { attachHeardRemote } from './src/devmel/remotes.js';
import { findProtocol } from './src/devmel/protocols.js';

const gladys = new GladysIntegration();
const client = new AirSendClient();
// Transmitting takes the box out of reception: every exchange is a reason to
// make sure it is still listening (see `scheduleRebind`).
client.afterTransmit = () => scheduleRebind();

// The AirSend Web Service, running in this very container unless the user
// pointed the configuration at one of their own.
const service = new AirSendService();

// Where that service posts the radio frames it hears: a loopback HTTP server in
// this same container. It is the service — not the box — that calls back, so
// when it runs here, this is both the shortest route and the only one it can
// take (it speaks plain HTTP, and knows nothing of Gladys Plus).
const callbackServer = new CallbackServer();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Public URL of the `events` webhook, relayed by Gladys Plus. It is the only
// way in for frames when the AirSend Web Service runs on ANOTHER machine, which
// cannot reach our loopback.
let eventsWebhookUrl = null;

// URL of the loopback callback above, once it listens.
let localCallbackUrl = null;

// Re-arms the box listening subscription (it forgets it when it restarts).
let listenTimer = null;
const LISTEN_REFRESH_MS = 10 * 60 * 1000;

// And re-arms it shortly after the integration has used the radio itself: a box
// has one radio, so it is not receiving while it transmits, and a subscription
// that did not survive an order is a wall remote nobody hears until the renewal
// above — ten minutes of a Gladys that stopped following the house.
let rebindTimer = null;
const REBIND_AFTER_COMMAND_MS = 2000;

// Keeps the link to the box from going cold. Nothing here is on a schedule: it
// only looks at how long the box has been left alone, which is why it ticks
// much more often than it does anything (see `client.keepWarm`).
let warmTimer = null;
const WARM_CHECK_MS = 60 * 1000;

// The protocol table of the AirSend Web Service, read once per configuration:
// it says which channel decodes which protocol, hence what to bind.
let channelTable = new Map();

// What the last binding attempt did, so the "Test the connection" action can
// say whether the box is actually forwarding anything.
const listenState = { url: null, error: null, plan: null };

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the configured devices');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const found = findDeviceByExternalId(gladys, config, device.external_id);
  if (!found || typeof found.blueprint.onSetValue !== 'function') {
    // Throw: the SDK sends a success:false acknowledgement to Gladys.
    throw new Error(`No command handler for ${device.external_id}`);
  }
  await found.blueprint.onSetValue(gladys, {
    device: found.device,
    feature,
    value,
    client,
    callbackUrl: radioCallbackUrl(),
    config,
  });
  await publishDeviceTransports();
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  const found = findDeviceByExternalId(gladys, config, device.external_id);
  if (!found || typeof found.blueprint.onPoll !== 'function') {
    logger.debug(`onPoll ignored (no polling) for ${device.external_id}`);
    return;
  }
  await found.blueprint.onPoll(gladys, {
    device: found.device,
    client,
    callbackUrl: radioCallbackUrl(),
    config,
  });
  await publishDeviceTransports();
});

// --- Incoming radio frames ---------------------------------------------------
// Every frame the box hears on the listening channel — a wall remote pressed by
// hand, a weather sensor waking up, the confirmation of an order we sent —
// reaches this function, whichever route carried it: the loopback callback
// above, or the `events` webhook relayed by Gladys Plus. States are dated with
// the box timestamp, because relayed events can arrive out of order.
async function handleRadioEvents(events, route) {
  const applied = await applyEvents(gladys, config, events);
  logger.debug(`${route}: ${events?.length ?? 0} event(s), ${applied} device(s) updated`);
}

// `fire_and_forget` mode: the caller only awaits an acknowledgement.
gladys.onWebhook('events', async (request) => {
  const payload = parseWebhookBody(request);
  if (!payload) {
    return;
  }
  await handleRadioEvents(payload.events, 'Webhook');
});

// The Gladys Plus link changed: pick up the fresh URL and re-register it at the
// box. It only changes anything for a service running on another machine — the
// bundled one posts to our loopback, relay or no relay.
gladys.onWebhookUpdated(async (info) => {
  eventsWebhookUrl = webhookUrlOf(info);
  logger.info(eventsWebhookUrl ? 'Webhook relay available' : 'No webhook relay');
  await startListening();
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  logger.info('Action test_connection');
  return testConnection(client, config, service, listenState, heardChannels, await knownChannels());
});

// Turn the last emitter heard that nobody declares into a device list the user
// only has to paste back: the pid/addr pair is in the logs, and copying it into
// JSON by hand is where attaching a wall remote usually goes wrong.
gladys.onAction('attach_remote', async (fields) => {
  logger.info(`Action attach_remote <- ${fields.device}`);
  return attachHeardRemote({
    config,
    device: findDeviceByExternalId(gladys, config, fields.device)?.device,
    heard: heardChannels,
    table: await knownChannels(),
  });
});

// Which pid to put in the "Listening channel" field. A box listens to a
// protocol, not to a band, so hearing an 868 MHz remote means naming its
// protocol — and the only list of those was inside the service until now.
gladys.onAction('find_protocol', async (fields) => {
  logger.info(`Action find_protocol <- ${fields.search ?? ''}`);
  return findProtocol({
    table: await knownChannels(),
    config,
    plan: listenState.plan,
    search: fields.search,
  });
});

// The `identify` action targets ONE device chosen by the user: its manifest
// field declares `"source": "devices"` (SDK v0.7+), so the Configuration screen
// fills the select with the integration's own devices.
gladys.onAction('identify', async (fields) => {
  logger.info(`Action identify <- ${fields.device}`);
  return identifyDevice(gladys, fields.device, {
    config,
    client,
    callbackUrl: radioCallbackUrl(),
  });
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  await initialize(newConfig);
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle under the `gladys-sdk` name: these
// handlers only run the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    await initialize(await gladys.getConfig());
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  stopListening();
  stopKeepingWarm();
});

/**
 * Apply a configuration and (re)build everything that depends on it: the
 * devices, their transport badge, the radio listener and the status shown in
 * the Configuration screen.
 */
async function initialize(rawConfig) {
  config = normalizeConfig(rawConfig);
  // First, so that everything this initialization logs already obeys the level
  // the user just asked for — the frames of a freshly armed listener included.
  applyLogLevel(config);
  // A configuration is changed because something did not work, and the frames
  // that would say whether it works now belong to emitters the logs have
  // already had their say about. Re-arm those once-only lines: the next press
  // of the remote is the one the user is watching for.
  heardChannels.reannounce();
  // The protocol table belongs to the service the configuration points at.
  channelTable = new Map();

  // Before anything talks to the box: bring the local channel up. `apply()`
  // starts the bundled service, stops it when the user switched to their own,
  // and never throws — a service that would not start is reported in the
  // connection status, not by crashing the integration.
  await service.apply(config);

  // The route the frames come back by. Started once, before anything is bound:
  // a subscription is only worth making when there is somewhere to receive it.
  localCallbackUrl = await callbackServer.start((events) =>
    handleRadioEvents(events, 'AirSend callback'),
  );

  client.configure(config);
  logger.info(`${config.devmelDevices.length} Devmel device(s) configured`);

  // publishDiscoveredDevices is idempotent (upsert by external_id).
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));

  // Resume where the last run left off: the position of a shutter is computed
  // from the travel of its motor, so it has to start from the value Gladys
  // kept rather than from "unknown".
  const known = await gladys.getDevices().catch((err) => {
    logger.warn(`Could not read back the states of the devices: ${err.message}`);
    return null;
  });
  const restored = await restoreDeviceStates(gladys, config, known);
  if (restored > 0) {
    logger.info(`${restored} device(s) resumed from their last known state`);
  }

  eventsWebhookUrl = webhookUrlOf(await gladys.getWebhooks().catch(() => null));
  await startListening();

  await publishDeviceTransports();
  startKeepingWarm();

  // Application-level status, shown in the Configuration screen: distinct from
  // the container state machine, an integration can be RUNNING and still unable
  // to reach the box.
  const status = await describeConnection(client, config, service);
  await gladys.setConnectionStatus(status.connected, status.message);
}

/**
 * Where the AirSend Web Service must post what it hears — the frames of a
 * subscription, and the answer to a fire-and-forget transfer, which is the same
 * kind of event arriving by the same route.
 *
 * It calls back from the machine it runs on, and speaks plain HTTP. So when it
 * is the one bundled here, the answer is our own loopback server: no relay, no
 * public URL, and nothing to subscribe to. A service the user runs somewhere
 * else cannot reach that loopback, and only the Gladys Plus relay can carry its
 * frames to us.
 */
function radioCallbackUrl() {
  if (config.embeddedService && localCallbackUrl) {
    return localCallbackUrl;
  }
  return eventsWebhookUrl;
}

/**
 * Ask every configured box to forward the frames it hears. Renewed
 * periodically: a box that reboots forgets its subscriptions.
 *
 * What is bound is a PROTOCOL, deduced from the declared devices unless the
 * user forced one (see src/devmel/listening.js) — a box listening to the wrong
 * protocol is silent, and silence is what "listening does not work" looks like.
 */
async function startListening() {
  stopListening();
  const callbackUrl = radioCallbackUrl();
  listenState.url = null;
  listenState.error = null;
  listenState.plan = planListening(config, await knownChannels());

  if (!listenState.plan.enabled) {
    logger.info('Listening disabled (listening channel set to 0)');
    return;
  }
  if (!callbackUrl) {
    logger.info('No route for the radio frames -> sensors are refreshed by polling only');
    return;
  }
  if (listenState.plan.fallback) {
    // Binding still happens: generic 433 MHz is the only useful guess before
    // anything is declared. But it is a default, and a default that cannot
    // hear an 868 MHz remote at all — which is indistinguishable, from the
    // outside, from a listener that was never armed.
    logger.warn(
      `No radio device declared: listening to generic 433 MHz (channel ${listenState.plan.channel}). ` +
        'An 868 MHz protocol (Profalux, Somfy io) is not heard on it -> declare a device on it, ' +
        'or set the listening channel to its pid.',
    );
  }

  await bindBoxes(callbackUrl);
  announceBlindSpots(listenState.plan);
  listenTimer = setInterval(() => {
    bindBoxes(radioCallbackUrl(), { renewal: true }).catch((err) =>
      logger.error('Could not renew the radio listener', err),
    );
  }, LISTEN_REFRESH_MS);
  // Do not hold the event loop open just to renew a subscription.
  listenTimer.unref?.();
}

/**
 * What the protocol just bound will NOT bring back.
 *
 * The box has one radio and listens to one protocol at a time, so every choice
 * of channel is also a list of things that will never be heard again. Until now
 * that list only existed in the "Test the connection" report — a screen nobody
 * opens while everything looks fine — and its absence is what makes a perfectly
 * armed listener indistinguishable from a broken one.
 */
function announceBlindSpots(plan) {
  if (!plan?.enabled || !listenState.url) {
    return;
  }
  for (const device of plan.uncovered) {
    logger.warn(
      `"${device.name}" speaks protocol ${device.channel?.id}, not the ${plan.channel} the box ` +
        'listens to: nothing it emits will be heard. One radio, one protocol at a time.',
    );
  }
  for (const { device, remote } of plan.unheardRemotes) {
    logger.warn(
      `The remote declared on "${device.name}" (pid ${remote.id}) speaks another protocol than ` +
        `the ${plan.channel} the box listens to: pressing it will do nothing in Gladys. Fill in ` +
        `${remote.id} as the listening channel to hear it instead.`,
    );
  }
  if (plan.echoOnly) {
    // The silence this explains is total: the box is listening, the route works,
    // and nothing will ever come through it — because nothing declared on that
    // protocol ever speaks first.
    logger.info(
      `Nothing declared on channel ${plan.channel} emits by itself: shutters, switches and lamps ` +
        'are talked to, they do not talk. The box will hear the echo of Gladys own orders and ' +
        'nothing else. A wall remote has its own protocol and its own address: press it, then ' +
        'run "Attach a remote" — if nothing turns up, the box is not listening to ITS protocol.',
    );
  }
}

/**
 * The protocol table of the service, or an empty one when it cannot be read: a
 * protocol whose decoder is unknown is then listened to on its own channel,
 * which is what the table says for most of them anyway.
 */
async function knownChannels() {
  if (channelTable.size > 0 || !config.effectiveServiceUrl) {
    return channelTable;
  }
  try {
    channelTable = indexChannels(await client.listChannels());
    logger.debug(`${channelTable.size} radio protocol(s) known by the AirSend Web Service`);
  } catch (err) {
    logger.warn(`Could not read the radio protocols of the AirSend Web Service: ${err.message}`);
  }
  return channelTable;
}

async function bindBoxes(callbackUrl, { renewal = false } = {}) {
  const channel = listenState.plan?.channel;
  if (!callbackUrl || !(channel > 0)) {
    return;
  }
  for (const box of boxDevices(config)) {
    try {
      await client.bind(channel, callbackUrl, box);
      listenState.url = callbackUrl;
      listenState.error = null;
      // A renewal says nothing new: it repeats, every ten minutes and after
      // every order, a line the user already read when listening was armed.
      logger[renewal ? 'debug' : 'info'](
        `Listening on channel ${channel} through "${box.name}" -> ${callbackUrl}`,
      );
    } catch (err) {
      if (!listenState.url) {
        listenState.error = err.message;
      }
      logger.warn(`Could not listen through "${box.name}": ${err.message}`);
    }
  }
}

/**
 * Put the box back into reception after the integration has used the radio.
 *
 * Debounced, and deliberately after the fact: a shutter command is often a
 * short burst (the order, its repeat, the STOP that ends a timed travel), and
 * what has to be armed again is the state the LAST of them left the box in.
 */
function scheduleRebind() {
  if (!listenState.plan?.enabled || !radioCallbackUrl()) {
    return;
  }
  // Pushed back by every transmission, so a burst is followed by ONE bind,
  // after the last of them. Keeping the first schedule instead let the bind
  // land in the middle of the burst — between an order and the STOP that ends
  // a timed travel, or between the two buttons a user presses in a row, where
  // it costs the second order everything the box takes to subscribe.
  if (rebindTimer) {
    clearTimeout(rebindTimer);
  }
  rebindTimer = setTimeout(rebindNow, REBIND_AFTER_COMMAND_MS);
  rebindTimer.unref?.();
}

/** Re-arm the listener, unless the radio has better things to do right now. */
function rebindNow() {
  rebindTimer = null;
  // An order queued behind a subscription is an order the user waits for: the
  // box has one radio, and a bind holds it for as long as it takes. Listening
  // can wait — it has nobody watching a slider.
  if (client.busy) {
    scheduleRebind();
    return;
  }
  bindBoxes(radioCallbackUrl(), { renewal: true }).catch((err) =>
    logger.debug(`Could not re-arm the radio listener after a command: ${err.message}`),
  );
}

function stopListening() {
  if (listenTimer) {
    clearInterval(listenTimer);
    listenTimer = null;
  }
  if (rebindTimer) {
    clearTimeout(rebindTimer);
    rebindTimer = null;
  }
}

/**
 * Keep the link to each box awake.
 *
 * The delay a user notices is almost never the second order — it is the first
 * one after a long quiet evening, which pays for waking a link nothing has used
 * since. Polling already does this for a box declared with `sensors: true`, and
 * renewing the listening subscription does it for a box that listens; a box
 * that only carries the connection string has neither, and is exactly the one
 * left alone for hours.
 *
 * So: nothing periodic against the box, only a periodic LOOK at how long it has
 * been since anything spoke to it. An installation being used stays warm on its
 * own traffic and this never sends a thing.
 */
function startKeepingWarm() {
  stopKeepingWarm();
  if (boxDevices(config).length === 0) {
    return;
  }
  warmTimer = setInterval(() => {
    for (const box of boxDevices(config)) {
      client.keepWarm(box).catch((err) => logger.debug(`Could not warm the link: ${err.message}`));
    }
  }, WARM_CHECK_MS);
  // Never a reason to hold the process open.
  warmTimer.unref?.();
  logger.debug(`Keeping the link to the box warm (after ${client.warmAfter / 60000} min idle)`);
}

function stopKeepingWarm() {
  if (warmTimer) {
    clearInterval(warmTimer);
    warmTimer = null;
  }
}

/**
 * Publish the effective transport of every device ('local' | 'unreachable'),
 * rendered as a badge in the Gladys UI.
 */
async function publishDeviceTransports() {
  const entries = buildTransportEntries(gladys, config, client);
  if (entries.length > 0) {
    await gladys.publishTransports(entries);
  }
}

function webhookUrlOf(info) {
  if (!info?.available) {
    return null;
  }
  return info.webhooks?.find((webhook) => webhook.key === 'events')?.url ?? null;
}

function parseWebhookBody(request) {
  if (!request?.body) {
    return null;
  }
  try {
    return JSON.parse(request.body);
  } catch (err) {
    logger.warn(`Ignoring an unreadable webhook payload: ${err.message}`);
    return null;
  }
}

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopListening();
  stopKeepingWarm();
  stopDeviceTracking();
  await callbackServer.stop();
  // The AirSend Web Service daemonizes: nothing would reap it for us.
  await service.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Devmel integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
