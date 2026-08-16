// -----------------------------------------------------------------------------
// What the box actually heard on the air.
//
// A radio frame is a fact that lasts a fraction of a second: it is logged, and
// then it is gone. That is enough when the frame belongs to a declared device,
// and not nearly enough when it does not — attaching a wall remote means
// copying a pid/addr pair out of a log the user has to find, read and retype
// into JSON, exactly once, and correctly.
//
// So the frames are also remembered here, in a small bounded registry: the
// emitters heard, how many frames each sent, when, and what those frames
// decoded to. That registry is what the "attach a remote" action reads to
// write the configuration line itself (see remotes.js), and what tells apart
// "the box hears nothing" from "the box hears it but nobody claims it".
//
// Bounded on purpose: the air is public, and a busy 433 MHz band would
// otherwise grow this list for as long as the integration runs.
// -----------------------------------------------------------------------------

import { describeReadings } from './notes.js';

/** How many distinct emitters are remembered, oldest evicted first. */
export const DEFAULT_LIMIT = 32;

export class HeardChannels {
  /**
   * @param {object} [options]
   * @param {number} [options.limit] emitters kept before the oldest is dropped
   * @param {() => number} [options.now] clock, so tests can date frames
   */
  constructor({ limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.now = now;
    /** @type {Map<string, object>} keyed by `pid-addr`, insertion-ordered */
    this.entries = new Map();
    /**
     * How many events reached the integration at all, whatever became of them.
     *
     * The emitters below are only the frames that got as far as being routed.
     * A registry that is empty says nothing about WHY — a box that hears
     * nothing and a box whose every frame was dropped on the way look exactly
     * the same, and they are two completely different problems. These three
     * counters are what tells them apart.
     */
    this.seen = 0;
    /** Of those, the echoes of our own orders: proof the route back works. */
    this.own = 0;
    /** And those dropped before any device could see them, and why. */
    this.dropped = 0;
    /** @type {string|null} */
    this.lastDrop = null;
  }

  /**
   * Count one event handed to the integration.
   *
   * @param {object} [details]
   * @param {string} [details.dropped] why it went no further, when it did not
   * @param {boolean} [details.own] it is the echo of an order we sent
   */
  received({ dropped = null, own = false } = {}) {
    this.seen += 1;
    if (own) {
      this.own += 1;
    }
    if (dropped) {
      this.dropped += 1;
      this.lastDrop = dropped;
    }
  }

  /**
   * Remember one frame.
   *
   * @param {{id: number, source: number}} channel emitter of the frame
   * @param {object} [details]
   * @param {Array<object>} [details.readings] what its notes decoded to
   * @param {boolean} [details.claimed] a declared device recognized it
   * @param {boolean} [details.understood] a device acted on it
   * @param {number} [details.timestamp] box timestamp, ms
   * @param {string} [details.dropped] why the frame went no further, when it
   *   was dropped on the way: an emitter heard and thrown away is still an
   *   emitter heard, and hiding it is what makes a noisy install look silent
   */
  record(channel, { readings, claimed, understood = false, timestamp, dropped = null } = {}) {
    const id = Number(channel?.id);
    const source = Number(channel?.source);
    if (!Number.isFinite(id) || !Number.isFinite(source)) {
      return null;
    }
    const key = `${id}-${source}`;
    const known = this.entries.get(key);
    const entry = known ?? {
      id,
      source,
      frames: 0,
      claimed: claimed ?? false,
      understood,
      readings: readings ?? [],
      dropped: null,
    };
    entry.frames += 1;
    entry.dropped = dropped;
    // Sticky: a remote that was understood once is understood, even when its
    // next frame carries nothing (a released button, a repeated frame).
    entry.understood = entry.understood || understood;
    // A frame dropped on the way says nothing about who claims the emitter or
    // about what it usually carries: it was never routed. Only what the caller
    // actually established is written down.
    if (claimed !== undefined) {
      entry.claimed = claimed;
    }
    if (readings !== undefined) {
      entry.readings = readings;
    }
    entry.lastSeen = Number.isFinite(Number(timestamp)) ? Number(timestamp) : this.now();

    // Re-insert so the map stays ordered by last frame: the emitter the user
    // just pressed is the one the action attaches.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return entry;
  }

  /** Every emitter heard, most recent first. */
  list() {
    return [...this.entries.values()].reverse();
  }

  clear() {
    this.entries.clear();
    this.seen = 0;
    this.own = 0;
    this.dropped = 0;
    this.lastDrop = null;
  }
}

/**
 * One emitter of the registry, as a human reads it: who, how often, when, and
 * what its frames decoded to — `pid 14177, addr 3359265281 (3 frames, last one
 * 4 s ago, no decoded note)`.
 *
 * Shared by the two screens that show the registry, the "attach a remote"
 * action and the connection report, so an emitter is spelled the same way
 * wherever the user meets it: they are comparing the two, pid in hand.
 *
 * @param {object} entry an entry of {@link HeardChannels.list}
 * @param {number} [now] clock, so a report can be dated in a test
 * @param {string} [language] 'fr', or English
 */
export function describeEmitter(entry, now = Date.now(), language = 'en') {
  const notes = describeReadings(entry.readings);
  const frames =
    language === 'fr'
      ? `${entry.frames} trame${entry.frames > 1 ? 's' : ''}`
      : `${entry.frames} frame${entry.frames > 1 ? 's' : ''}`;
  const age = describeAge(now - entry.lastSeen, language);
  const said = notes
    ? language === 'fr'
      ? `, note : ${notes}`
      : `, note: ${notes}`
    : language === 'fr'
      ? ', aucune note décodée'
      : ', no decoded note';
  return `pid ${entry.id}, addr ${entry.source} (${frames}, ${age}${said})`;
}

/**
 * How long ago a frame was heard, as a human reads it: "3 s ago" and "12 min
 * ago" answer two different questions about the same emitter.
 */
export function describeAge(milliseconds, language) {
  const seconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
  const value = seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  return language === 'fr' ? `dernière il y a ${value}` : `last one ${value} ago`;
}

/**
 * The registry of the running integration. A single one, like the radio it
 * describes: every route (loopback callback, Gladys Plus webhook) feeds it.
 */
export const heardChannels = new HeardChannels();
