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

const gladys = new GladysIntegration();
const client = new AirSendClient();

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

// What the last binding attempt did, so the "Test the connection" action can
// say whether the box is actually forwarding anything.
const listenState = { url: null, error: null };

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
    callbackUrl: eventsWebhookUrl,
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
    callbackUrl: eventsWebhookUrl,
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
  return testConnection(client, config, service, listenState);
});

// The `identify` action targets ONE device chosen by the user: its manifest
// field declares `"source": "devices"` (SDK v0.7+), so the Configuration screen
// fills the select with the integration's own devices.
gladys.onAction('identify', async (fields) => {
  logger.info(`Action identify <- ${fields.device}`);
  return identifyDevice(gladys, fields.device, {
    config,
    client,
    callbackUrl: eventsWebhookUrl,
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
});

/**
 * Apply a configuration and (re)build everything that depends on it: the
 * devices, their transport badge, the radio listener and the status shown in
 * the Configuration screen.
 */
async function initialize(rawConfig) {
  config = normalizeConfig(rawConfig);

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

  // Application-level status, shown in the Configuration screen: distinct from
  // the container state machine, an integration can be RUNNING and still unable
  // to reach the box.
  const status = await describeConnection(client, config, service);
  await gladys.setConnectionStatus(status.connected, status.message);
}

/**
 * Where the AirSend Web Service must post the frames it hears.
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
 * Ask every configured box to forward the frames it hears on the listening
 * channel. Renewed periodically: a box that reboots forgets its subscriptions.
 */
async function startListening() {
  stopListening();
  const callbackUrl = radioCallbackUrl();
  listenState.url = null;
  listenState.error = null;
  if (!callbackUrl || config.listen_channel <= 0) {
    logger.info(
      config.listen_channel <= 0
        ? 'Listening disabled (listening channel set to 0)'
        : 'No route for the radio frames -> sensors are refreshed by polling only',
    );
    return;
  }
  await bindBoxes(callbackUrl);
  listenTimer = setInterval(() => {
    bindBoxes(radioCallbackUrl()).catch((err) =>
      logger.error('Could not renew the radio listener', err),
    );
  }, LISTEN_REFRESH_MS);
  // Do not hold the event loop open just to renew a subscription.
  listenTimer.unref?.();
}

async function bindBoxes(callbackUrl) {
  if (!callbackUrl) {
    return;
  }
  for (const box of boxDevices(config)) {
    try {
      await client.bind(config.listen_channel, callbackUrl, box);
      listenState.url = callbackUrl;
      listenState.error = null;
      logger.info(
        `Listening on channel ${config.listen_channel} through "${box.name}" -> ${callbackUrl}`,
      );
    } catch (err) {
      if (!listenState.url) {
        listenState.error = err.message;
      }
      logger.warn(`Could not listen through "${box.name}": ${err.message}`);
    }
  }
}

function stopListening() {
  if (listenTimer) {
    clearInterval(listenTimer);
    listenTimer = null;
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
