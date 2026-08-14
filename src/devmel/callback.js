// -----------------------------------------------------------------------------
// Where the AirSend Web Service drops the frames it hears.
//
// `POST /airsend/bind` takes a `callback` URL, and this is the piece that
// answers on it. The important thing about that URL is WHO calls it: not the
// box — it has no idea what a Gladys is — but the AirSend Web Service itself,
// from the machine it runs on. Devmel's own integrations say it plainly by
// pointing the callback at their own loopback address (`http://127.0.0.1/…` in
// the Jeedom plugin, which explicitly refuses an `https://` base and falls back
// to plain HTTP on 127.0.0.1).
//
// The integration runs that service inside its OWN container (see service.js),
// so the callback has one obvious address: a small HTTP server on the loopback
// of that same container. No relay, no public URL, no HTTPS — the three things
// the service cannot do.
//
// The body it posts is the one the Jeedom plugin decodes:
//
//     { "events": [ { "channel": {...}, "type": 3, "reliability": 42,
//                     "thingnotes": { "notes": [ ... ] },
//                     "timestamp": 1765432100000 } ] }
//
// Which is exactly what the `events` webhook receives when the frames come
// through the Gladys Plus relay instead: both routes hand the same payload to
// the same handler.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'airsend-callback' });

/** Port the loopback callback listens on, unless it is already taken. */
export const DEFAULT_CALLBACK_PORT = 33864;

// A radio frame is a few hundred bytes; anything above this is not one.
const MAX_BODY_BYTES = 256 * 1024;

export class CallbackServer {
  /**
   * @param {object} [options]
   * @param {string} [options.host] address to listen on — the loopback, since
   *   the only caller is a process in this very container
   * @param {number} [options.port] preferred port; an ephemeral one is used
   *   when it is already taken (a previous daemon still holding it)
   */
  constructor({
    host = '127.0.0.1',
    port = Number(process.env.DEVMEL_CALLBACK_PORT) || DEFAULT_CALLBACK_PORT,
  } = {}) {
    this.host = host;
    this.preferredPort = port;
    this.server = null;
    this.port = null;
    /** @type {((events: Array<object>) => Promise<void>) | null} */
    this.onEvents = null;
  }

  /** The URL to hand to `POST /airsend/bind`, or null while it is not up. */
  get url() {
    return this.port === null ? null : `http://${this.host}:${this.port}/`;
  }

  /**
   * Start listening. Idempotent: a second call only replaces the handler, so a
   * configuration update does not tear the subscription down.
   *
   * @param {(events: Array<object>) => Promise<void>} onEvents
   * @returns {Promise<string|null>} the callback URL, null when it could not
   *   listen (the integration keeps running, without the radio listener)
   */
  async start(onEvents) {
    this.onEvents = onEvents;
    if (this.server) {
      return this.url;
    }

    const server = createServer((request, response) => {
      this.handle(request, response).catch((err) => {
        logger.error('Could not handle an AirSend callback', err);
        // The acknowledgement is sent before the frame is published, so there
        // is usually nothing left to answer with: what failed is on our side of
        // the wire, and the service has no use for it.
        if (!response.headersSent) {
          response.writeHead(500).end();
        }
      });
    });
    // A radio frame arriving late must not keep a connection alive for ever.
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;

    try {
      this.port = await listen(server, this.preferredPort, this.host);
    } catch (err) {
      logger.warn(`Could not listen for AirSend callbacks: ${err.message}`);
      this.port = null;
      return null;
    }
    // From here on a socket error is just noise on one connection: logged, never
    // thrown, so it cannot take the integration down.
    server.on('error', (err) => logger.warn(`AirSend callback server error: ${err.message}`));
    this.server = server;
    logger.info(`Listening for AirSend radio frames on ${this.url}`);
    return this.url;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.onEvents = null;
    if (!server) {
      return;
    }
    await new Promise((resolve) => {
      server.close(resolve);
      // `close` only stops new connections: a keep-alive one the service left
      // open would hold the shutdown for as long as it pleases.
      server.closeAllConnections?.();
    });
  }

  /**
   * Read one callback and hand its events over. The answer is always a 200: the
   * service has nothing to do with what Gladys makes of a frame, and a
   * non-200 would only make it retry a frame that is already history.
   */
  async handle(request, response) {
    const body = await readBody(request);
    response.writeHead(200, { 'content-type': 'text/plain' }).end('OK');

    const events = eventsOf(body);
    if (events.length === 0 || !this.onEvents) {
      return;
    }
    await this.onEvents(events);
  }
}

/**
 * The events carried by a callback body. The service posts `{ events: [...] }`;
 * a lone event object is accepted too, because that is what the answer to a
 * fire-and-forget `transfer` looks like.
 */
export function eventsOf(body) {
  if (!body) {
    return [];
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    logger.warn(`Ignoring an unreadable AirSend callback: ${err.message}`);
    return [];
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  if (Array.isArray(payload.events)) {
    return payload.events;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.thingnotes ? [payload] : [];
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error('AirSend callback body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Listen on `port`, falling back to an ephemeral one when it is taken — the
 * daemon of a previous run can still hold it for a few seconds, and a listener
 * on another port is worth more than no listener at all.
 */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        logger.warn(`Port ${port} is taken, listening for AirSend callbacks on a free one`);
        server.listen(0, host);
        return;
      }
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.on('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
