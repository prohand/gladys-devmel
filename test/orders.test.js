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
  // No uid of ours on that route: what identifies the frame is the address it
  // was emitted from, which is the one Gladys transmits on.
  const { orders, advance } = registry();
  orders.remember('0xabc', SHUTTER);

  assert.ok(orders.match({ type: 3, channel: { id: 700, source: 7, counter: 3 } }));

  // And a box that takes its time repeating itself is still that box. Reading
  // a late echo as a fresh order is what sent a shutter stopped at 40 % to the
  // top, seconds after it got there.
  advance(60000);
  const late = orders.match({ type: 3, channel: { id: 700, source: 7, counter: 4 } });
  assert.equal(late?.name, 'Timed shutter');
});

test('a voice is only ours once we have spoken with it', () => {
  const { orders } = registry();

  // Nothing sent yet: a frame on that channel is somebody else emitting.
  assert.equal(orders.match({ type: 3, channel: SHUTTER.channel }), null);

  orders.remember('0xabc', SHUTTER);
  assert.ok(orders.match({ type: 3, channel: SHUTTER.channel }));
  // A channel we never transmitted on stays a stranger, whatever we sent.
  assert.equal(orders.match({ type: 3, channel: { id: 700, source: 8 } }), null);
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
  // The order itself is gone — what is left is the voice it was said with,
  // which is not a memory of an order and is kept longer (a minute).
  assert.equal(orders.match(echo('0xabc', { id: 900, source: 9 })), null);
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

test('a voice is ours for a minute, then a remote sharing it is followed again', () => {
  // A device declared with the very address of its remote (a remote copied into
  // the AirSend app) speaks with that voice too: an hour after a single order
  // from Gladys, its presses used to be taken for echoes and dropped.
  const { orders, advance } = registry();
  orders.remember('0xabc', SHUTTER);

  advance(60000);
  assert.ok(orders.match({ type: 3, channel: SHUTTER.channel }));
  advance(1);
  assert.equal(orders.match({ type: 3, channel: SHUTTER.channel }), null);

  // Spoken with again: ours again, for another minute.
  orders.remember('0xdef', SHUTTER);
  advance(30000);
  assert.ok(orders.match({ type: 3, channel: SHUTTER.channel }));
});

test('verdicts still owed to the order before are its own, not the next one', () => {
  // ON, then OFF 0.8 s later, under the same uid: the box answers the ON's
  // emissions first, and refusing them says nothing about the OFF.
  const { orders, advance } = registry();
  // Each emission handed to the service is remembered: the order, its repeat.
  const on = orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 2 });
  orders.remember('0xabc', SHUTTER);
  const onSince = on.since;
  advance(800);
  orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 2 });
  orders.remember('0xabc', SHUTTER);
  const order = orders.match(echo('0xabc'));

  assert.equal(orders.settle(order, 0x101).failed, false);
  const first = orders.settle(order, 0x101);
  assert.equal(first.failed, true);
  assert.equal(first.superseded, true);
  assert.equal(first.since, onSince);
  assert.equal(first.until, order.since);

  // The OFF's own verdicts come next.
  assert.equal(orders.settle(order, 0x101).failed, false);
  const second = orders.settle(order, 0x101);
  assert.equal(second.failed, true);
  assert.equal(second.superseded, false);
  assert.equal(second.since, order.since);
});

test('an order keeps every verdict of its own, carried or refused', () => {
  // A 2 % positioning: UP and its repeat, the STOP 400 ms later, all under
  // the uid of the position feature.
  const { orders, advance } = registry();
  const up = orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 2 });
  const upSince = up.since;
  orders.remember('0xabc', SHUTTER);
  const order = orders.match(echo('0xabc'));
  assert.equal(orders.settle(order, 1).failed, false);
  advance(400);
  orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 1 });

  // The repeat refused after the STOP went out is the UP's: the UP went out.
  const repeat = orders.settle(order, 0x104);
  assert.equal(repeat.failed, false);
  assert.equal(repeat.since, upSince);
  // The STOP carried is the STOP's, and nothing failed.
  assert.equal(orders.settle(order, 1).failed, false);

  // And the other way round: both UPs carried, answered after the STOP went
  // out, then the STOP refused — that refusal is the STOP's, and it failed.
  advance(5000);
  orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 2 });
  orders.remember('0xabc', SHUTTER);
  advance(400);
  const next = orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 1 });
  assert.equal(orders.settle(order, 1).failed, false);
  assert.equal(orders.settle(order, 1).failed, false);
  const refused = orders.settle(order, 0x104);
  assert.equal(refused.failed, true);
  assert.equal(refused.superseded, false);
  assert.equal(refused.since, next.since);
});

test('a PENDING is no verdict yet: the one on that emission is still to come', () => {
  const { orders } = registry();
  orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 1 });
  const order = orders.match(echo('0xabc'));
  // PENDING: taken, not sent yet. The verdict on that emission is still owed.
  assert.equal(orders.settle(order, 0).failed, false);
  const verdict = orders.settle(order, 0x104);
  assert.equal(verdict.failed, true);
  assert.equal(verdict.since, order.since);
});

test('an order the box judged before it was known nothing more of it would go out', () => {
  // ON refused, then OFF given before the ON's repeat got its turn: the repeat
  // is dropped, so the ON failed — said with the next verdict on its uid.
  const { orders, advance } = registry();
  const on = orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 2 });
  const onSince = on.since;
  const order = orders.match(echo('0xabc'));
  assert.equal(orders.settle(order, 0x101).failed, false);
  advance(300);
  orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 2 });
  orders.remember('0xabc', SHUTTER);

  const verdict = orders.settle(order, 1);
  assert.equal(verdict.failed, false);
  assert.equal(verdict.earlier.length, 1);
  assert.equal(verdict.earlier[0].failed, true);
  assert.equal(verdict.earlier[0].superseded, true);
  assert.equal(verdict.earlier[0].since, onSince);
  assert.equal(verdict.earlier[0].type, 0x101);
  assert.deepEqual(orders.settle(order, 1).earlier, []);
});

test('an order answered, or replaced long after it went out, is owed nothing', () => {
  const { orders, advance } = registry();
  // Its SENT came back: the next refusal is the next order's.
  const order = orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 1 });
  orders.settle(order, 1);
  orders.remember('0xabc', SHUTTER, { fresh: true, emissions: 1 });
  assert.equal(orders.settle(order, 0x104).superseded, false);

  // An 8 s positioning whose UP was never answered: the refusal of its STOP
  // is the STOP's, not the UP's.
  orders.remember('0xdef', SHUTTER, { fresh: true, emissions: 1 });
  advance(8000);
  const stop = orders.remember('0xdef', SHUTTER, { fresh: true, emissions: 1 });
  const verdict = orders.settle(stop, 0x104);
  assert.equal(verdict.superseded, false);
  assert.equal(verdict.failed, true);

  // Nor an order the transfer itself answered (`wait: true`).
  orders.remember('0x123', SHUTTER, { fresh: true, emissions: 1, wait: true });
  const next = orders.remember('0x123', SHUTTER, { fresh: true, emissions: 1 });
  assert.equal(orders.settle(next, 0x104).superseded, false);
});

test('a late echo of a group order is that order, not the one given since', () => {
  const { orders, advance } = registry();
  const DOWN = [{ method: 1, type: 0, value: 34 }];
  const STOP = [{ method: 1, type: 0, value: 17 }];
  orders.remember('0xabc', SHUTTER, { notes: DOWN, fresh: true });
  const heardDown = [{ type: 0, value: 34 }];
  assert.equal(orders.follows(orders.match(echo('0xabc')), 'member', heardDown), true);
  advance(3000);
  orders.remember('0xabc', SHUTTER, { notes: STOP, fresh: true });

  // The DOWN heard late is the DOWN, already followed; the STOP is still news.
  assert.equal(orders.follows(orders.match(echo('0xabc')), 'member', heardDown), false);
  assert.equal(
    orders.follows(orders.match(echo('0xabc')), 'member', [{ type: 0, value: 17 }]),
    true,
  );
});
