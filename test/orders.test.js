import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentOrders } from '../src/devmel/orders.js';

const SHUTTER = {
  name: 'Timed shutter',
  platformId: '700-7',
  channel: { id: 700, source: 7 },
};

/** A registry whose clock the test drives itself. */
function registry() {
  let current = 1000;
  const orders = new SentOrders({ now: () => current });
  return { orders, advance: (ms) => (current += ms) };
}

/** The frame the box pushes back after a transfer, uid included. */
function echo(uid, channel = SHUTTER.channel) {
  return { type: 3, channel, thingnotes: { uid, notes: [] } };
}

test('the answer to our own transfer is recognized by its uid', () => {
  const { orders } = registry();
  orders.remember('0xabc', SHUTTER);

  const found = orders.match(echo('0xabc'));
  assert.equal(found?.name, 'Timed shutter');
  assert.equal(orders.match(echo('0xdef', { id: 900, source: 9 })), null);
});

test('the box hearing itself is recognized by the channel it emitted on', () => {
  // No uid of ours on that route: what identifies the frame is that we were
  // talking to that very device a moment ago.
  const { orders, advance } = registry();
  orders.remember('0xabc', SHUTTER);

  assert.ok(orders.match({ type: 3, channel: { id: 700, source: 7, counter: 3 } }));

  // Seconds later it is somebody's press, not our echo any more.
  advance(6000);
  assert.equal(orders.match({ type: 3, channel: { id: 700, source: 7, counter: 4 } }), null);
});

test('a wall remote emits from another address and is never taken for our echo', () => {
  const { orders } = registry();
  orders.remember('0xabc', SHUTTER);

  // Same protocol, another emitter: the whole point of `remotes`.
  assert.equal(orders.match({ type: 3, channel: { id: 700, source: 42 } }), null);
});

test('an order that can no longer echo is forgotten', () => {
  const { orders, advance } = registry();
  orders.remember('0xabc', SHUTTER);

  advance(31000);
  assert.equal(orders.match(echo('0xabc')), null);
  assert.equal(orders.entries.size, 0);
});

test('a repeated order stays one order, kept alive by its last emission', () => {
  const { orders, advance } = registry();
  orders.remember('0xabc', SHUTTER);
  advance(250);
  const entry = orders.remember('0xabc', SHUTTER);

  assert.equal(orders.entries.size, 1);
  assert.equal(entry.emissions, 2);
  advance(4900);
  // Dated from the last emission, so the echo of the repeat is recognized too.
  assert.ok(orders.match({ type: 3, channel: SHUTTER.channel }));
});

test('the registry stays bounded', () => {
  const orders = new SentOrders({ limit: 2 });
  orders.remember('0x1', SHUTTER);
  orders.remember('0x2', SHUTTER);
  orders.remember('0x3', SHUTTER);

  assert.deepEqual([...orders.entries.keys()], ['0x2', '0x3']);
});
