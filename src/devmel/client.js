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
import { checkSpurl, MAX_COMMAND_REPEAT } from '../config.js';
import { isRepeatable } from './notes.js';
import { describeEventType, explainFailure, isErrorEvent, isPermanentFailure } from './events.js';
import { sentOrders } from './orders.js';

const logger = createLogger({ name: 'airsend' });

const USER_AGENT = 'gladys-devmel';
const LOCAL_TIMEOUT_MS = 8000;

/**
 * How long the box is left alone between two radio operations.
 *
 * A box has ONE radio: it transmits, or it listens, never both. Two orders
 * fired back to back — a Gladys command while the position slider is still
 * moving, the STOP that ends a timed travel, the renewal of the listening
 * subscription — reach a box still busy with the previous one, and the second
 * is the one that vanishes. So they queue, spaced by this gap.
 */
const RADIO_GAP_MS = 250;

/** How long to wait before sending an order the box could not carry again. */
const RETRY_DELAY_MS = 600;

/** Emissions of one order, retries included, before it is called a failure. */
const ATTEMPTS = 2;

/** Extra emissions of an order when nothing says otherwise. */
const DEFAULT_REPEAT = 1;

/** Thrown when a request reached the box but was refused. */
export class AirSendError extends Error {
  constructor(message, { status, transport, eventType } = {}) {
    super(message);
    this.name = 'AirSendError';
    this.status = status;
    this.transport = transport;
    /** `type` of the AirSend event that reported it, when one did. */
    this.eventType = eventType;
  }
}

export class AirSendClient {
  /**
   * @param {object} [options]
   * @param {(ms: number) => Promise<void>} [options.sleep] injectable so the
   *   tests do not wait for real radio gaps
   * @param {() => number} [options.now] clock, same reason
   * @param {object} [options.orders] registry of the orders sent, so their echo
   *   is recognized when it comes back (see src/devmel/orders.js)
   */
  constructor({ sleep = defaultSleep, now = () => Date.now(), orders = sentOrders } = {}) {
    /** @type {import('../config.js').DevmelConfig | null} */
    this.config = null;
    /** Last known transport per device platform id, for the Gladys badge. */
    this.transports = new Map();
    this.sleep = sleep;
    this.now = now;
    this.orders = orders;
    /** Tail of the radio queue: one operation at a time, in order. */
    this.queue = Promise.resolve();
    /** Radio operations queued or in flight: the box is not free while > 0. */
    this.pending = 0;
    /** Emissions still going out behind an order already answered. */
    this.trailing = Promise.resolve();
    /** When the box last had the radio to itself. */
    this.lastRadioAt = 0;
    /**
     * Called after every exchange that used the radio. The box drops out of
     * reception while it transmits, so the integration re-arms its listening
     * subscription there (see index.js) — otherwise a wall remote pressed after
     * a Gladys command is heard by nobody until the next renewal.
     * @type {(() => void) | null}
     */
    this.afterTransmit = null;
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
   * Radio is one-way and lossy: nothing acknowledges an order, and a frame that
   * arrives while the motor's receiver is busy is simply gone — which is what
   * "I have to press Open twice" is made of. So an order is not sent once and
   * hoped for:
   *
   *   - it waits its turn, because a box busy transmitting hears nothing;
   *   - a transmission the box could not carry is tried again;
   *   - an order that means the same thing twice (UP, STOP, a percentage — see
   *     `isRepeatable`) is repeated, the way a real remote repeats it for as
   *     long as the button is held. A TOGGLE, which does NOT mean the same
   *     thing twice, never is.
   *
   * The caller is answered as soon as the order is ON THE AIR: the repeats keep
   * going behind it, on the same queue and in the same order. They are a second
   * chance for a frame lost in the noise, not part of the answer — and making
   * Gladys wait for them is a second of "the interface takes a moment to react"
   * bought for nothing.
   *
   * @param {object} device normalized Devmel device (see src/config.js)
   * @param {Array<object>} notes notes to transfer
   * @param {object} [options]
   * @param {string} [options.uid] stable id echoed back in asynchronous events
   * @param {boolean} [options.wait] wait for the radio confirmation (reads do)
   * @param {string} [options.callbackUrl] where the box pushes the answer when
   *   `wait` is false
   * @param {number} [options.repeat] extra emissions, overriding the setting
   * @returns {Promise<{ transport: string, notes: Array<object>, degraded: boolean }>}
   */
  async transfer(device, notes, options = {}) {
    if (!this.canUseLocal(device)) {
      this.rememberTransport(device, DEVICE_TRANSPORTS.UNREACHABLE);
      throw new AirSendError(`No transport configured for "${device.name}"`, {
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }

    const repeats = this.repeatsFor(device, notes, options);
    let answer;
    try {
      answer = await this.emit(device, notes, options);
    } catch (err) {
      logger.warn(
        err.eventType === undefined
          ? `Local transfer failed for "${device.name}": ${err.message}`
          : `The box did not carry the order sent to "${device.name}". ${explainFailure(err.eventType)}`,
      );
      this.rememberTransport(device, DEVICE_TRANSPORTS.UNREACHABLE);
      this.notifyTransmit();
      throw err;
    }
    this.rememberTransport(device, DEVICE_TRANSPORTS.LOCAL);
    this.notifyTransmit();
    this.repeat(device, notes, options, repeats);
    return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: false, notes: answer?.notes ?? [] };
  }

  /**
   * Say an order again, behind the answer already given.
   *
   * Queued straight away, so it keeps its place in front of whatever the user
   * does next — the radio order stays the same, only the waiting moved. A
   * repeat that fails is dropped in silence: the order did go out, and failing
   * to say it a second time changes nothing anyone can see.
   */
  repeat(device, notes, options, times) {
    if (times <= 0) {
      return;
    }
    this.trailing = this.trailing.then(async () => {
      for (let emission = 0; emission < times; emission += 1) {
        try {
          await this.emit(device, notes, options);
        } catch (err) {
          logger.debug(`Could not repeat the order sent to "${device.name}": ${err.message}`);
          return;
        }
        this.rememberTransport(device, DEVICE_TRANSPORTS.LOCAL);
        this.notifyTransmit();
      }
    });
  }

  /** Is the box in the middle of something? (An order queued, a repeat going out.) */
  get busy() {
    return this.pending > 0;
  }

  /**
   * Resolves once everything queued has left, repeats included. Nothing in the
   * integration waits for this — a radio order is fire-and-forget by nature —
   * but a test that asserts what went on the air has to know when to look.
   */
  async idle() {
    await this.trailing;
    await this.queue;
  }

  /**
   * One emission, tried again when the box could not carry it. A refusal is not
   * retried: a connection string the box rejects and a channel it does not know
   * are answered exactly the same way the second time.
   */
  async emit(device, notes, options) {
    let failure = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        return await this.radio(() => this.transferLocal(device, notes, options));
      } catch (err) {
        failure = err;
        if (attempt >= ATTEMPTS || !isRetryable(err)) {
          break;
        }
        logger.debug(`Sending the order to "${device.name}" again: ${err.message}`);
        await this.sleep(RETRY_DELAY_MS);
      }
    }
    throw failure;
  }

  /**
   * How many extra times this order is sent. Reads are never repeated (the
   * answer is the point, and it comes back once), and neither is anything whose
   * meaning depends on how often it is heard.
   */
  repeatsFor(device, notes, options = {}) {
    if (options.wait ?? device.wait) {
      return 0;
    }
    if (!isRepeatable(notes)) {
      return 0;
    }
    const wanted = firstNumber(options.repeat, device.repeat, this.config?.command_repeat);
    return Math.max(0, Math.min(MAX_COMMAND_REPEAT, Math.trunc(wanted ?? DEFAULT_REPEAT)));
  }

  /**
   * Run one radio operation, alone and after the box has had its gap. The queue
   * is what makes "the second click did nothing" impossible: orders reach the
   * box one at a time, in the order the user gave them.
   */
  radio(operation) {
    this.pending += 1;
    const run = this.queue.then(async () => {
      try {
        const idle = this.lastRadioAt + RADIO_GAP_MS - this.now();
        if (idle > 0) {
          await this.sleep(idle);
        }
        try {
          return await operation();
        } finally {
          this.lastRadioAt = this.now();
        }
      } finally {
        this.pending -= 1;
      }
    });
    // The tail must stay resolved: a failed operation cannot be allowed to
    // reject every order queued behind it.
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Tell the integration the radio was used (see `afterTransmit`). */
  notifyTransmit() {
    if (typeof this.afterTransmit !== 'function') {
      return;
    }
    try {
      this.afterTransmit();
    } catch (err) {
      logger.debug(`Could not signal the end of a transmission: ${err.message}`);
    }
  }

  /** Send notes through the local AirSend Web Service. */
  async transferLocal(device, notes, { uid, wait = false, callbackUrl } = {}) {
    const thingUid = toThingUid(uid ?? device.platformId);
    // Remembered BEFORE the request: the answer to a fire-and-forget transfer
    // can be pushed to the callback before the HTTP call even returns, and an
    // echo that arrives before it was remembered is an echo replayed as an
    // order (see src/devmel/orders.js).
    this.orders?.remember(thingUid, device);
    const body = {
      wait,
      channel: device.channel,
      thingnotes: { uid: thingUid, notes },
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
      throw new AirSendError(localErrorMessage(response.status, this.spurlOf(device)), {
        status: response.status,
        transport: DEVICE_TRANSPORTS.LOCAL,
      });
    }
    // With `wait: true` the box answers with the radio event itself, and a type
    // >= 0x100 is a failure that names itself (see events.js). Carrying that
    // type on the error is what lets `isRetryable` tell a link that dropped —
    // worth another go — from a connection string the box refuses, which will
    // be refused just as fast the second time.
    if (wait && payload && isErrorEvent(payload.type)) {
      // Short here, explained where it is logged: this message travels back to
      // Gladys as the failure of a command, and a paragraph is not what a user
      // wants in a toast.
      throw new AirSendError(
        `The box did not carry the order: ${describeEventType(payload.type)}`,
        {
          transport: DEVICE_TRANSPORTS.LOCAL,
          eventType: Number(payload.type),
        },
      );
    }
    return { notes: payload?.thingnotes?.notes ?? [] };
  }

  /**
   * The radio protocols the AirSend Web Service knows.
   *
   * `GET /channels/` answers the table Devmel's own plugins read to fill their
   * "permanent listening" menu: one entry per protocol, with its name and — the
   * part that matters here — the channel that DECODES it (`getDecoder`). A box
   * listens to a decoder, not to a device, so this table is what turns "my
   * shutter speaks protocol 25455" into "the box must listen to channel N".
   *
   * It describes the software, not a box: Devmel's plugins read it without any
   * connection string, and so do we.
   *
   * @returns {Promise<Array<{id: number, name?: string, getDecoder?: number}>>}
   */
  async listChannels() {
    const url = this.serviceUrl;
    if (!url) {
      throw new AirSendError('No AirSend Web Service URL configured');
    }
    const response = await fetch(`${url}channels/`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      // Not a radio error: nothing was asked of a box, so the shared messages
      // (a refused connection string, an unknown channel) would all be wrong.
      throw new AirSendError(`AirSend Web Service answered HTTP ${response.status}`, {
        status: response.status,
        transport: DEVICE_TRANSPORTS.LOCAL,
      });
    }
    const payload = await readJson(response);
    return Array.isArray(payload) ? payload : [];
  }

  /**
   * Ask the box to forward every radio frame it hears on a channel to
   * `callbackUrl`. `duration: 0` means "until further notice"; the subscription
   * is renewed periodically because the box forgets it when it restarts.
   */
  async bind(channelId, callbackUrl, device = {}) {
    if (!this.canUseLocal(device)) {
      throw new AirSendError('Listening requires the local AirSend Web Service', {
        transport: DEVICE_TRANSPORTS.LOCAL,
      });
    }
    // Through the radio queue like an order: subscribing switches the box to
    // permanent reception, and doing that while it is transmitting is how a
    // subscription silently fails to take.
    const response = await this.radio(() =>
      this.localRequest(
        'airsend/bind',
        { channel: { id: Number(channelId) }, duration: 0, callback: callbackUrl },
        device,
      ),
    );
    if (response.status !== 200) {
      throw new AirSendError(localErrorMessage(response.status, this.spurlOf(device)), {
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

/**
 * Is this failure worth another go? A box that answered nothing, timed out or
 * got no radio confirmation may well carry the next one; a box that refused the
 * connection string or the channel will refuse it exactly the same way.
 */
function isRetryable(err) {
  if (err?.eventType !== undefined) {
    return !isPermanentFailure(err.eventType);
  }
  const status = Number(err?.status);
  if (!Number.isFinite(status)) {
    return true;
  }
  return status >= 500;
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

/**
 * The gap between two radio operations. Deliberately NOT unref'd: it is held
 * for a fraction of a second, and an order queued behind a timer the runtime is
 * free to forget is an order that never goes out.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What went wrong, in the words of the box.
 *
 * A 401 is the one worth more than its own message: the box says the same thing
 * about a wrong password and about a string it could not parse, and "check the
 * sp:// URL" sends a user to stare at a password that was right all along. So
 * when the string itself has something visibly wrong with it, that is what the
 * log line says instead.
 */
function localErrorMessage(status, spurl) {
  switch (status) {
    case 401: {
      const [problem] = checkSpurl(spurl);
      return problem
        ? `Invalid connection string (HTTP 401): ${problem.en}`
        : 'Invalid connection string (HTTP 401): check the sp:// URL';
    }
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
