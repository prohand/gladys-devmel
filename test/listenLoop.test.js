import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListenLoop } from '../src/devmel/listenLoop.js';

/** Interval timers the test can count. */
function fakeTimers() {
  const live = new Set();
  let next = 1;
  return {
    live,
    set() {
      const id = next;
      next += 1;
      live.add(id);
      return id;
    },
    clear(id) {
      live.delete(id);
    },
  };
}

/** An `arm` the test resolves by hand, like a bind waiting on the box. */
function deferredArm() {
  let release;
  const arm = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  return { arm, release: (value) => release(value) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('two requests in flight leave ONE renewal timer', async () => {
  const timers = fakeTimers();
  const loop = createListenLoop({ renew: () => {}, intervalMs: 600000, timers });

  const first = deferredArm();
  const second = deferredArm();
  const a = loop.start(first.arm);
  const b = loop.start(second.arm);
  await tick();
  first.release(true);
  await a;
  await tick();
  second.release(true);
  await b;

  assert.equal(timers.live.size, 1);
  loop.stop();
  assert.equal(timers.live.size, 0);
});

test('a stop while binding leaves no timer behind', async () => {
  const timers = fakeTimers();
  const loop = createListenLoop({ renew: () => {}, intervalMs: 600000, timers });

  const pending = deferredArm();
  const run = loop.start(pending.arm);
  await tick();
  // Gladys disconnected while the box was still being bound.
  loop.stop();
  pending.release(true);
  await run;

  assert.equal(timers.live.size, 0);
  assert.equal(loop.armed, false);
});

test('nothing to renew arms nothing, and a failed bind does not block the next', async () => {
  const timers = fakeTimers();
  const loop = createListenLoop({ renew: () => {}, intervalMs: 600000, timers });

  await loop.start(async () => false);
  assert.equal(timers.live.size, 0);

  await assert.rejects(
    loop.start(async () => {
      throw new Error('box unreachable');
    }),
  );
  await loop.start(async () => true);
  assert.equal(timers.live.size, 1);
  loop.stop();
});
