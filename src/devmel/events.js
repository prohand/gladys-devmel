// -----------------------------------------------------------------------------
// AirSend events: what comes back once an order has been handed to the box.
//
// A transfer sent `wait: true` is answered with the event itself; one sent
// `wait: false` has it pushed to the bind callback a moment later (see
// callback.js). Either way the event carries a `type`, and that number is the
// whole verdict:
//
//   0 PENDING   the box took the order, nothing on the air yet
//   1 SENT      it went out
//   2 ACK       it went out, and something acknowledged it
//   3 GOT       a frame came in (the answer to a read, a remote someone pressed)
//
//   >= 0x100    it did not happen, and the rest of the number says why
//
// The error table is Devmel's own, spelled the same way in their Jeedom plugin
// (`UNKNOWN, NETWORK, SYNCHRONIZATION, SECURITY, BUSY, TIMEOUT, UNSUPPORTED,
// INCOMPLETE, FULL`, indexed from 0x100) and in the Domoticz plug-in, which
// names each constant one by one. So `type: 258` is not "the box could not
// transmit": it is SYNCHRONIZATION, an exchange with the box that lost its
// thread.
//
// Why that deserves a module of its own: these codes say WHERE an order died,
// and the answers they call for are opposite. A refused connection string or a
// channel the box cannot transmit is a configuration to fix. A link that lost
// its thread is a box doing something else at that moment. And NONE of them is
// a frame lost in the noise — the one failure repeating an order answers —
// because a frame lost in the noise is exactly the failure nothing reports:
// nothing acknowledges a radio order, so an order the box says it carried is
// all the confirmation there will ever be. Sending a user to "Command repeats"
// for an error the box itself reported sends them to the one setting that
// cannot help, and, since repeats leave closer together, to a box slightly
// busier than the one that just failed.
// -----------------------------------------------------------------------------

/** Below this, an event reports something that happened. From it, a failure. */
export const FIRST_ERROR_TYPE = 0x100;

/** `type` of an event that went well. */
export const EVENT_TYPES = {
  PENDING: 0,
  SENT: 1,
  ACK: 2,
  GOT: 3,
};

/** `type` of an event that reports a failure. */
export const EVENT_ERRORS = {
  UNKNOWN: 0x100,
  NETWORK: 0x101,
  SYNCHRONIZATION: 0x102,
  SECURITY: 0x103,
  BUSY: 0x104,
  TIMEOUT: 0x105,
  UNSUPPORTED: 0x106,
  INCOMPLETE: 0x107,
  FULL: 0x108,
};

/**
 * What each failure means, and what the user can do about it.
 *
 * `carried` is the honest half: `false` when the order provably never reached
 * the air (the box refused the request before transmitting anything), `null`
 * when there is no telling. Claiming "nothing moved" about a link that dropped
 * mid-exchange is a guess, and a user who reads it while the lamp IS on stops
 * believing the log.
 *
 * `permanent` marks the failures a second attempt answers exactly the same way:
 * a rejected connection string stays rejected.
 */
const FAILURES = {
  [EVENT_ERRORS.UNKNOWN]: {
    name: 'UNKNOWN',
    carried: null,
    what: 'the box refused the order without saying why',
    advice:
      'If it comes back, restart the box, then the integration: a service that lost its box ' +
      'answers this way until both are back in step.',
  },
  [EVENT_ERRORS.NETWORK]: {
    name: 'NETWORK',
    carried: false,
    what: 'the AirSend Web Service could not reach the box at all',
    advice:
      'Check the box is powered and on the network, and that the address in its connection ' +
      'string is still the one it answers on — a box that took a new IP address from the box ' +
      'of the house answers nowhere else.',
  },
  [EVENT_ERRORS.SYNCHRONIZATION]: {
    name: 'SYNCHRONIZATION',
    carried: null,
    what:
      'the exchange between the AirSend Web Service and the box lost its thread — a link ' +
      'error, not a radio one',
    advice:
      'Check nothing else drives the box at the same moment (the AirSend app, a Home ' +
      'Assistant or Jeedom still pointed at it, a second Gladys): it serves one conversation ' +
      'at a time. A box on a weak Wi-Fi link answers this way too.',
  },
  [EVENT_ERRORS.SECURITY]: {
    name: 'SECURITY',
    carried: false,
    what: 'the box refused the connection string',
    advice:
      'Export it again from airsend.cloud (Import/Export) and paste it whole in the ' +
      'configuration: a password changed in the AirSend app invalidates the one exported ' +
      'before it.',
  },
  [EVENT_ERRORS.BUSY]: {
    name: 'BUSY',
    carried: false,
    what: 'another client had the box locked',
    advice:
      'Something else was driving it (the AirSend app, another home automation): two orders ' +
      'cannot share one radio. Close the app, or take the box out of the other installation.',
  },
  [EVENT_ERRORS.TIMEOUT]: {
    name: 'TIMEOUT',
    carried: null,
    what: 'the box did not answer in time',
    advice:
      'A box busy transmitting for someone else, or one whose Wi-Fi link is weak where it ' +
      'stands. Where it stands is the half you can change.',
  },
  [EVENT_ERRORS.UNSUPPORTED]: {
    name: 'UNSUPPORTED',
    carried: false,
    what: 'the box does not know how to send this',
    advice:
      'The channel or the order is not one it can transmit: check the "type" and the channel ' +
      'declared for this device against the airsend.cloud export they came from.',
  },
  [EVENT_ERRORS.INCOMPLETE]: {
    name: 'INCOMPLETE',
    carried: false,
    what: 'the box found the request incomplete',
    advice:
      'The channel of this device is missing something: paste it whole from the ' +
      'airsend.cloud export, with everything it came with next to "id" and "source".',
  },
  [EVENT_ERRORS.FULL]: {
    name: 'FULL',
    carried: false,
    what: 'the request was too large for the box',
    advice: 'Report it: nothing this integration sends should ever be that long.',
  },
};

/** Failures a second attempt is answered exactly the same way. */
const PERMANENT = new Set([
  EVENT_ERRORS.SECURITY,
  EVENT_ERRORS.UNSUPPORTED,
  EVENT_ERRORS.INCOMPLETE,
  EVENT_ERRORS.FULL,
]);

const EVENT_NAMES = Object.fromEntries(
  [...Object.entries(EVENT_TYPES), ...Object.entries(EVENT_ERRORS)].map(([name, type]) => [
    type,
    name,
  ]),
);

/** Does this event report a failure rather than something that happened? */
export function isErrorEvent(type) {
  return Number(type ?? 0) >= FIRST_ERROR_TYPE;
}

/**
 * An event type as a log reads best: its name, and the number it came as.
 * A type Devmel has added since is printed as the number alone rather than
 * guessed at.
 */
export function describeEventType(type) {
  const code = Number(type ?? 0);
  const name = EVENT_NAMES[code];
  return name ? `${name} (event type ${code})` : `event type ${code}`;
}

/**
 * What a failing event says, in full.
 *
 * @param {number} type the `type` of the event
 * @returns {{code: number, name: ?string, carried: ?boolean, what: string,
 *   advice: string, permanent: boolean}}
 */
export function describeFailure(type) {
  const code = Number(type ?? 0);
  const known = FAILURES[code];
  return {
    code,
    name: known?.name ?? null,
    carried: known ? known.carried : null,
    what: known?.what ?? 'the box refused the order',
    advice: known?.advice ?? 'Nothing known describes this code; report it with the log line.',
    permanent: PERMANENT.has(code),
  };
}

/** Is this failure worth sending the same order again? */
export function isPermanentFailure(type) {
  return PERMANENT.has(Number(type ?? 0));
}

/**
 * The failure as a user reads it: what happened, whether anything moved, and
 * what to do about it. Shared by the two routes a failure comes back on — the
 * answer to a `wait: true` transfer and the echo pushed to the callback — so
 * the same code never gets explained two different ways.
 */
export function explainFailure(type) {
  const failure = describeFailure(type);
  const moved =
    failure.carried === false
      ? 'Nothing went out on the air.'
      : 'Whether anything went out on the air, nothing says.';
  return (
    `${describeEventType(type)}: ${failure.what}. ${moved} ${failure.advice} ` +
    'Repeating the order answers a frame lost in the noise, which is the failure nothing ' +
    'reports — not this one, which the box reported.'
  );
}
