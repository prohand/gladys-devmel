// -----------------------------------------------------------------------------
// Arming the listening subscription, one attempt at a time.
//
// Which protocol to bind is decided in listening.js; this is the doing of it:
// plan, bind every box, and say what came of it. Each attempt — the arm asked
// for by a configuration, the widget or a scene, the ten-minute renewal, the
// rebind after an order — returns its OWN outcome, and index.js only stores it
// once the attempt is over.
//
// It used to write a state shared by every attempt as it went: an arm cleared
// it before binding, so a re-arm queued behind another read the other one's
// blank state and answered "no route" for a bind that had worked; and a
// renewal never cleared it, so once one bind had worked, a box unplugged for an
// hour was still "frames pushed to …" in every report.
// -----------------------------------------------------------------------------

import { createLogger } from '../logging.js';
import { boxDevices } from './connection.js';
import { planListening } from './listening.js';

const logger = createLogger();

/**
 * A full arm: plan from the configuration and the channel table, then bind.
 *
 * @param {object} options
 * @param {object} options.config normalized configuration
 * @param {Map<number, object>} options.table channel table (may be empty)
 * @param {?string} options.callbackUrl where the frames must be pushed
 * @param {object} options.client the AirSend client (`bind`)
 * @returns {Promise<{ plan: object, url: ?string, error: ?string,
 *   renewable: boolean }>} what this attempt did, and whether a subscription
 *   is worth renewing
 */
export async function armListening({ config, table, callbackUrl, client }) {
  const plan = planListening(config, table);
  const outcome = { plan, url: null, error: null, renewable: false };

  if (!plan.enabled) {
    logger.info('Listening disabled (listening channel set to 0)');
    return outcome;
  }
  if (!callbackUrl) {
    logger.info('No route for the radio frames -> sensors are refreshed by polling only');
    return outcome;
  }
  const boxes = boxDevices(config);
  if (boxes.length === 0) {
    // Nothing to bind through: without a connection string there is no box to
    // ask, and a renewal timer would bind nothing every ten minutes.
    logger.info('No AirSend box to listen through: paste the sp:// connection string first');
    return outcome;
  }
  if (plan.fallback) {
    // Binding still happens: generic 433 MHz is the only useful guess before
    // anything is declared. But it is a default, and a default that cannot
    // hear an 868 MHz remote at all — which is indistinguishable, from the
    // outside, from a listener that was never armed.
    logger.warn(
      `No radio device declared: listening to generic 433 MHz (channel ${plan.channel}). ` +
        'An 868 MHz protocol (Profalux, Somfy io) is not heard on it -> declare a device on it, ' +
        'or set the listening channel to its pid.',
    );
  }

  Object.assign(outcome, await bindBoxes({ client, boxes, channel: plan.channel, callbackUrl }));
  announceBlindSpots(plan, outcome.url);
  // Renewed even when every box refused: a box that reboots, or comes back on
  // the network, takes the next renewal.
  outcome.renewable = true;
  return outcome;
}

/**
 * A renewal (the ten-minute timer, the rebind after an order): bind again,
 * with a plan made again.
 *
 * The plan is a function of the configuration and of the channel table, and
 * the table is the part that can change underneath: read while the service
 * was still booting, it was empty, the plan fell back to the raw pids, and
 * every renewal kept binding that fallback after the service came back.
 *
 * @param {object} options as `armListening`, plus
 * @param {?object} options.plan the plan currently bound
 * @returns {Promise<?{ plan: object, url: ?string, error: ?string }>} null
 *   when there was nothing to renew
 */
export async function renewListening({ config, table, plan, callbackUrl, client }) {
  if (!plan?.enabled || !callbackUrl) {
    return null;
  }
  const fresh = planListening(config, table);
  const boxes = boxDevices(config);
  if (!fresh.enabled || !(fresh.channel > 0) || boxes.length === 0) {
    return null;
  }
  // A new channel is news, and so is what it leaves out: said like an arm.
  const changed = fresh.channel !== plan.channel;
  const bound = await bindBoxes({
    client,
    boxes,
    channel: fresh.channel,
    callbackUrl,
    renewal: !changed,
  });
  if (changed) {
    announceBlindSpots(fresh, bound.url);
  }
  return { plan: fresh, ...bound };
}

/**
 * Ask every box to forward the frames it hears on `channel`.
 *
 * @returns {Promise<{ url: ?string, error: ?string }>} this round's outcome:
 *   the route when at least one box took the subscription, the last refusal
 *   when none did
 */
export async function bindBoxes({ client, boxes, channel, callbackUrl, renewal = false }) {
  let url = null;
  let error = null;
  if (!callbackUrl || !(channel > 0)) {
    return { url, error };
  }
  for (const box of boxes) {
    try {
      await client.bind(channel, callbackUrl, box);
      url = callbackUrl;
      // A renewal says nothing new: it repeats, every ten minutes and after
      // every order, a line the user already read when listening was armed.
      logger[renewal ? 'debug' : 'info'](
        `Listening on channel ${channel} through "${box.name}" -> ${callbackUrl}`,
      );
    } catch (err) {
      error = err.message;
      logger.warn(`Could not listen through "${box.name}": ${err.message}`);
    }
  }
  // One box listening is listening: the refusal of another is in the logs.
  return { url, error: url ? null : error };
}

/**
 * What a re-arm (widget button, scene action) answers, read from its OWN
 * attempt: the channel listened to, or why there is none.
 *
 * @param {?object} outcome what `armListening` returned for this re-arm, null
 *   when the request was cancelled before it ran
 * @param {object} config normalized configuration
 * @returns {number} the channel listened to
 */
export function rearmedChannel(outcome, config) {
  if (!outcome) {
    throw new Error('Listening was stopped before it could be armed (Gladys disconnected)');
  }
  if (!outcome.plan?.enabled) {
    throw new Error('Listening is turned off (listening channel set to 0)');
  }
  if (boxDevices(config).length === 0) {
    // Said as what it is: "no route" sent the user after a relay that was
    // working, when what is missing is the connection string.
    throw new Error('No AirSend box to listen through: paste the sp:// connection string first');
  }
  if (outcome.error) {
    throw new Error(`The box refused the subscription: ${outcome.error}`);
  }
  if (!outcome.url) {
    throw new Error('No route for the radio frames: nothing to bind');
  }
  return outcome.plan.channel;
}

/**
 * What the protocol just bound will NOT bring back.
 *
 * The box has one radio and listens to one protocol at a time, so every choice
 * of channel is also a list of things that will never be heard again. Until now
 * that list only existed in the "Test the connection" report — a screen nobody
 * opens while everything looks fine — and its absence is what makes a perfectly
 * armed listener indistinguishable from a broken one.
 */
function announceBlindSpots(plan, url) {
  if (!plan?.enabled || !url) {
    return;
  }
  for (const device of plan.uncovered) {
    logger.warn(
      `"${device.name}" speaks protocol ${device.channel?.id}, not the ${plan.channel} the box ` +
        'listens to: nothing it emits will be heard. One radio, one protocol at a time.',
    );
  }
  for (const { device, remote } of plan.unheardRemotes) {
    logger.warn(
      `The remote declared on "${device.name}" (pid ${remote.id}) speaks another protocol than ` +
        `the ${plan.channel} the box listens to: pressing it will do nothing in Gladys. Fill in ` +
        `${remote.id} as the listening channel to hear it instead.`,
    );
  }
  if (plan.echoOnly) {
    // The silence this explains is total: the box is listening, the route works,
    // and nothing will ever come through it — because nothing declared on that
    // protocol ever speaks first.
    logger.info(
      `Nothing declared on channel ${plan.channel} emits by itself: shutters, switches and lamps ` +
        'are talked to, they do not talk. The box will hear the echo of Gladys own orders and ' +
        'nothing else. A wall remote has its own protocol and its own address: press it, then ' +
        'run "Attach a remote" — if nothing turns up, the box is not listening to ITS protocol.',
    );
  }
}
