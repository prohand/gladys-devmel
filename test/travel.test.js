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

test('a position known to be unknown is told apart from one never heard of', () => {
  const { travel } = setup();
  assert.equal(travel.knows(SHUTTER), false);

  // The motor's own favourite position: somewhere, nobody can say where.
  travel.set(SHUTTER, null);

  assert.equal(travel.positionOf(SHUTTER), null);
  assert.equal(travel.knows(SHUTTER), true);
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

test('a failed publication does not stop the tracking before the arrival', async () => {
  const { clock, travel } = setup();
  travel.set(SHUTTER, 0);
  const calls = [];
  const publish = async (position, { done }) => {
    calls.push(done ? `${position}!` : position);
    if (!done) {
      throw new Error('Gladys unreachable');
    }
  };

  travel.move(SHUTTER, { direction: DIRECTIONS.UP, target: 40, publish });
  await clock.advance(10000);

  // Every intermediate publication failed, and the arrival still came: it is
  // what stops a shutter driven to a mid-course position.
  assert.equal(calls.at(-1), '40!');
  assert.equal(travel.positionOf(SHUTTER), 40);
  assert.equal(clock.armed, 0);
});

test('the arrival does not wait for Gladys to take a position, and is published after it', async () => {
  const { clock, travel } = setup();
  travel.set(SHUTTER, 0);
  const published = [];
  let answer = null;
  let arrivedAt = null;
  const publish = async (position, { done }) => {
    if (!done && answer === null) {
      // Gladys is loaded: the first position on the way takes ages.
      await new Promise((resolve) => {
        answer = resolve;
      });
    }
    published.push(done ? `${position}!` : position);
  };

  travel.move(SHUTTER, {
    direction: DIRECTIONS.UP,
    target: 40,
    publish,
    arrive: async () => {
      arrivedAt = clock.now();
    },
  });
  await clock.advance(9000);

  // The STOP is due at 8 s, and went out at 8 s...
  assert.equal(arrivedAt, 8000);
  // ...while the arrival publication waits for the one still in flight, so
  // Gladys is not left on the older value.
  assert.deepEqual(published, []);
  answer();
  await new Promise(setImmediate);
  assert.deepEqual(published, [5, '40!']);
});

test('many shutters moving at once share what Gladys accepts, and all land', async () => {
  const { clock, travel } = setup();
  const published = [];
  const shutters = Array.from({ length: 12 }, (_, index) => ({
    platformId: `shutter-${index}`,
    travelUp: 30,
  }));
  for (const device of shutters) {
    travel.set(device, 100);
    travel.move(device, {
      direction: DIRECTIONS.DOWN,
      publish: async (position, { done }) => {
        published.push({ id: device.platformId, position, done });
      },
    });
  }
  await clock.advance(31000);

  // A dozen shutters closed by one scene, one position each per second, were
  // 360 states in 30 s: past the 300 a minute Gladys takes, and the end stops,
  // published last, were refused.
  assert.ok(published.length <= 120, `${published.length} states published`);
  for (const device of shutters) {
    const last = published.filter((entry) => entry.id === device.platformId).at(-1);
    assert.deepEqual(last, { id: device.platformId, position: 0, done: true });
  }
});

test('a STOP that could not go out leaves the shutter running to its end stop', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);

  travel.move(SHUTTER, {
    direction: DIRECTIONS.UP,
    target: 40,
    publish,
    arrive: async () => {
      throw new Error('fetch failed');
    },
  });
  await clock.advance(8000);
  // Not at 40 %: nothing stopped the motor there.
  assert.ok(travel.isMoving(SHUTTER));
  assert.equal(travel.positionOf(SHUTTER), 40);

  await clock.advance(12000);
  assert.equal(positions.at(-1), '100!');
  assert.equal(travel.positionOf(SHUTTER), 100);
});

test('a shutdown whose STOP cannot go out publishes the end stop the motor runs to', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);
  travel.move(SHUTTER, {
    direction: DIRECTIONS.UP,
    target: 40,
    publish,
    arrive: async () => {
      throw new Error('fetch failed');
    },
  });
  await clock.advance(2000);

  await travel.settle();

  // Nothing stopped the motor: the top is where it ends up, not the 10 %
  // where the STOP was attempted.
  assert.equal(positions.at(-1), '100!');
  assert.equal(travel.positionOf(SHUTTER), 100);
  assert.equal(travel.isMoving(SHUTTER), false);
  assert.equal(clock.armed, 0);
});

test('a STOP the box refuses after the arrival leaves the shutter running to its end stop', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);
  travel.move(SHUTTER, { direction: DIRECTIONS.UP, target: 40, publish, arrive: async () => {} });
  await clock.advance(8000);
  assert.equal(positions.at(-1), '40!');

  // A ping sent afterwards and refused is not that STOP.
  await clock.advance(1000);
  assert.equal(travel.resume(SHUTTER, 9000), null);
  assert.equal(travel.isMoving(SHUTTER), false);

  // With `wait: false`, the box says BUSY on the callback, after the STOP
  // sent at 8 s was accepted: nothing stopped the motor.
  assert.equal(travel.resume(SHUTTER, 8000), DIRECTIONS.UP);
  assert.ok(travel.isMoving(SHUTTER));
  assert.equal(travel.positionOf(SHUTTER), 45);
  await clock.advance(12000);
  assert.equal(positions.at(-1), '100!');
  assert.equal(travel.positionOf(SHUTTER), 100);
});

test('a STOP refused after the shutter was given another order changes nothing', async () => {
  const { clock, travel, publish } = setup();
  travel.set(SHUTTER, 0);
  travel.move(SHUTTER, { direction: DIRECTIONS.UP, target: 40, publish, arrive: async () => {} });
  await clock.advance(8000);
  travel.stop(SHUTTER);

  assert.equal(travel.resume(SHUTTER, 8000), null);
  assert.equal(travel.positionOf(SHUTTER), 40);
});

test('a Stop of ours the box refuses after it froze the shutter leaves it running', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);
  travel.move(SHUTTER, { direction: DIRECTIONS.UP, publish });
  await clock.advance(3000);
  // Gladys sends STOP 3 s into the opening: frozen at 15 %.
  assert.equal(travel.stop(SHUTTER, { sent: true }), 15);
  await clock.advance(400);

  // BUSY on the callback: nothing stopped the motor, it never paused.
  assert.equal(travel.resume(SHUTTER, 3000), DIRECTIONS.UP);
  assert.equal(travel.positionOf(SHUTTER), 17);
  await clock.advance(20000);
  assert.equal(positions.at(-1), '100!');
  assert.equal(travel.positionOf(SHUTTER), 100);

  // A STOP heard on the air is a remote's: there is no refusal of it to come.
  travel.move(SHUTTER, { direction: DIRECTIONS.DOWN, publish });
  await clock.advance(2000);
  travel.stop(SHUTTER);
  assert.equal(travel.resume(SHUTTER, clock.now()), null);
  assert.equal(travel.positionOf(SHUTTER), 80);
});

test('an Open refused once the Stop that froze it went out is taken back', async () => {
  const { clock, travel, publish } = setup();
  travel.set(SHUTTER, 0);
  travel.move(SHUTTER, { direction: DIRECTIONS.UP, publish });
  await clock.advance(3000);
  travel.stop(SHUTTER, { sent: true });

  // The UP sent at 0 never went out, the STOP did (at 3 s): never left 0 %.
  assert.equal(travel.revert(SHUTTER, 0, 3000), true);
  assert.equal(travel.positionOf(SHUTTER), 0);
  assert.equal(travel.isMoving(SHUTTER), false);
});

test('an arrival waiting for a slow publication does not land over a newer movement', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 0);
  let answer;
  travel.move(SHUTTER, {
    direction: DIRECTIONS.UP,
    target: 40,
    // Gladys takes its time over the 7 s position.
    publish: async (position, info) => {
      await publish(position, info);
      if (position === 35) {
        await new Promise((resolve) => {
          answer = resolve;
        });
      }
    },
    arrive: async () => {},
  });
  await clock.advance(8000);

  // The STOP went out on time; a wall remote then sends the shutter to the top.
  const newer = [];
  travel.move(SHUTTER, {
    direction: DIRECTIONS.UP,
    publish: async (position, { done }) => {
      newer.push(done ? `${position}!` : position);
    },
  });
  answer();
  await new Promise(setImmediate);
  await clock.advance(13000);

  // The old target (and its STOP state) never landed over the newer travel.
  assert.ok(!positions.includes('40!'), JSON.stringify(positions));
  assert.equal(newer.at(-1), '100!');
});

test('a shutter mirrored while it moves ends its travel in the new terms', async () => {
  const { clock, travel, positions, publish } = setup();
  const symmetrical = { platformId: 'shutter-3', travelUp: 20 };
  travel.set(symmetrical, 0);
  travel.move(symmetrical, { direction: DIRECTIONS.UP, publish });
  await clock.advance(5000);

  travel.mirror(symmetrical);

  // Still moving, a quarter of the way, seen from the other end.
  assert.ok(travel.isMoving(symmetrical));
  assert.equal(travel.positionOf(symmetrical), 75);
  await clock.advance(15000);
  assert.equal(positions.at(-1), '0!');
  assert.equal(travel.positionOf(symmetrical), 0);
});

test('a shutdown waits for an arrival whose STOP is still on its way to the radio', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 100);
  let carried;
  travel.move(SHUTTER, {
    direction: DIRECTIONS.DOWN,
    target: 40,
    publish,
    arrive: () =>
      new Promise((resolve) => {
        carried = resolve;
      }),
  });
  await clock.advance(6000);
  assert.equal(travel.isMoving(SHUTTER), false);

  let settled = false;
  const settling = travel.settle().then(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  // The service is not stopped under the STOP.
  assert.equal(settled, false);

  carried();
  await settling;
  assert.equal(positions.at(-1), '40!');
});

test('a shutdown whose in-flight STOP then fails publishes the end stop the motor runs to', async () => {
  const { clock, travel, positions, publish } = setup();
  travel.set(SHUTTER, 100);
  let refuse;
  travel.move(SHUTTER, {
    direction: DIRECTIONS.DOWN,
    target: 40,
    publish,
    arrive: () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  });
  await clock.advance(6000);

  const settling = travel.settle();
  refuse(new Error('ECONNREFUSED'));
  await settling;
  travel.clear();

  assert.equal(positions.at(-1), '0!');
  assert.equal(travel.positionOf(SHUTTER), 0);
  assert.equal(travel.isMoving(SHUTTER), false);
  assert.equal(clock.armed, 0);
});

test('a STOP refused after a mirror carries the shutter on in the new terms', async () => {
  const { clock, travel, positions, publish } = setup();
  const symmetrical = { platformId: 'shutter-4', travelUp: 20 };
  travel.set(symmetrical, 0);
  travel.move(symmetrical, {
    direction: DIRECTIONS.UP,
    target: 40,
    publish,
    arrive: async () => {},
  });
  await clock.advance(8000);
  travel.mirror(symmetrical);
  assert.equal(travel.positionOf(symmetrical), 60);

  assert.equal(travel.resume(symmetrical, 8000), DIRECTIONS.DOWN);
  await clock.advance(12000);
  assert.equal(positions.at(-1), '0!');
});
