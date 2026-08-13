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
} from './src/devices/index.js';
import { boxDevices, describeConnection, testConnection } from './src/devmel/connection.js';
import { AirSendService } from './src/devmel/service.js';

const gladys = new GladysIntegration();
const client = new AirSendClient();

// The AirSend Web Service, running in this very container unless the user
// pointed the configuration at one of their own.
const service = new AirSendService();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Public URL of the `events` webhook, relayed by Gladys Plus. It is what the
// AirSend box posts its radio frames to; without Gladys Plus there is no
// public URL, and the integration degrades to polling.
let eventsWebhookUrl = null;

// Re-arms the box listening subscription (it forgets it when it restarts).
let listenTimer = null;
const LISTEN_REFRESH_MS = 10 * 60 * 1000;

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
// The box pushes every frame it hears on the listening channel to the webhook
// relayed by Gladys Plus: a wall remote pressed by hand, a weather sensor
// waking up, the confirmation of an order we sent. `fire_and_forget` mode: the
// box only awaits an acknowledgement, and states are dated with the box
// timestamp because relayed events can arrive out of order.
gladys.onWebhook('events', async (request) => {
  const payload = parseWebhookBody(request);
  if (!payload) {
    return;
  }
  const applied = await applyEvents(gladys, config, payload.events);
  logger.debug(`Webhook: ${payload.events?.length ?? 0} event(s), ${applied} device(s) updated`);
});

// The Gladys Plus link changed: pick up the fresh URL and re-register it at the
// box, or fall back to polling when the relay is gone.
gladys.onWebhookUpdated(async (info) => {
  eventsWebhookUrl = webhookUrlOf(info);
  logger.info(
    eventsWebhookUrl
      ? 'Webhook relay available -> listening to radio frames'
      : 'No webhook relay -> sensors are refreshed by polling only',
  );
  await startListening();
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  logger.info('Action test_connection');
  return testConnection(client, config, service);
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
  // and never throws — a missing local channel is not a reason to give up on
  // airsend.cloud.
  await service.apply(config);

  client.configure(config);
  logger.info(`${config.devmelDevices.length} Devmel device(s) configured`);

  // publishDiscoveredDevices is idempotent (upsert by external_id).
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));

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
 * Ask every configured box to forward the frames it hears on the listening
 * channel. Renewed periodically: a box that reboots forgets its subscriptions.
 */
async function startListening() {
  stopListening();
  if (!eventsWebhookUrl || config.listen_channel <= 0) {
    return;
  }
  await bindBoxes();
  listenTimer = setInterval(() => {
    bindBoxes().catch((err) => logger.error('Could not renew the radio listener', err));
  }, LISTEN_REFRESH_MS);
  // Do not hold the event loop open just to renew a subscription.
  listenTimer.unref?.();
}

async function bindBoxes() {
  for (const box of boxDevices(config)) {
    try {
      await client.bind(config.listen_channel, eventsWebhookUrl, box);
      logger.debug(`Listening on channel ${config.listen_channel} through "${box.name}"`);
    } catch (err) {
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
 * Publish the effective transport of every device ('local' | 'cloud' |
 * 'unreachable'), rendered as a badge in the Gladys UI. An entry can also flag
 * a degraded state (orange dot + reason): local preferred but refused, cloud
 * fallback used.
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
  // The AirSend Web Service daemonizes: nothing would reap it for us.
  await service.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Devmel integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
