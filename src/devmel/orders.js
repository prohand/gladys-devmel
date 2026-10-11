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
//
// The voice still expires, a minute after Gladys last used it — three times
// the slowest echo seen. A device declared with the very address of its remote
// (a remote copied into the AirSend app, the usual way for a fixed-code gate)
// speaks with that voice too, and a voice that never expired turned every press
// of that remote, an hour after a single order from Gladys, into an echo.
//
// It also keeps the box's verdict on each order. With `wait: false` the HTTP
// answer only says the service took the order; whether the box carried it
// comes back later, once per emission — the first one and every repeat, all
// under the same uid. One emission refused while another went out is an order
// that went out: only an order whose every emission was refused failed.
// -----------------------------------------------------------------------------

import { isSameChannel } from './notes.js';
import { describeFailure, isErrorEvent } from './events.js';

/** How long the answer to a transfer may take to come back, in ms. */
export const DEFAULT_TTL_MS = 30000;

/**
 * How long a frame heard on the device's own channel is read as our own echo.
 * Much shorter than the uid window: this test recognizes nothing but the
 * timing, and the box hears itself within the second.
 */
export const DEFAULT_CHANNEL_WINDOW_MS = 5000;

/**
 * How long a frame on a channel Gladys transmits on is still read as its echo,
 * counted from the last order sent on it. Far above the slowest echo seen
 * (twenty seconds), and short enough that a remote sharing that address — one
 * copied into the AirSend app — is followed again a minute after an order.
 */
export const DEFAULT_VOICE_WINDOW_MS = 60000;

/** How many orders are remembered at once, oldest evicted first. */
export const DEFAULT_LIMIT = 64;

/** How many recent orders are kept per voice, to recognize them in an echo. */
const SAID_LIMIT = 8;

export class SentOrders {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] how long an order stays recognizable by uid
   * @param {number} [options.channelWindowMs] and by channel
   * @param {number} [options.voiceWindowMs] and by voice
   * @param {number} [options.limit] orders kept before the oldest is dropped
   * @param {() => number} [options.now] clock, so tests can date orders
   */
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    channelWindowMs = DEFAULT_CHANNEL_WINDOW_MS,
    voiceWindowMs = DEFAULT_VOICE_WINDOW_MS,
    limit = DEFAULT_LIMIT,
    now = () => Date.now(),
  } = {}) {
    this.ttlMs = ttlMs;
    this.channelWindowMs = channelWindowMs;
    this.voiceWindowMs = voiceWindowMs;
    this.limit = limit;
    this.now = now;
    /** @type {Map<string, object>} keyed by the thing uid, insertion-ordered */
    this.entries = new Map();
    /**
     * The channels Gladys transmits on, keyed `pid-addr`: our own voice, and
     * when it was last used.
     *
     * Kept longer than the orders above (see `voiceWindowMs`): it is not a
     * memory of what was said, it is the list of addresses we say things from.
     * One entry per device driven since the integration started.
     *
     * @type {Map<string, object>}
     */
    this.voices = new Map();
    /**
     * The uid of the last order given to each device, keyed by platform id: a
     * verdict on an older one says nothing about where the device is now.
     *
     * @type {Map<string, string>}
     */
    this.latest = new Map();
  }

  /**
   * Remember one emission.
   *
   * @param {string} uid the `thingnotes.uid` the transfer carried
   * @param {object} device the normalized Devmel device it was sent to
   * @param {object} [order]
   * @param {Array<object>} [order.notes] the notes it carried
   * @param {boolean} [order.fresh] a new order rather than a repeat or a retry
   *   of the one before: the verdicts start over
   * @param {number} [order.emissions] how many times it is to go out, repeats
   *   included: the verdicts it takes to call it failed
   */
  remember(uid, device = {}, { notes = null, fresh = false, emissions = null } = {}) {
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
    // A uid names a feature, not an order: the CLOSE after an OPEN carries the
    // same one. Its verdicts are the new order's, not added to the old one's.
    if (!known || fresh) {
      Object.assign(entry, {
        since: this.now(),
        expected: null,
        carried: 0,
        failed: 0,
        uncarried: 0,
      });
      this.latest.set(entry.platformId, key);
    }
    if (Number.isFinite(emissions)) {
      entry.expected = emissions;
    }
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
      // What was said with it, too. The echo of a percentage or of an ON comes
      // back as a plain reading, with no order to tell it from a report — and
      // a late one landed over the order given since (see `said`).
      const said = (this.voices.get(voice)?.said ?? []).filter(
        (spoken) => entry.at - spoken.at <= this.voiceWindowMs,
      );
      if (notes) {
        said.push({ notes, at: entry.at });
      }
      this.voices.delete(voice);
      this.voices.set(voice, {
        name: entry.name,
        platformId: entry.platformId,
        channel: voice,
        at: entry.at,
        said: said.slice(-SAID_LIMIT),
      });
      while (this.voices.size > this.limit) {
        this.voices.delete(this.voices.keys().next().value);
      }
    }
    return entry;
  }

  /**
   * The notes recently sent on this channel, oldest first: whatever an echo
   * heard on it says that matches one of them is our own order coming back.
   *
   * @returns {Array<object>}
   */
  said(channel) {
    const voice = this.voices.get(channelKey(channel));
    const now = this.now();
    return (voice?.said ?? [])
      .filter((spoken) => now - spoken.at <= this.voiceWindowMs)
      .flatMap((spoken) => spoken.notes);
  }

  /**
   * Record the box's verdict on one emission of an order, and say what it
   * means for the order as a whole.
   *
   * @param {object} order what `match` returned for the event
   * @param {number} type the event type: below 0x100 it went out
   * @returns {{failed: boolean, uncarried: boolean, latest: boolean, since: ?number}}
   *   `failed` once every emission it was to make was refused and none went
   *   out; `uncarried` when, on top of that, the box said each time that
   *   nothing reached the air; `latest` when it is still the device's last
   *   order; `since` when it was first sent
   */
  settle(order, type) {
    // A voice, not an order: older than any verdict should be. Taken at its
    // word, as a failure of its own, and nothing more.
    if (!order || !Number.isFinite(order.failed)) {
      return { failed: isErrorEvent(type), uncarried: false, latest: false, since: null };
    }
    if (!isErrorEvent(type)) {
      order.carried += 1;
      return { failed: false, uncarried: false, latest: false, since: order.since };
    }
    order.failed += 1;
    if (describeFailure(type).carried === false) {
      order.uncarried += 1;
    }
    const failed = order.carried === 0 && order.failed >= (order.expected ?? order.emissions);
    return {
      failed,
      uncarried: failed && order.uncarried >= order.failed,
      latest: this.latest.get(order.platformId) === order.uid,
      since: order.since,
    };
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
    // Later than the window, and still on a channel we transmit on: ours —
    // for a minute, not for ever (see `voiceWindowMs`).
    const voice = this.voices.get(channelKey(channel));
    return voice && now - voice.at <= this.voiceWindowMs ? voice : null;
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
    this.latest.clear();
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
