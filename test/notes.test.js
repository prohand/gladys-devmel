import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  decodeNotes,
  isSameChannel,
  levelNote,
  NOTE_METHODS,
  NOTE_TYPES,
  queryNote,
  READINGS,
  stateNote,
  STATE_VALUES,
} from '../src/devmel/notes.js';

test('notes are built with the method and type the box expects', () => {
  assert.deepEqual(stateNote(STATE_VALUES.UP), {
    method: NOTE_METHODS.SET,
    type: NOTE_TYPES.STATE,
    value: 35,
  });
  assert.deepEqual(levelNote(42), {
    method: NOTE_METHODS.SET,
    type: NOTE_TYPES.LEVEL,
    value: 42,
  });
  assert.deepEqual(queryNote('TEMPERATURE'), {
    method: NOTE_METHODS.QUERY,
    type: 'TEMPERATURE',
  });
});

test('levels are clamped to the 0-100 range of the protocol', () => {
  assert.equal(levelNote(-10).value, 0);
  assert.equal(levelNote(120).value, 100);
  assert.equal(levelNote('55.4').value, 55);
});

test('a temperature note is Kelvin, published in Celsius', () => {
  assert.deepEqual(decodeNotes([{ type: NOTE_TYPES.TEMPERATURE, value: 294.35 }]), [
    { kind: READINGS.TEMPERATURE, value: 21.2 },
  ]);
});

test('ON/OFF and UP/DOWN states are decoded as a level', () => {
  const readings = decodeNotes([
    { type: NOTE_TYPES.STATE, value: 'ON' },
    { type: NOTE_TYPES.STATE, value: STATE_VALUES.OFF },
    { type: NOTE_TYPES.STATE, value: STATE_VALUES.UP },
    { type: NOTE_TYPES.STATE, value: STATE_VALUES.DOWN },
  ]);
  assert.deepEqual(
    readings.map((reading) => reading.value),
    [100, 0, 100, 0],
  );
  assert.ok(readings.every((reading) => reading.kind === READINGS.LEVEL));
});

test('the other notes keep their own kind', () => {
  assert.deepEqual(
    decodeNotes([
      { type: NOTE_TYPES.STATE, value: STATE_VALUES.TOGGLE },
      { type: NOTE_TYPES.STATE, value: STATE_VALUES.STOP },
      { type: NOTE_TYPES.R_HUMIDITY, value: '63' },
      { type: NOTE_TYPES.ILLUMINANCE, value: 1450.6 },
      { type: NOTE_TYPES.LEVEL, value: 30 },
    ]),
    [
      { kind: READINGS.TOGGLE, value: 'TOGGLE' },
      { kind: READINGS.STATE, value: 'stop', command: COMMANDS.STOP },
      { kind: READINGS.HUMIDITY, value: 63 },
      { kind: READINGS.ILLUMINANCE, value: 1451 },
      { kind: READINGS.LEVEL, value: 30 },
    ],
  );
});

test('a movement order is told apart from a position the hardware reported', () => {
  const [up, down, stop, favorite, on, level] = decodeNotes([
    { type: NOTE_TYPES.STATE, value: STATE_VALUES.UP },
    { type: NOTE_TYPES.STATE, value: STATE_VALUES.CLOSE },
    { type: NOTE_TYPES.STATE, value: STATE_VALUES.STOP },
    { type: NOTE_TYPES.STATE, value: STATE_VALUES.USERPOSITION },
    { type: NOTE_TYPES.STATE, value: STATE_VALUES.ON },
    { type: NOTE_TYPES.LEVEL, value: 100 },
  ]);

  // An order says where the device is going...
  assert.equal(up.command, COMMANDS.UP);
  assert.equal(down.command, COMMANDS.DOWN);
  assert.equal(stop.command, COMMANDS.STOP);
  assert.equal(favorite.command, COMMANDS.FAVORITE);
  // ...a level says where it is, and so does the ON of a switch.
  assert.equal(on.command, undefined);
  assert.equal(level.command, undefined);
  assert.equal(up.value, 100);
  assert.equal(level.value, 100);
});

test('unreadable notes are ignored instead of crashing the event loop', () => {
  assert.deepEqual(decodeNotes(null), []);
  assert.deepEqual(decodeNotes([null, 'nope', { type: 42, value: 1 }]), []);
});

test('a channel is identified by its id and its source', () => {
  assert.ok(isSameChannel({ id: 1, source: 2 }, { id: '1', source: '2', counter: 9 }));
  assert.ok(!isSameChannel({ id: 1, source: 2 }, { id: 1, source: 3 }));
  assert.ok(!isSameChannel(null, { id: 1 }));
});
