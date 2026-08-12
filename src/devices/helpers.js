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
 * timestamp — not the arrival time — is what the history must record.
 */
export async function publishState(gladys, featureExternalId, value, createdAt) {
  await gladys.publishState(
    featureExternalId,
    createdAt ? { state: value, created_at: createdAt } : value,
  );
}
