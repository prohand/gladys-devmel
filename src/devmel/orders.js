// -----------------------------------------------------------------------------
// The orders we just sent, so their echo is not mistaken for someone's press.
//
// Everything the integration transmits comes back to it. A transfer sent
// `wait: false` is answered asynchronously, on the very callback the radio
// frames arrive by (see callback.js), and the box — which is listening
// permanently to that same protocol — also hears its own emission. So an order
// Gladys sends is heard by Gladys, on the channel of the device it was sent to,
// carrying the order itself.
//
// Replaying it is not harmless. A shutter driven to 40 % by the stopwatch (see
// travel.js) is sent UP, and its echo says "UP": read as a fresh order, it
// retargets the travel at 100 % and cancels the STOP scheduled at 40 %, so the
// shutter runs to the top. That is what "setting the position works only
// sometimes" looks like from the sofa.
//
// Hence this small registry: what was sent, to whom, and when. It answers one
// question — "is this frame the echo of an order of ours?" — in the two ways
// the echo can come back:
//
//   by uid      the answer to our own transfer carries the `uid` we gave it,
//               which is exactly what that field is for;
//   by channel  the box hearing itself reports a plain radio frame on the
//               device's own channel, with no uid of ours to recognize it by —
//               so an order sent to that very device seconds ago is what
//               identifies it;
//   by voice    and if it comes back later than that, it is still ours. A
//               channel Gladys transmits ON is the address the box emits from:
//               nothing else in the house speaks with that voice.
//
// That last test is the one that holds. The window above is a guess about how
// fast a box repeats itself, and a box that takes its time turns every order
// Gladys sends into an order Gladys believes it heard — a shutter driven to
// 40 %, then sent to the top by the echo of its own UP, twenty seconds later.
//
// A wall remote emits from ANOTHER address (that is what makes it another
// emitter), so none of the three ever swallows it: what they suppress is the
// integration hearing itself.
// -----------------------------------------------------------------------------

import { isSameChannel } from './notes.js';

/** How long the answer to a transfer may take to come back, in ms. */
export const DEFAULT_TTL_MS = 30000;

/**
 * How long a frame heard on the device's own channel is read as our own echo.
 * Much shorter than the uid window: this test recognizes nothing but the
 * timing, and the box hears itself within the second.
 */
export const DEFAULT_CHANNEL_WINDOW_MS = 5000;

/** How many orders are remembered at once, oldest evicted first. */
export const DEFAULT_LIMIT = 64;

export class SentOrders {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] how long an order stays recognizable by uid
   * @param {number} [options.channelWindowMs] and by channel
   * @param {number} [options.limit] orders kept before the oldest is dropped
   * @param {() => number} [options.now] clock, so tests can date orders
   */
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    channelWindowMs = DEFAULT_CHANNEL_WINDOW_MS,
    limit = DEFAULT_LIMIT,
    now = () => Date.now(),
  } = {}) {
    this.ttlMs = ttlMs;
    this.channelWindowMs = channelWindowMs;
    this.limit = limit;
    this.now = now;
    /** @type {Map<string, object>} keyed by the thing uid, insertion-ordered */
    this.entries = new Map();
    /**
     * The channels Gladys transmits on, keyed `pid-addr`: our own voice.
     *
     * Never pruned, unlike the orders above — it is not a memory of what was
     * said, it is the list of addresses we say things from, and that does not
     * expire. One entry per device driven since the integration started.
     *
     * @type {Map<string, object>}
     */
    this.voices = new Map();
  }

  /**
   * Remember one emission.
   *
   * @param {string} uid the `thingnotes.uid` the transfer carried
   * @param {object} device the normalized Devmel device it was sent to
   */
  remember(uid, device = {}) {
    const key = String(uid ?? '');
    if (!key) {
      return null;
    }
    const known = this.entries.get(key);
    const entry = known ?? {
      uid: key,
      name: device.name ?? 'unknown device',
      platformId: device.platformId,
      channel: device.channel,
      emissions: 0,
    };
    // A repeat of the same order refreshes it rather than adding another one:
    // the echoes of both emissions must be recognized, and they are the same
    // order twice.
    entry.emissions += 1;
    entry.at = this.now();

    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value);
    }

    // And remember the voice it was said with, for as long as the integration
    // runs: an echo that comes back after the window above is still ours.
    const voice = channelKey(device.channel);
    if (voice) {
      this.voices.delete(voice);
      this.voices.set(voice, { name: entry.name, platformId: entry.platformId, channel: voice });
      while (this.voices.size > this.limit) {
        this.voices.delete(this.voices.keys().next().value);
      }
    }
    return entry;
  }

  /**
   * Is this radio event an order of ours coming back?
   *
   * @param {object} event an AirSend event, as the callback delivers it
   * @returns {object|null} the order it echoes, null when the frame belongs to
   *   someone else — a wall remote, a sensor, a neighbour's gate
   */
  match(event) {
    this.prune();
    const uid = event?.thingnotes?.uid;
    if (uid) {
      const known = this.entries.get(String(uid));
      if (known) {
        return known;
      }
    }
    const channel = event?.channel;
    if (!channel) {
      return null;
    }
    const now = this.now();
    for (const entry of [...this.entries.values()].reverse()) {
      if (now - entry.at > this.channelWindowMs) {
        // Insertion-ordered and walked backwards: everything left is older.
        break;
      }
      if (isSameChannel(channel, entry.channel)) {
        return entry;
      }
    }
    // Later than the window, and still on a channel we transmit on: ours.
    return this.voices.get(channelKey(channel)) ?? null;
  }

  /** Forget the orders nothing can echo any more. */
  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  clear() {
    this.entries.clear();
    this.voices.clear();
  }
}

/**
 * A channel as a key: the pid/addr pair, and nothing else. The counter, the
 * `mac` and the `seed` change from one frame to the next — matching on them
 * would make every frame a stranger.
 */
function channelKey(channel) {
  const id = Number(channel?.id);
  if (!Number.isFinite(id)) {
    return null;
  }
  const source = channel?.source;
  return `${id}-${source === undefined || source === null ? '' : source}`;
}

/**
 * The registry of the running integration. A single one, like the radio it
 * describes: the driver fills it, and every route the frames come back by
 * (loopback callback, Gladys Plus webhook) reads it.
 */
export const sentOrders = new SentOrders();
