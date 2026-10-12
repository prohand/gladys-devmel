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
//
// Which order a verdict is about is the whole difficulty, and the model is
// the radio's own:
//
//   - one radio per box, so the service answers the emissions in the order
//     it was handed them;
//   - a uid names a feature, not an order: the STOP that ends a timed
//     positioning carries the uid of the UP that started it, the OFF the uid
//     of the ON before it;
//   - an emission the service never received (its request was refused, a
//     repeat dropped behind a newer order) is never answered;
//   - the box hearing itself (a GOT with no uid) answers no emission at all.
//
// So each uid keeps a queue of the emissions handed to the service, each
// tagged with its order, and a verdict is charged to the oldest one waiting.
// An order is judged once every emission it handed over is answered and no
// other can follow — the newest order of its feature replaced it, or all its
// repeats went out. Charged to the newest order instead, the box refusing an
// ON undid the OFF given after it, a refused repeat of the UP of a short
// positioning read as a refused STOP that ran a stopped shutter to its end
// stop, and a carried one hid the STOP the box did refuse.
// -----------------------------------------------------------------------------

import { isSameChannel } from './notes.js';
import { describeFailure, EVENT_TYPES, isErrorEvent } from './events.js';

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
    /**
     * Every new order is numbered, and each device keeps the number of the
     * newest one it acted on: its own, or a group's it followed (see
     * `follows`). Numbers, not times: a scene gives two orders in the same
     * millisecond, and which came second is the whole question.
     */
    this.sequence = 0;
    /** @type {Map<string, number>} keyed by platform id */
    this.actedOn = new Map();
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
   *   included: the verdicts it waits for before it is judged
   * @param {boolean} [order.wait] answered by the transfer itself: no verdict
   *   of it comes back on the callback
   */
  remember(uid, device = {}, { notes = null, fresh = false, emissions = null, wait = false } = {}) {
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
      queue: [],
      due: [],
    };
    // A uid names a feature, not an order: the CLOSE after an OPEN carries the
    // same one. A new order starts its own verdicts; the one it replaces keeps
    // whatever of its emissions the service still has to answer.
    if (!known || fresh) {
      const since = this.now();
      const previous = entry.order;
      entry.order = {
        uid: key,
        seq: ++this.sequence,
        since,
        at: since,
        // Emissions it is to make, repeats included; null when nobody said.
        planned: null,
        handed: 0,
        carried: 0,
        failed: 0,
        uncarried: 0,
        type: null,
        closed: false,
        judged: false,
        silent: false,
        until: null,
      };
      entry.since = since;
      entry.seq = entry.order.seq;
      this.replace(entry, previous);
      this.latest.set(entry.platformId, key);
      this.actedOn.set(entry.platformId, entry.seq);
    }
    const order = entry.order;
    if (Number.isFinite(emissions)) {
      order.planned = emissions;
    }
    // Answered by the transfer itself (`wait: true`): nothing of it comes back
    // on the callback, so nothing waits there for it.
    if (!wait) {
      order.handed += 1;
      entry.queue.push({ order, at: this.now() });
    }
    // A repeat of the same order refreshes it rather than adding another one:
    // the echoes of both emissions must be recognized, and they are the same
    // order twice.
    entry.emissions += 1;
    entry.at = this.now();
    order.at = entry.at;

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
      // Numbered: an echo of the order before, heard after the next one was
      // given, is that order's (see `follows`).
      if (notes) {
        said.push({ notes, at: entry.at, seq: entry.seq });
      }
      this.voices.delete(voice);
      this.voices.set(voice, {
        name: entry.name,
        platformId: entry.platformId,
        channel: voice,
        at: entry.at,
        seq: entry.seq,
        said: said.slice(-SAID_LIMIT),
      });
      while (this.voices.size > this.limit) {
        this.voices.delete(this.voices.keys().next().value);
      }
    }
    return entry;
  }

  /**
   * A new order replaces the one this entry holds. Everything that order will
   * ever hand the service is handed by now: a repeat queued behind the new
   * order is dropped at its turn (see `isOverridden` in client.js). So it is
   * judged on the emissions it made, and on nothing more.
   *
   * Except emissions still unanswered a channel window after their order last
   * went out: the box answers within the second, so those verdicts were lost,
   * and waiting for them would hand that order the new one's — an 8 s
   * positioning whose UP was never answered took the refusal of its STOP for
   * the UP's, and took the travel back instead of running it on. An order
   * missing a verdict is not judged at all: one refusal is not every one.
   */
  replace(entry, previous) {
    if (!previous) {
      return;
    }
    const since = entry.order.since;
    previous.until = since;
    entry.queue = entry.queue.filter((emission) => {
      if (since - emission.order.at <= this.channelWindowMs) {
        return true;
      }
      emission.order.judged = true;
      return false;
    });
    this.close(previous);
  }

  /**
   * No more emission of this order will reach the service: the first one
   * failed for good (`silent`: its caller was told, and showed nothing), a
   * repeat failed or was dropped, a newer order replaced it. Judged now if its
   * verdicts are all in — and reported with the next verdict on its uid, the
   * one thing that still reaches the scenes (see `settle`).
   *
   * @param {object} order what `remember` filed as `entry.order`
   * @param {object} [options]
   * @param {boolean} [options.silent] never reported as a failed order
   */
  close(order, { silent = false } = {}) {
    if (!order) {
      return;
    }
    order.closed = true;
    order.silent = order.silent || silent;
    const entry = this.entries.get(order.uid);
    const verdict = entry ? this.judge(entry, order) : null;
    if (verdict?.failed) {
      entry.due.push(verdict);
    }
  }

  /**
   * The request of an emission never reached the service (connection
   * refused): no verdict will ever answer it. Its retry, if any, is filed
   * again by `remember`.
   */
  unsent(order) {
    const entry = order && this.entries.get(order.uid);
    if (entry?.queue.at(-1)?.order !== order) {
      return;
    }
    entry.queue.pop();
    order.handed -= 1;
    const verdict = order.closed ? this.judge(entry, order) : null;
    if (verdict?.failed) {
      entry.due.push(verdict);
    }
  }

  /**
   * The verdict on a whole order, once there is one: every emission it handed
   * over answered, and none still to come. Given once.
   *
   * @returns {object|null} see `settle`; null while verdicts are missing
   */
  judge(entry, order) {
    const answered = order.carried + order.failed;
    const due = order.closed ? order.handed : Math.max(order.planned ?? 0, order.handed);
    if (order.judged || answered < due) {
      return null;
    }
    order.judged = true;
    const failed = !order.silent && order.carried === 0 && order.failed > 0;
    return {
      failed,
      uncarried: failed && order.uncarried >= order.failed,
      latest: this.latest.get(entry.platformId) === entry.uid,
      since: order.since,
      superseded: order !== entry.order,
      until: order.until,
      seq: order.seq,
      type: order.type,
    };
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
   * Someone else spoke with this voice: a press of a remote sharing the
   * address, applied as such. What Gladys said with it before is no longer
   * what the next frame repeats — matched against the whole minute, the
   * remote's OFF after its ON was dropped as the echo of an OFF Gladys sent
   * earlier, and Gladys showed the plug on while it was off.
   */
  overheard(channel) {
    const voice = this.voices.get(channelKey(channel));
    if (voice) {
      voice.said = [];
    }
  }

  /**
   * Should a device that hears the channel of an order sent to another one (a
   * group channel in its `remotes`) act on this echo of it?
   *
   * Once per order, and only when it is newer than anything that device acted
   * on since. The order comes back several times, and late: the answer to each
   * emission and the box hearing itself. Followed every time, a member set to
   * 50 % right after the group was closed was sent the group's DOWN again by
   * the next echo, which cancelled the STOP of its own travel: it ran to the
   * bottom.
   *
   * Which order, though, is the echo's own: a uid — and the channel window,
   * and the voice — name the newest order on that feature. "Close all", then
   * "Stop all": a late echo of the DOWN, taken for the STOP, was replayed as
   * the newer order, and the STOP's own echo was then refused as already
   * followed — the member ran to the bottom while the group stopped. What the
   * echo says tells them apart: it is the newest order sent with those notes.
   *
   * @param {object} order what `match` returned for the event
   * @param {string} platformId the device that hears it
   * @param {Array<object>} [notes] what the echo says
   */
  follows(order, platformId, notes = null) {
    const seq = this.orderOf(order, notes);
    if (!Number.isFinite(seq)) {
      return true;
    }
    if (seq <= (this.actedOn.get(platformId) ?? 0)) {
      return false;
    }
    this.actedOn.set(platformId, seq);
    return true;
  }

  /** The number of the order an echo repeats: see `follows`. */
  orderOf(order, notes) {
    const heard = new Set((Array.isArray(notes) ? notes : []).map(noteKey));
    if (heard.size === 0) {
      return order?.seq;
    }
    // A voice is keyed already; an order carries the channel itself.
    const key = typeof order?.channel === 'string' ? order.channel : channelKey(order?.channel);
    const said = this.voices.get(key)?.said ?? [];
    for (const spoken of [...said].reverse()) {
      if (
        Number.isFinite(spoken.seq) &&
        spoken.seq <= order.seq &&
        (spoken.notes ?? []).some((note) => heard.has(noteKey(note)))
      ) {
        return spoken.seq;
      }
    }
    return order?.seq;
  }

  /**
   * A remote gave this device an order: every order of ours sent before it is
   * older news, and its echo must not undo that press (see `follows`).
   */
  pressed(platformId) {
    this.actedOn.set(platformId, this.sequence);
  }

  /**
   * Record the box's verdict on one emission, and say what it means for the
   * order that emission belongs to — the oldest one still waiting on that
   * uid (see the top of this file).
   *
   * Only the answers to our transfers are verdicts: the event carries the
   * entry's uid. A PENDING says nothing yet, and the box hearing itself (no
   * uid) answers no emission — counted as one, a late GOT of the UP marked
   * the STOP sent after it as carried, and the refusal of that STOP went
   * unreported while the motor ran on.
   *
   * @param {object} order what `match` returned for the event
   * @param {number} type the event type: below 0x100 it went out
   * @returns {{failed: boolean, uncarried: boolean, latest: boolean, since: ?number,
   *   superseded: boolean, until: ?number, seq: ?number, type: ?number, earlier: Array<object>}}
   *   `failed` once every emission of that order was refused and none went
   *   out; `uncarried` when, on top of that, the box said each time that
   *   nothing reached the air; `latest` when no order went to another feature
   *   of the device since; `since` when it was first sent and `seq` its
   *   number; `superseded` when the same uid carried a newer order since,
   *   given at `until`; `type` the last refusal; `earlier` the failed orders
   *   whose last verdict came before it was known none would follow (see
   *   `close`), to report first
   */
  settle(order, type) {
    // A voice, not an order: older than any verdict should be. Taken at its
    // word, as a failure of its own, and nothing more.
    if (!order || !Array.isArray(order.queue)) {
      return atItsWord(type);
    }
    if (Number(type) === EVENT_TYPES.PENDING) {
      // Taken, not sent yet: the verdict on that emission is still to come.
      return atItsWord(type);
    }
    const now = this.now();
    order.queue = order.queue.filter((emission) => {
      if (now - emission.at <= this.ttlMs) {
        return true;
      }
      emission.order.judged = true;
      return false;
    });
    const earlier = order.due.splice(0);
    const emission = order.queue.shift();
    if (!emission) {
      // Nothing of ours waits for it: said, never charged to an order.
      return { ...atItsWord(type), earlier };
    }
    const judged = emission.order;
    if (isErrorEvent(type)) {
      judged.failed += 1;
      judged.type = type;
      if (describeFailure(type).carried === false) {
        judged.uncarried += 1;
      }
    } else {
      judged.carried += 1;
    }
    const verdict = this.judge(order, judged) ?? {
      failed: false,
      uncarried: false,
      latest: false,
      since: judged.since,
      superseded: judged !== order.order,
      until: judged.until,
      seq: judged.seq,
      type: judged.type,
    };
    return { ...verdict, earlier };
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
    this.actedOn.clear();
  }
}

/** A verdict nobody waits for: a failure if it says so, charged to no order. */
function atItsWord(type) {
  return {
    failed: isErrorEvent(type),
    uncarried: false,
    latest: false,
    since: null,
    superseded: false,
    until: null,
    seq: null,
    type,
    earlier: [],
  };
}

/** A note as a key: what it says, whatever the frame wrapped it in. */
function noteKey(note) {
  return `${note?.type}:${note?.value}`;
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
