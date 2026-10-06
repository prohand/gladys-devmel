// -----------------------------------------------------------------------------
// Small helpers shared by every device module.
// -----------------------------------------------------------------------------

/**
 * Build the Gladys external ids of a Devmel device. The blueprint key is the
 * "type" part (`switch`, `shutter`…) and the AirSend id/channel the platform
 * part, so ids stay stable as long as the user does not renumber their
 * hardware.
 */
export function idsFor(gladys, blueprintKey, device) {
  return gladys.externalIds(blueprintKey, device.platformId);
}

/**
 * Send notes to a device and publish the resulting states.
 *
 * Radio commands are fire-and-forget by default (a 433 MHz shutter never
 * acknowledges), so `has_feedback` is false on those features and the value we
 * just sent is the value Gladys shows — unless the device is bound and the box
 * pushes the confirmation back, in which case the state is refreshed again.
 */
export async function sendNotes(client, device, notes, options = {}) {
  return client.transfer(device, notes, {
    uid: options.uid ?? device.platformId,
    wait: options.wait ?? device.wait,
    callbackUrl: options.callbackUrl,
  });
}

/** `true` when the value published by Gladys means "on". */
export function isOn(value) {
  return Number(value) > 0;
}

/**
 * Publish one feature state, dating it when it comes from a radio event.
 *
 * Events relayed by Gladys Plus can arrive late or out of order, so the box
 * timestamp — not the arrival time — is what the history of a SENSOR records.
 *
 * LIVE_STATE: never what a shutter, a switch or a light publishes. Gladys
 * files a dated state as a past one, and only makes it the current value when
 * it is newer than the one it holds. Those devices are also published by the
 * integration itself — an order from Gladys, every step of a shutter travel —
 * stamped with the clock of the Gladys host. A box clock a few seconds behind
 * it, or a frame relayed a bit late, and the press of the wall remote went to
 * the history only: the shutter moved, Gladys kept showing where it was before.
 */
export async function publishState(gladys, featureExternalId, value, createdAt) {
  await gladys.publishState(
    featureExternalId,
    createdAt ? { state: value, created_at: createdAt } : value,
  );
}
