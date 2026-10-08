// -----------------------------------------------------------------------------
// The listening subscription and its renewal timer, armed one at a time.
//
// Arming listening is asynchronous (read the protocol table, bind every box)
// and is asked for from several places at once: a configuration saved, the
// Gladys Plus relay changing, the widget button, a scene action. Arming used to
// clear the renewal timer, await the binding, then start a new one — so two
// requests in flight each started their own, and the first was overwritten
// without being cleared: a ten-minute interval nothing could stop, not the
// disconnection, not the shutdown. And a request still binding when Gladys
// disconnected armed its timer AFTER `stop()` had run.
//
// So the requests are queued, and a timer is only armed by the request that is
// still the latest one when its binding completes.
// -----------------------------------------------------------------------------

const REAL_TIMERS = {
  set(callback, delay) {
    const handle = setInterval(callback, delay);
    // Do not hold the event loop open just to renew a subscription.
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearInterval(handle);
  },
};

/**
 * @param {object} options
 * @param {() => void} options.renew what the timer runs (must not throw)
 * @param {number} options.intervalMs renewal interval
 * @param {{ set: Function, clear: Function }} [options.timers] injectable
 */
export function createListenLoop({ renew, intervalMs, timers = REAL_TIMERS }) {
  let timer = null;
  let generation = 0;
  let chain = Promise.resolve();

  function clear() {
    if (timer) {
      timers.clear(timer);
      timer = null;
    }
  }

  return {
    /**
     * Arm listening: run `arm`, then renew every `intervalMs` when it says so.
     *
     * @param {() => Promise<boolean>} arm binds the boxes; resolves true when
     *   there is a subscription worth renewing
     */
    start(arm) {
      const run = chain.then(async () => {
        clear();
        generation += 1;
        const mine = generation;
        const renewable = await arm();
        // A newer request, or a stop, came in while this one was binding.
        if (renewable && mine === generation) {
          timer = timers.set(renew, intervalMs);
        }
      });
      chain = run.catch(() => {});
      return run;
    },

    /** Stop renewing, including for a request still binding. */
    stop() {
      generation += 1;
      clear();
    },

    /** True while a renewal timer is armed. */
    get armed() {
      return timer !== null;
    },
  };
}
