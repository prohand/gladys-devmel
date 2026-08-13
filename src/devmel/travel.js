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

/** How often a moving shutter publishes its position, in milliseconds. */
export const DEFAULT_TICK_MS = 1000;

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
   * @returns {boolean} false when this shutter has no travel time configured
   */
  move(device, { direction, target, publish }) {
    const travelMs = travelMsFor(device, direction);
    if (travelMs === null) {
      return false;
    }
    const state = this.stateOf(device);
    // Where we start from is where we are right now — mid-course included, so
    // reversing a movement does not lose the ground already covered.
    const from = this.positionOf(device);
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
      state = { position: null, move: null, handle: null };
      this.states.set(device.platformId, state);
    }
    return state;
  }

  cancel(state) {
    if (state.handle) {
      this.timers.clear(state.handle);
      state.handle = null;
    }
    state.move = null;
  }

  /**
   * Arm the next position publication. The delay is the tick, or what is left
   * of the travel when that is shorter, so the shutter lands on its end stop at
   * the very moment the motor does.
   */
  schedule(device, state) {
    const remaining = state.move.endAt - this.now();
    const delay = Math.max(0, Math.min(this.tickMs, remaining));
    state.handle = this.timers.set(() => {
      this.tick(device, state).catch(() => {
        // The publication failed (Gladys unreachable): the movement keeps
        // running, the next tick will carry the position.
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
      await move.publish(move.target, { done: true });
      return;
    }

    // Mid-course: only a shutter whose starting point was known has an
    // intermediate position worth publishing.
    if (move.from !== null) {
      await move.publish(positionAt(move, this.now()), { done: false });
    }
    // The movement may have been replaced while the publication was awaited.
    if (state.move === move) {
      this.schedule(device, state);
    }
  }
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
