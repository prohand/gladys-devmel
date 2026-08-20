import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeEventType,
  describeFailure,
  EVENT_ERRORS,
  EVENT_TYPES,
  explainFailure,
  isErrorEvent,
  isPermanentFailure,
} from '../src/devmel/events.js';

test('the event table is the one Devmel spells out in its own plugins', () => {
  // Read off the Jeedom plugin (`UNKNOWN,NETWORK,SYNCHRONIZATION,SECURITY,BUSY,
  // TIMEOUT,UNSUPPORTED,INCOMPLETE,FULL`, indexed from 0x100) and the Domoticz
  // plug-in, which names each constant. A wrong number here turns a link error
  // into "your radio is out of range".
  assert.equal(EVENT_TYPES.SENT, 1);
  assert.equal(EVENT_TYPES.GOT, 3);
  assert.equal(EVENT_ERRORS.SYNCHRONIZATION, 258);
  assert.equal(EVENT_ERRORS.BUSY, 260);
  assert.equal(EVENT_ERRORS.FULL, 264);

  assert.equal(describeEventType(3), 'GOT (event type 3)');
  assert.equal(describeEventType(258), 'SYNCHRONIZATION (event type 258)');
});

test('an event says whether it reports a failure', () => {
  assert.equal(isErrorEvent(3), false);
  assert.equal(isErrorEvent(undefined), false);
  assert.equal(isErrorEvent(256), true);
  assert.equal(isErrorEvent(264), true);
});

test('a failure says whether anything reached the air, and never guesses', () => {
  // The honest half. A request the box refused before transmitting moved
  // nothing; a link that dropped mid-exchange says nothing either way, and a
  // log that claims "nothing moved" while the lamp is on stops being read.
  assert.equal(describeFailure(EVENT_ERRORS.NETWORK).carried, false);
  assert.equal(describeFailure(EVENT_ERRORS.SECURITY).carried, false);
  assert.equal(describeFailure(EVENT_ERRORS.SYNCHRONIZATION).carried, null);
  assert.equal(describeFailure(EVENT_ERRORS.TIMEOUT).carried, null);
});

test('a code Devmel adds later is printed, not invented', () => {
  const failure = describeFailure(0x1ff);
  assert.equal(failure.name, null);
  assert.equal(describeEventType(0x1ff), 'event type 511');
  assert.match(explainFailure(0x1ff), /report it/i);
});

test('only the failures a second attempt cannot change are permanent', () => {
  assert.equal(isPermanentFailure(EVENT_ERRORS.SECURITY), true);
  assert.equal(isPermanentFailure(EVENT_ERRORS.UNSUPPORTED), true);
  assert.equal(isPermanentFailure(EVENT_ERRORS.SYNCHRONIZATION), false);
  assert.equal(isPermanentFailure(EVENT_ERRORS.BUSY), false);
});

test('every failure is explained, and none of them sends the user to the repeats', () => {
  for (const type of Object.values(EVENT_ERRORS)) {
    const line = explainFailure(type);
    assert.match(line, new RegExp(`event type ${type}`));
    assert.doesNotMatch(line, /raise "Command repeats"/);
    // Every one of them ends on the same correction: an order the box reported
    // on is not an order lost in the noise, which is all repeats answer.
    assert.match(line, /Repeating the order answers a frame lost in the noise/);
  }
});
