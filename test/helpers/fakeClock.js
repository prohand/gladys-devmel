// -----------------------------------------------------------------------------
// A clock the tests drive by hand.
//
// The position of a shutter is a function of time (see src/devmel/travel.js):
// testing it against the real clock would mean waiting for real seconds and
// hoping the machine is not busy. This replaces both the clock and the timers,
// so a twenty-second travel is asserted instantly and deterministically.
// -----------------------------------------------------------------------------

export function createFakeClock() {
  let current = 0;
  let nextId = 1;
  const pending = new Map();

  const clock = {
    /** Injected into ShutterTravel as `now`. */
    now: () => current,

    /** Injected into ShutterTravel as `timers`. */
    timers: {
      set(callback, delay) {
        const id = nextId;
        nextId += 1;
        pending.set(id, { at: current + delay, callback });
        return id;
      },
      clear(id) {
        pending.delete(id);
      },
    },

    /** Timers still armed, to assert that nothing keeps ticking. */
    get armed() {
      return pending.size;
    },

    /** Move time forward, running every timer that falls due on the way. */
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const next = due(target);
        if (!next) {
          break;
        }
        const [id, timer] = next;
        pending.delete(id);
        current = timer.at;
        timer.callback();
        // The timer callback starts an async chain (publish, then re-arm):
        // let it settle before looking at what it scheduled.
        await drain();
      }
      current = target;
    },
  };

  function due(target) {
    let earliest = null;
    for (const entry of pending.entries()) {
      if (entry[1].at <= target && (!earliest || entry[1].at < earliest[1].at)) {
        earliest = entry;
      }
    }
    return earliest;
  }

  return clock;
}

/** Let every pending microtask run. */
function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}
