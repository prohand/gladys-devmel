// -----------------------------------------------------------------------------
// AirSend driver: the only module that talks to Devmel hardware.
//
// A Devmel device is reachable through two independent channels, and the
// integration declares both in its manifest (`"transports": ["local","cloud"]`):
//
//   - LOCAL — the AirSend Web Service (the `airsend` Home Assistant add-on, the
//     Jeedom daemon, or the same binary run standalone in Docker) exposes an
//     HTTP API on port 33863. `POST /airsend/transfer` sends radio notes,
//     `POST /airsend/bind` subscribes to incoming ones. It authenticates with
//     the `sp://` connection string exported from airsend.cloud.
//
//   - CLOUD — `GET https://airsend.cloud/device/<id>/<action>/<value>/`
//     authenticated with the account API key. Commands only: the cloud path
//     cannot read sensors, and knows nothing about raw radio channels.
//
// The user's "Prefer the local connection" toggle (the reserved
// `GLADYS_PREFER_LOCAL` config key) decides which one is tried first; the other
// one is the fallback. Every call reports which channel actually carried it, so
// Gladys can show the per-device transport badge.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { NOTE_METHODS, NOTE_TYPES, toCloudCommand, clampLevel } from './notes.js';

const logger = createLogger({ name: 'airsend' });

const CLOUD_BASE_URL = 'https://airsend.cloud';
const USER_AGENT = 'gladys-devmel';
const LOCAL_TIMEOUT_MS = 8000;
const CLOUD_TIMEOUT_MS = 10000;

/** Thrown when a request reached the box/cloud but was refused. */
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

  get serviceUrl() {
    const raw = this.config?.service_url?.trim();
    if (!raw) {
      return null;
    }
    return raw.endsWith('/') ? raw : `${raw}/`;
  }

  /** Local connection string of a device, falling back to the global one. */
  spurlOf(device) {
    return device?.spurl || this.config?.spurl || null;
  }

  /** Cloud API key of a device, falling back to the global one. */
  apiKeyOf(device) {
    return device?.apiKey || this.config?.api_key || null;
  }

  canUseLocal(device) {
    return Boolean(this.serviceUrl && this.spurlOf(device));
  }

  canUseCloud(device) {
    return Boolean(this.apiKeyOf(device) && device?.id);
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
   * @returns {Promise<{ transport: string, notes: Array<object>, degraded: boolean,
   *   message?: string }>}
   */
  async transfer(device, notes, options = {}) {
    const preferLocal = this.config?.GLADYS_PREFER_LOCAL !== false;
    const local = () => this.transferLocal(device, notes, options);
    const cloud = () => this.transferCloud(device, notes);

    const primary = preferLocal
      ? { name: DEVICE_TRANSPORTS.LOCAL, usable: this.canUseLocal(device), run: local }
      : { name: DEVICE_TRANSPORTS.CLOUD, usable: this.canUseCloud(device), run: cloud };
    const fallback = preferLocal
      ? { name: DEVICE_TRANSPORTS.CLOUD, usable: this.canUseCloud(device), run: cloud }
      : { name: DEVICE_TRANSPORTS.LOCAL, usable: this.canUseLocal(device), run: local };

    if (!primary.usable && !fallback.usable) {
      this.rememberTransport(device, DEVICE_TRANSPORTS.UNREACHABLE);
      throw new AirSendError(`No transport configured for "${device.name}"`, {
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }

    let firstError = null;
    if (primary.usable) {
      try {
        const result = await primary.run();
        this.rememberTransport(device, primary.name);
        return { transport: primary.name, degraded: false, notes: result.notes ?? [] };
      } catch (err) {
        firstError = err;
        logger.warn(`${primary.name} transfer failed for "${device.name}": ${err.message}`);
      }
    }

    if (fallback.usable) {
      try {
        const result = await fallback.run();
        // "It works, but not in the nominal mode": the user asked for the other
        // channel and we had to reroute. Gladys renders this as an orange dot.
        const degraded = primary.usable;
        const message = degraded ? fallbackMessage(primary.name, firstError) : undefined;
        this.rememberTransport(device, fallback.name, degraded, message);
        return { transport: fallback.name, degraded, message, notes: result.notes ?? [] };
      } catch (err) {
        logger.error(`${fallback.name} transfer failed for "${device.name}": ${err.message}`);
        firstError = firstError ?? err;
      }
    }

    this.rememberTransport(device, DEVICE_TRANSPORTS.UNREACHABLE);
    throw (
      firstError ??
      new AirSendError(`"${device.name}" is unreachable`, {
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      })
    );
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
   * Send a command through airsend.cloud. Only STATE and LEVEL writes have a
   * cloud equivalent — reads and raw radio notes are local-only.
   */
  async transferCloud(device, notes) {
    const [note] = notes;
    const action = toCloudAction(note);
    if (!action) {
      throw new AirSendError('This note has no airsend.cloud equivalent', {
        transport: DEVICE_TRANSPORTS.CLOUD,
      });
    }

    const url = `${CLOUD_BASE_URL}/device/${device.id}/${action.action}/${action.value}/`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKeyOf(device)}`,
        'content-type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      throw new AirSendError(`airsend.cloud answered HTTP ${response.status}`, {
        status: response.status,
        transport: DEVICE_TRANSPORTS.CLOUD,
      });
    }
    return { notes: [] };
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

  rememberTransport(device, transport, degraded = false, message = undefined) {
    this.transports.set(device.platformId, { transport, degraded, message });
  }

  /** Last known transport of a device, or `undefined` if never contacted. */
  transportOf(device) {
    return this.transports.get(device.platformId);
  }
}

function fallbackMessage(preferredTransport, error) {
  const reason = error?.message ?? 'unreachable';
  return preferredTransport === DEVICE_TRANSPORTS.LOCAL
    ? {
        en: `Local AirSend box unreachable (${reason}), fell back to airsend.cloud.`,
        fr: `Boîtier AirSend local injoignable (${reason}), repli sur airsend.cloud.`,
      }
    : {
        en: `airsend.cloud unreachable (${reason}), fell back to the local box.`,
        fr: `airsend.cloud injoignable (${reason}), repli sur le boîtier local.`,
      };
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

function toCloudAction(note) {
  if (!note || note.method !== NOTE_METHODS.SET) {
    return null;
  }
  if (note.type === NOTE_TYPES.LEVEL) {
    return { action: 'level', value: clampLevel(note.value) };
  }
  if (note.type === NOTE_TYPES.STATE) {
    const value = toCloudCommand(note.value);
    return value === undefined ? null : { action: 'command', value };
  }
  return null;
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
