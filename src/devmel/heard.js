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
     * Which configuration the once-only lines were said for (see `announce`).
     * Bumped by `reannounce()`, never read anywhere else.
     */
    this.generation = 0;
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
    if (!Number.isFinite(id)) {
      return null;
    }
    // An emitter whose ADDRESS was not decoded is still an emitter heard, and
    // it is the shape of a protocol the box picked up without decoding it: the
    // one thing the user must be told, since no `remotes` line can name it and
    // the registry used to drop it on the floor.
    const raw = Number(channel?.source);
    const source = Number.isFinite(raw) ? raw : null;
    const key = `${id}-${source ?? ''}`;
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

  /**
   * Is this the first time we say THIS about that emitter, under the
   * configuration in force?
   *
   * What is worth an info line once is noise on every repeat: a remote pressed
   * twice a day must not fill the logs with a fact the user has already been
   * told. So each line is said once per emitter — and said again after every
   * configuration change (see `reannounce`), because the user who just attached
   * a remote is testing exactly the frames the throttle had gone quiet about.
   *
   * @param {?object} entry an entry of this registry, as `record` returns it
   * @param {string} [kind] which line: an emitter can be worth several, and
   *   dropping the others because the first one was said is how "heard and
   *   claimed by nobody" hides "heard, claimed, and understood by nobody"
   * @returns {boolean} true when the caller should say it out loud
   */
  announce(entry, kind = 'heard') {
    // A frame nothing remembered (an unreadable channel) has no throttle to
    // obey: silence is the worse mistake of the two.
    if (!entry) {
      return true;
    }
    if (entry.announcedAt !== this.generation) {
      entry.announcedAt = this.generation;
      entry.announced = new Set();
    }
    if (entry.announced.has(kind)) {
      return false;
    }
    entry.announced.add(kind);
    return true;
  }

  /**
   * Say the once-only lines again, for the configuration that is now in force.
   *
   * A user changes their configuration BECAUSE something is not working, and
   * the lines that would tell them whether it worked have all been said already:
   * the emitter is known, so its next frame goes to debug, and the screen they
   * are watching stays empty. Every configuration update re-arms them — one
   * line per emitter, again — so the very next press of the remote says where
   * its frame went this time.
   */
  reannounce() {
    this.generation += 1;
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
  return `pid ${entry.id}, ${describeAddress(entry, language)} (${frames}, ${age}${said})`;
}

/**
 * The address of an emitter, or the fact that the box did not decode one —
 * which is not a detail: an address is what a `remotes` line names, so a frame
 * without one cannot be attached to anything until the protocol is decoded.
 */
export function describeAddress(entry, language = 'en') {
  if (entry.source === null || entry.source === undefined) {
    return language === 'fr' ? 'adresse non décodée' : 'address not decoded';
  }
  return `addr ${entry.source}`;
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
