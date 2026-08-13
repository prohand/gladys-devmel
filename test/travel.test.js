import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTIONS, ShutterTravel } from '../src/devmel/travel.js';
import { createFakeClock } from './helpers/fakeClock.js';

/** A shutter that takes 20 s to open and 10 s to close. */
const SHUTTER = { platformId: 'shutter-1', travelUp: 20, travelDown: 10 };
const UNTIMED = { platformId: 'shutter-2' };

function setup() {
  const clock = createFakeClock();
  const travel = new ShutterTravel({ now: clock.now, timers: clock.timers, tickMs: 1000 });
  const positions = [];
  const publish = async (position, { done }) => {
    positions.push(done ? `${position}!` : position);
  };
  return { clock, travel, positions, publish };
}

test('a shutter with no travel time is not tracked', () => {
  const { travel, publish } = setup();
  assert.equal(travel.tracks(UNTIMED), false);
  assert.equal(travel.move(UNTIMED, { direction: DIRECTIONS.UP, publish }), false);
  assert.equal(travel.positionOf(UNTIMED), null);
});

test('an opening shutter publishes its position as it travels', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);

  travel.move(SHUTTER, { direction: DIRECTIONS.UP, publish });
  await clock.advance(5000);

  // 5 s of a 20 s travel: a quarter of the way up, one position per second.
  assert.deepEqual(positions, [5, 10, 15, 20, 25]);
  assert.equal(travel.positionOf(SHUTTER), 25);
  assert.ok(travel.isMoving(SHUTTER));
});

test('a shutter left alone lands exactly on its end stop', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);

  travel.move(SHUTTER, { direction: DIRECTIONS.UP, publish });
  await clock.advance(30000);

  // The motor stops there physically: the estimate is exact again, which is
  // what wipes the error accumulated by the previous partial travels.
  assert.equal(positions.at(-1), '100!');
  assert.equal(travel.positionOf(SHUTTER), 100);
  assert.equal(travel.isMoving(SHUTTER), false);
  assert.equal(clock.armed, 0);
});

test('a stop freezes the shutter where it had got to', async () => {
  const { clock, travel, publish } = setup();
  travel.set(SHUTTER, 100);

  // Closing takes 10 s, so 3 s of it is 30 % of the way down.
  travel.move(SHUTTER, { direction: DIRECTIONS.DOWN, publish });
  await clock.advance(3000);
  assert.equal(travel.stop(SHUTTER), 70);

  assert.equal(travel.positionOf(SHUTTER), 70);
  assert.equal(clock.armed, 0);

  // And it stays there: no timer is left to move it on.
  await clock.advance(60000);
  assert.equal(travel.positionOf(SHUTTER), 70);
});

test('a shutter told to turn around carries on from where it is', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);

  travel.move(SHUTTER, { direction: DIRECTIONS.UP, publish });
  await clock.advance(10000);
  assert.equal(travel.positionOf(SHUTTER), 50);

  positions.length = 0;
  travel.move(SHUTTER, { direction: DIRECTIONS.DOWN, publish });
  await clock.advance(5000);

  // Half a closing travel from the middle: back to the bottom, exactly.
  assert.equal(positions.at(-1), '0!');
  assert.equal(travel.positionOf(SHUTTER), 0);
});

test('a shutter at an unknown position stays unknown until an end stop', async () => {
  const { clock, travel, positions, publish } = setup();

  travel.move(SHUTTER, { direction: DIRECTIONS.UP, publish });
  await clock.advance(5000);

  // Nothing to interpolate from: better silent than invented.
  assert.deepEqual(positions, []);
  assert.equal(travel.positionOf(SHUTTER), null);

  // A full travel is assumed, and the end stop settles it.
  await clock.advance(15000);
  assert.deepEqual(positions, ['100!']);
  assert.equal(travel.positionOf(SHUTTER), 100);
});

test('a shutter told to go where it already is does not move', () => {
  const { travel, positions, publish } = setup();
  travel.set(SHUTTER, 40);

  travel.move(SHUTTER, { direction: DIRECTIONS.UP, target: 40, publish });

  assert.equal(travel.isMoving(SHUTTER), false);
  assert.deepEqual(positions, []);
  assert.equal(travel.positionOf(SHUTTER), 40);
});

test('a single travel time serves both directions', async () => {
  const { clock, travel, publish } = setup();
  const symmetrical = { platformId: 'shutter-3', travelUp: 10 };
  travel.set(symmetrical, 100);

  travel.move(symmetrical, { direction: DIRECTIONS.DOWN, publish });
  await clock.advance(5000);

  assert.equal(travel.positionOf(symmetrical), 50);
});

test('clear drops the timers of every shutter', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);
  travel.move(SHUTTER, { direction: DIRECTIONS.UP, publish });

  travel.clear();

  assert.equal(clock.armed, 0);
  await clock.advance(60000);
  assert.deepEqual(positions, []);
});
