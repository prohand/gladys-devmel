// -----------------------------------------------------------------------------
// Travel-time position tracking.
//
// 433 MHz shutters never say where they are: the radio carries orders, not
// positions (the official Devmel component simply assumes 100 % after an UP and
// 50 % after a STOP). What a shutter does have is a *duration*: a given motor
// always takes the same time to run from one end stop to the other. Time that
// travel once, and the position becomes computable — that is the approach
// openHAB, the Home Assistant time-based covers and the Shelly cover mode all
// take, and it is the only one that works with a one-way protocol.
//
// So this module holds, per shutter, the last known position and the movement
// currently under way, and interpolates between the two. It is driven by three
// things: our own orders, the orders it hears on the radio (a wall remote
// pressed by hand), and a STOP that freezes the shutter mid-course.
//
// Two properties make it trustworthy over time:
//   - a movement that is allowed to reach an end stop lands on an EXACT 0 or
//     100 %, because the motor physically stops there. Every full open or full
//     close therefore resynchronizes the estimate and wipes the accumulated
//     error;
//   - a position that was never established stays `null` — unknown — instead of
//     being invented. It becomes known again at the next end stop.
// -----------------------------------------------------------------------------

import { createLogger } from '../logging.js';

const logger = createLogger({ name: 'travel' });

/** How often a moving shutter publishes its position, in milliseconds. */
export const DEFAULT_TICK_MS = 1000;

/**
 * Positions published per tick by all the moving shutters together. Gladys
 * takes 300 states a minute from an integration and answers 429 past that: a
 * dozen shutters closed by one scene, each publishing every second, used the
 * whole budget on the way down, and their end stops — published last, the ones
 * that matter — were refused. With many shutters on the move each publishes
 * less often; the arrival is never held back by this.
 */
export const POSITIONS_PER_TICK = 2;

/** Directions a shutter travels in. */
export const DIRECTIONS = { UP: 'up', DOWN: 'down' };

/** Timers, injectable so the tests can drive the clock themselves. */
const REAL_TIMERS = {
  set(callback, delay) {
    const handle = setTimeout(callback, delay);
    // A shutter half-way up must not keep the process alive.
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle);
  },
};

export class ShutterTravel {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] clock, in milliseconds
   * @param {number} [options.tickMs] interval between two published positions
   * @param {{ set: Function, clear: Function }} [options.timers]
   */
  constructor({ now = Date.now, tickMs = DEFAULT_TICK_MS, timers = REAL_TIMERS } = {}) {
    this.now = now;
    this.tickMs = tickMs;
    this.timers = timers;
    /** @type {Map<string, object>} state per device platform id */
    this.states = new Map();
  }

  /** Whether this shutter was given the travel times the estimate needs. */
  tracks(device) {
    return travelMsFor(device, DIRECTIONS.UP) !== null;
  }

  /**
   * Where the shutter is: the frozen position when it is still, the
   * interpolated one while it moves, `null` when it was never established.
   */
  positionOf(device) {
    const state = this.states.get(device.platformId);
    if (!state) {
      return null;
    }
    if (!state.move) {
      return state.position;
    }
    if (state.move.from === null) {
      // Moving, but from an unknown spot: nothing to interpolate from. The
      // position becomes known again when the movement reaches its end stop.
      return null;
    }
    return positionAt(state.move, this.now());
  }

  /**
   * Whether anything was ever recorded for this shutter — `positionOf` cannot
   * say: its `null` is both "never heard of" and "known to have gone somewhere
   * nobody can tell" (the motor's own favourite position, a toggle), and only
   * the first may be filled in from elsewhere.
   */
  knows(device) {
    return this.states.has(device.platformId);
  }

  /** True while a movement is under way. */
  isMoving(device) {
    return Boolean(this.states.get(device.platformId)?.move);
  }

  /**
   * Record an established position: restored from Gladys at startup, or read
   * from a device that did report one. Cancels any movement under way.
   */
  set(device, position) {
    const state = this.stateOf(device);
    this.cancel(state);
    state.position = position === null ? null : clamp(position);
  }

  /**
   * Start a movement, replacing the one under way (a shutter told to go down
   * while going up simply turns around).
   *
   * @param {object} device
   * @param {object} options
   * @param {'up'|'down'} options.direction
   * @param {number} [options.target] where the motor was told to stop; the end
   *   stop of `direction` by default
   * @param {(position: number, info: { done: boolean }) => Promise<void>} options.publish
   * @param {() => Promise<void>} [options.arrive] what stops the motor at
   *   `target` (a STOP order), run at the arrival before anything is published
   * @returns {boolean} false when this shutter has no travel time configured
   */
  move(device, { direction, target, publish, arrive = null }) {
    const travelMs = travelMsFor(device, direction);
    if (travelMs === null) {
      return false;
    }
    const state = this.stateOf(device);
    // Where we start from is where we are right now — mid-course included, so
    // reversing a movement does not lose the ground already covered.
    const from = this.positionOf(device);
    const turned = Boolean(state.move);
    this.cancel(state);

    const destination = clamp(target ?? (direction === DIRECTIONS.UP ? 100 : 0));
    if (from !== null && from === destination) {
      state.position = destination;
      return true;
    }

    const startedAt = this.now();
    // An unknown starting point means the worst case: a full travel, which is
    // exactly what makes the end stop resynchronize the estimate.
    const distance = from === null ? 100 : Math.abs(destination - from);
    state.move = {
      direction,
      from,
      target: destination,
      startedAt,
      endAt: startedAt + (distance / 100) * travelMs,
      publish,
      arrive,
      /** It replaced a movement under way, rather than setting off a still shutter. */
      turned,
      /** The mid-course publication still in flight, if any. */
      publishing: null,
      /** The last mid-course position Gladys was given. */
      published: null,
    };
    this.schedule(device, state);
    return true;
  }

  /**
   * Freeze the shutter where it is (a STOP order, ours or heard on the radio).
   *
   * @returns {number|null} the position it stopped at, `null` when unknown
   */
  stop(device) {
    const state = this.states.get(device.platformId);
    if (!state) {
      return null;
    }
    const position = this.positionOf(device);
    this.cancel(state);
    state.position = position;
    return position;
  }

  /**
   * Take back a movement the motor never made: the box said the order that
   * started it never reached the air. Its STOP goes with it — sent to a still
   * Somfy shutter, a STOP is the "my" button, and the shutter that had not
   * moved set off for its favourite position.
   *
   * Only a movement started at `since` or later (an older one was another
   * order's, and that one went out) and before `until` (a newer one is the
   * order given after the refused one), and only one that set off a still
   * shutter: one that turned a moving shutter around leaves it running the
   * way it was, which nothing here can rebuild.
   *
   * A travel that already arrived too: a short positioning (2 % of a 20 s
   * shutter) lands before the box refuses the UP that started it, and the
   * motor that never left 0 % was shown, and timed from, 2 %.
   *
   * @returns {boolean} whether a movement was taken back
   */
  revert(device, since, until = Infinity) {
    const state = this.states.get(device.platformId);
    const move = state?.move ?? state?.landed?.move;
    if (!move || move.turned || move.startedAt < since || move.startedAt >= until) {
      return false;
    }
    this.cancel(state);
    state.position = move.from;
    return true;
  }

  /**
   * Carry on to its end stop a travel whose arrival STOP the box said, later,
   * it never sent (BUSY, NETWORK…). With `wait: false` that is how a refused
   * STOP comes back: as an error on the callback, long after the travel
   * arrived. Nothing stopped the motor, so the travel goes on from the target,
   * from the moment the STOP was due — as when the STOP fails at once (see
   * `arrive`). Kept at the target, Gladys showed 40 % while the shutter ran
   * to the top, and every later positioning was timed from there.
   *
   * Only the STOP of the last arrival, and only while nothing has touched the
   * shutter since: `since` (when the refused order was first sent) must fall
   * between the arrival and the moment its STOP was handed over. A PING sent
   * afterwards and refused is not that STOP.
   *
   * @returns {'up'|'down'|null} the direction it carries on in, null when
   *   the refused order was not that STOP
   */
  resume(device, since) {
    const state = this.states.get(device.platformId);
    const landed = state?.landed;
    if (!landed || since < landed.move.endAt) {
      return null;
    }
    if (landed.sentBy !== null && since > landed.sentBy) {
      return null;
    }
    this.carryOn(device, state, landed.move);
    return landed.move.direction;
  }

  /**
   * See the shutter the other way round (its `invert` was corrected):
   * positions are in Gladys terms, which `invert` turns upside down. A
   * movement under way is mirrored, not cancelled: the motor keeps running
   * the way it was, and its STOP is due at the same time. Left as it was,
   * the travel ended in the old terms and Gladys showed the mirror of the
   * shutter until the next order.
   */
  mirror(device) {
    const state = this.states.get(device.platformId);
    if (!state) {
      return;
    }
    if (state.move) {
      mirrorMove(state.move);
      return;
    }
    state.position = state.position === null ? null : 100 - state.position;
    // An arrival whose STOP is still on its way publishes its target, and
    // carries on from it if that STOP fails: both in the new terms.
    if (state.landed) {
      mirrorMove(state.landed.move);
    }
  }

  /**
   * How long until the next STOP a movement under way has to send (its
   * `arrive`), in milliseconds, or null when none is waiting for one. That STOP
   * waits here, in a timer, not in the radio queue: whoever wants the radio for
   * something slow has to ask (see `rebindNow` in index.js).
   */
  untilArrival() {
    let soonest = null;
    for (const state of this.states.values()) {
      if (state.move?.arrive) {
        const left = Math.max(0, state.move.endAt - this.now());
        soonest = soonest === null ? left : Math.min(soonest, left);
      }
    }
    return soonest;
  }

  /**
   * Bring every movement under way to the end it is going to have (integration
   * shutdown): its timers are about to go, and with them the STOP of a shutter
   * driven to 40 % and the publication of where it lands. Cleared as they
   * were, the motor ran into its end stop, Gladys kept the last tick of the
   * way, and the next start timed every positioning from that stale value.
   *
   * A movement stopped by an order (`arrive`) is stopped now, where it is: the
   * radio still works, and an early STOP beats none. Any other one is heading
   * for a place the motor finds by itself (an end stop, its own favourite):
   * that is where it is published.
   *
   * An arrival already under way (its STOP waiting for the radio, its target
   * not published yet) is waited for, and settled again if its STOP failed.
   * Overlooked, shutdown went on to stop the service under it: the STOP
   * failed, and Gladys kept the last tick of the way.
   */
  async settle() {
    // Every STOP is queued before anything is published: radio first, as at
    // any arrival (see `arrive`).
    await Promise.all([...this.states.values()].map((state) => this.settleState(state)));
  }

  /** Cancel every pending timer (integration shutdown). */
  clear() {
    for (const state of this.states.values()) {
      this.cancel(state);
    }
  }

  // --- internals -------------------------------------------------------------

  stateOf(device) {
    let state = this.states.get(device.platformId);
    if (!state) {
      state = { position: null, move: null, handle: null, device, landed: null, arriving: null };
      this.states.set(device.platformId, state);
    }
    state.device = device;
    return state;
  }

  /** One shutter of `settle`. */
  async settleState(state) {
    if (state.arriving) {
      // Its failure was said where the arrival runs (see `schedule`).
      await state.arriving.catch(() => {});
    }
    if (state.move) {
      await this.settleOne(state);
    }
  }

  /** One movement of `settle`. */
  async settleOne(state) {
    const { move, device } = state;
    const name = device.name ?? device.platformId;
    let position = move.target;
    if (move.arrive) {
      position = move.from === null ? null : positionAt(move, this.now());
    }
    // Still before the STOP: a STOP sent to a shutter the travel says is
    // moving is dropped as stale (see `driveTo`).
    this.cancel(state);
    state.position = position;
    if (move.arrive) {
      try {
        await move.arrive();
      } catch (error) {
        // Nothing stopped the motor: it runs on to its end stop (see `arrive`).
        position = move.direction === DIRECTIONS.UP ? 100 : 0;
        state.position = position;
        logger.warn(`"${name}" could not be stopped before shutting down: ${error.message}`);
      }
    }
    if (position === null) {
      return;
    }
    try {
      await move.publishing;
      await move.publish(position, { done: true });
    } catch (error) {
      logger.warn(`Position of "${name}" not published: ${error.message}`);
    }
  }

  cancel(state) {
    if (state.handle) {
      this.timers.clear(state.handle);
      state.handle = null;
    }
    state.move = null;
    // Whatever replaced the last arrival, a STOP refused later no longer says
    // where the shutter is (see `resume`).
    state.landed = null;
  }

  /**
   * Arm the next position publication. The delay is the tick (longer when many
   * shutters move at once, see `POSITIONS_PER_TICK`), or what is left of the
   * travel when that is shorter, so the shutter lands on its end stop at the
   * very moment the motor does.
   */
  schedule(device, state) {
    const remaining = state.move.endAt - this.now();
    let moving = 0;
    for (const other of this.states.values()) {
      moving += other.move ? 1 : 0;
    }
    const interval = this.tickMs * Math.max(1, moving / POSITIONS_PER_TICK);
    const delay = Math.max(0, Math.min(interval, remaining));
    state.handle = this.timers.set(() => {
      this.tick(device, state).catch((error) => {
        // Nothing above a timer callback can handle it: say it and move on.
        logger.warn(`Position tracking of "${device.name ?? device.platformId}": ${error.message}`);
      });
    }, delay);
  }

  async tick(device, state) {
    const move = state.move;
    if (!move) {
      return;
    }
    state.handle = null;
    const done = this.now() >= move.endAt;

    if (done) {
      state.move = null;
      state.position = move.target;
      // Held on the state so a shutdown waits for it (see `settle`).
      const arriving = this.land(device, state, move);
      state.arriving = arriving;
      try {
        await arriving;
      } finally {
        if (state.arriving === arriving) {
          state.arriving = null;
        }
      }
      return;
    }

    // The next tick is armed FIRST, whatever Gladys does with this one: it is
    // what carries the arrival, and the arrival is what sends the STOP of a
    // shutter driven to 40 %. Armed after a publication that failed, the motor
    // ran into its end stop; after one Gladys took six seconds to answer, the
    // STOP went out six seconds late.
    this.schedule(device, state);
    // Mid-course: only a shutter whose starting point was known has an
    // intermediate position worth publishing — and only one at a time: a tick
    // that finds the previous one still in flight lets it be, rather than
    // piling requests on a Gladys already slow to answer.
    if (move.from === null || move.publishing) {
      return;
    }
    const position = positionAt(move, this.now());
    if (position === move.published) {
      return;
    }
    move.publishing = move
      .publish(position, { done: false })
      .then(
        () => {
          move.published = position;
        },
        (error) => {
          logger.warn(
            `Position of "${device.name ?? device.platformId}" not published: ${error.message}`,
          );
        },
      )
      .finally(() => {
        move.publishing = null;
      });
    await move.publishing;
  }

  /** The arrival of `move`: its STOP, then where it ends. */
  async land(device, state, move) {
    await this.arrive(device, state, move);
    // A newer movement replaced this one while its STOP waited for the radio
    // (a wall remote pressed meanwhile), or while the last position of the
    // way was still on its way to a slow Gladys: its publications are the
    // ones that say where the shutter is, and the old target and its STOP
    // state must not land over them.
    if (state.move) {
      return;
    }
    // Published after the last position of the way, never before it: Gladys
    // keeps whichever it is told last.
    await move.publishing;
    if (state.move) {
      return;
    }
    await move.publish(move.target, { done: true });
  }

  /**
   * The travel says the shutter is there: stop the motor, when it has to be
   * told. That runs before any publication — a radio order is time-critical, a
   * publication is not.
   *
   * A STOP that could not go out did not stop anything: the motor carries on
   * to the end stop of its direction, and so does the travel, from where the
   * STOP was due. Kept at the target, memory and Gladys showed 40 % while the
   * shutter was at the top, and every later positioning started from there.
   * The failure itself goes to the caller of tick (logged in `schedule`).
   */
  async arrive(device, state, move) {
    if (!move.arrive) {
      return;
    }
    // Remembered until anything else happens to the shutter, for a refusal
    // that comes back later on the callback (see `resume`).
    const landed = { move, sentBy: null };
    state.landed = landed;
    try {
      await move.arrive();
    } catch (error) {
      if (state.landed === landed) {
        this.carryOn(device, state, move);
      }
      throw error;
    }
    if (state.landed === landed) {
      landed.sentBy = this.now();
    }
  }

  /** On from the target of `move` to the end stop of its direction. */
  carryOn(device, state, move) {
    const end = move.direction === DIRECTIONS.UP ? 100 : 0;
    const travelMs = travelMsFor(device, move.direction);
    state.landed = null;
    state.move = {
      ...move,
      from: move.target,
      target: end,
      startedAt: move.endAt,
      endAt: move.endAt + (Math.abs(end - move.target) / 100) * travelMs,
      arrive: null,
      publishing: null,
      published: null,
    };
    this.schedule(device, state);
  }
}

/** A movement seen from the other end: same motor, same times. */
function mirrorMove(move) {
  move.from = move.from === null ? null : 100 - move.from;
  move.target = 100 - move.target;
  move.direction = move.direction === DIRECTIONS.UP ? DIRECTIONS.DOWN : DIRECTIONS.UP;
  // Its next tick publishes, even on the value last given in the old terms.
  move.published = null;
}

/** Linear interpolation between the start of a movement and its target. */
function positionAt(move, now) {
  const total = move.endAt - move.startedAt;
  if (total <= 0) {
    return move.target;
  }
  const ratio = Math.min(1, Math.max(0, (now - move.startedAt) / total));
  return Math.round(move.from + (move.target - move.from) * ratio);
}

/**
 * How long a full travel takes, in milliseconds, or null when the user did not
 * time this shutter. A single time configured serves both directions: most
 * motors are symmetrical, and one measurement is better than none.
 */
function travelMsFor(device, direction) {
  const up = positiveOrNull(device?.travelUp);
  const down = positiveOrNull(device?.travelDown);
  const seconds = direction === DIRECTIONS.DOWN ? (down ?? up) : (up ?? down);
  return seconds === null ? null : seconds * 1000;
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}
