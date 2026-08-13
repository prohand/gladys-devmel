// -----------------------------------------------------------------------------
// AirSend driver: the only module that talks to Devmel hardware.
//
// Everything goes through the LOCAL channel, the one the manifest declares
// (`"transports": ["local"]`): the AirSend Web Service exposes an HTTP API on
// port 33863. The integration ships it and runs it in its own container by
// default (see service.js), and can just as well use one running elsewhere on
// the LAN. `POST /airsend/transfer` sends radio notes,
// `POST /airsend/bind` subscribes to incoming ones. It authenticates with the
// `sp://` connection string exported from airsend.cloud.
//
// Every call reports the channel that carried it, so Gladys can show the
// per-device transport badge: 'local' when the box answered, 'unreachable'
// when there is nothing to talk to.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'airsend' });

const USER_AGENT = 'gladys-devmel';
const LOCAL_TIMEOUT_MS = 8000;

/** Thrown when a request reached the box but was refused. */
export class AirSendError extends Error {
  constructor(message, { status, transport } = {}) {
    super(message);
    this.name = 'AirSendError';
    this.status = status;
    this.transport = transport;
  }
}

export class AirSendClient {
  constructor() {
    /** @type {import('../config.js').DevmelConfig | null} */
    this.config = null;
    /** Last known transport per device platform id, for the Gladys badge. */
    this.transports = new Map();
  }

  /** Apply a new configuration (called on connection and on every config update). */
  configure(config) {
    this.config = config;
  }

  /**
   * Where the AirSend Web Service answers: the URL the user typed, or the
   * loopback address of the one we run ourselves (see src/devmel/service.js).
   */
  get serviceUrl() {
    const raw = this.config?.effectiveServiceUrl?.trim();
    if (!raw) {
      return null;
    }
    return raw.endsWith('/') ? raw : `${raw}/`;
  }

  /** Local connection string of a device, falling back to the global one. */
  spurlOf(device) {
    return device?.spurl || this.config?.spurl || null;
  }

  canUseLocal(device) {
    return Boolean(this.serviceUrl && this.spurlOf(device));
  }

  /**
   * Send notes to a device.
   *
   * @param {object} device normalized Devmel device (see src/config.js)
   * @param {Array<object>} notes notes to transfer
   * @param {object} [options]
   * @param {string} [options.uid] stable id echoed back in asynchronous events
   * @param {boolean} [options.wait] wait for the radio confirmation (reads do)
   * @param {string} [options.callbackUrl] where the box pushes the answer when
   *   `wait` is false
   * @returns {Promise<{ transport: string, notes: Array<object>, degraded: boolean }>}
   */
  async transfer(device, notes, options = {}) {
    if (!this.canUseLocal(device)) {
      this.rememberTransport(device, DEVICE_TRANSPORTS.UNREACHABLE);
      throw new AirSendError(`No transport configured for "${device.name}"`, {
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }

    try {
      const result = await this.transferLocal(device, notes, options);
      this.rememberTransport(device, DEVICE_TRANSPORTS.LOCAL);
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: false, notes: result.notes ?? [] };
    } catch (err) {
      logger.warn(`Local transfer failed for "${device.name}": ${err.message}`);
      this.rememberTransport(device, DEVICE_TRANSPORTS.UNREACHABLE);
      throw err;
    }
  }

  /** Send notes through the local AirSend Web Service. */
  async transferLocal(device, notes, { uid, wait = false, callbackUrl } = {}) {
    const body = {
      wait,
      channel: device.channel,
      thingnotes: { uid: toThingUid(uid ?? device.platformId), notes },
    };
    if (!wait) {
      // Fire-and-forget: the box needs somewhere to drop the answer. When no
      // public callback is available (no Gladys Plus relay), the loopback
      // address is the documented way to say "discard it".
      body.callback = callbackUrl || 'http://127.0.0.1/';
    }

    const response = await this.localRequest('airsend/transfer', body, device);
    const payload = await readJson(response);

    if (response.status !== 200) {
      throw new AirSendError(localErrorMessage(response.status), {
        status: response.status,
        transport: DEVICE_TRANSPORTS.LOCAL,
      });
    }
    // With `wait: true` the box answers with the radio event itself: an event
    // type >= 0x100 is an error (no answer, collision, unknown channel...).
    if (wait && payload && Number(payload.type ?? 0) >= 0x100) {
      throw new AirSendError(`No radio confirmation (event type ${payload.type})`, {
        transport: DEVICE_TRANSPORTS.LOCAL,
      });
    }
    return { notes: payload?.thingnotes?.notes ?? [] };
  }

  /**
   * Ask the box to forward every radio frame it hears on a channel to
   * `callbackUrl` (the Gladys Plus webhook URL). `duration: 0` means "until
   * further notice"; the subscription is renewed periodically because the box
   * forgets it when it restarts.
   */
  async bind(channelId, callbackUrl, device = {}) {
    if (!this.canUseLocal(device)) {
      throw new AirSendError('Listening requires the local AirSend Web Service', {
        transport: DEVICE_TRANSPORTS.LOCAL,
      });
    }
    const response = await this.localRequest(
      'airsend/bind',
      { channel: { id: Number(channelId) }, duration: 0, callback: callbackUrl },
      device,
    );
    if (response.status !== 200) {
      throw new AirSendError(localErrorMessage(response.status), {
        status: response.status,
        transport: DEVICE_TRANSPORTS.LOCAL,
      });
    }
    return true;
  }

  /** Check that the AirSend Web Service answers (used by the manifest action). */
  async pingLocal() {
    const url = this.serviceUrl;
    if (!url) {
      throw new AirSendError('No AirSend Web Service URL configured');
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
    // The service answers 401/404 on the root path: anything but a 5xx proves
    // it is alive and reachable.
    if (response.status >= 500) {
      throw new AirSendError(`AirSend Web Service answered HTTP ${response.status}`, {
        status: response.status,
        transport: DEVICE_TRANSPORTS.LOCAL,
      });
    }
    return true;
  }

  async localRequest(path, body, device) {
    return fetch(`${this.serviceUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.spurlOf(device)}`,
        'content-type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
  }

  rememberTransport(device, transport) {
    this.transports.set(device.platformId, { transport, degraded: false });
  }

  /** Last known transport of a device, or `undefined` if never contacted. */
  transportOf(device) {
    return this.transports.get(device.platformId);
  }
}

function localErrorMessage(status) {
  switch (status) {
    case 401:
      return 'Invalid connection string (HTTP 401): check the sp:// URL';
    case 405:
      return 'Invalid input (HTTP 405): check the channel of this device';
    case 500:
      return 'The box got no radio confirmation (HTTP 500)';
    default:
      return `AirSend Web Service answered HTTP ${status}`;
  }
}

/**
 * The `uid` an AirSend transfer carries is echoed back in the asynchronous
 * event, which is how a caller recognizes its own answer. The add-on hashes the
 * caller-side identifier; we do the same with the Gladys external id.
 */
export function toThingUid(source) {
  return `0x${createHash('sha256').update(String(source), 'utf8').digest('hex').slice(0, 12)}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
