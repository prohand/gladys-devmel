// -----------------------------------------------------------------------------
// Stand-in for the AirSend driver: records the notes the device modules send,
// and answers with the notes a test wants the box to have replied.
// -----------------------------------------------------------------------------

export function createFakeClient({ answers = [], config = {} } = {}) {
  const sent = [];
  const queue = [...answers];

  return {
    sent,
    config,

    async transfer(device, notes, options = {}) {
      // Like the real client: an order that no longer applies by its turn is
      // dropped unsent (here, its turn is now).
      if (options.stale?.()) {
        return { transport: null, degraded: false, notes: [], dropped: true };
      }
      sent.push({ device: device.name, notes, options });
      return {
        transport: 'local',
        degraded: false,
        notes: queue.length > 0 ? queue.shift() : [],
      };
    },

    canUseLocal() {
      return true;
    },

    transportOf() {
      return undefined;
    },

    /** The single note of the nth transfer, for one-note commands. */
    noteAt(index) {
      return sent[index]?.notes[0];
    },
  };
}
