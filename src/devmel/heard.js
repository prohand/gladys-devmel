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
   */
  record(channel, { readings = [], claimed = false, understood = false, timestamp } = {}) {
    const id = Number(channel?.id);
    const source = Number(channel?.source);
    if (!Number.isFinite(id) || !Number.isFinite(source)) {
      return null;
    }
    const key = `${id}-${source}`;
    const known = this.entries.get(key);
    const entry = known ?? { id, source, frames: 0, claimed, understood, readings: [] };
    entry.frames += 1;
    entry.claimed = claimed;
    // Sticky: a remote that was understood once is understood, even when its
    // next frame carries nothing (a released button, a repeated frame).
    entry.understood = entry.understood || understood;
    entry.readings = readings;
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
  }
}

/**
 * The registry of the running integration. A single one, like the radio it
 * describes: every route (loopback callback, Gladys Plus webhook) feeds it.
 */
export const heardChannels = new HeardChannels();
