// -----------------------------------------------------------------------------
// The box's verdicts, charged to the orders they answer: every interleaving.
//
// With `wait: false` the box judges each emission later, on the callback, all
// the emissions of one feature under one uid. Which order a verdict is about
// depends on when it comes back — before the next order was handed over, or
// after it — and a rule written for one timing broke another: a repeat
// refused late failed the STOP after it, a carried one hid a refused STOP, a
// late GOT of the box hearing itself counted as a verdict. So rather than one
// test per timing, these enumerate them: every outcome of every emission
// (carried or refused), each verdict delivered at once or after the next
// order, through the real driver, and check what each order is reported as
// and what Gladys shows at the end against what the radio actually did.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  applyEvents,
  findBlueprintByType,
  findDeviceByExternalId,
  restoreDeviceStates,
} from '../src/devices/index.js';
import { shutter } from '../src/devices/shutter.js';
import { AirSendClient } from '../src/devmel/client.js';
import { HeardChannels } from '../src/devmel/heard.js';
import { describeEventType } from '../src/devmel/events.js';
import { NOTE_TYPES, STATE_VALUES } from '../src/devmel/notes.js';
import { SentOrders } from '../src/devmel/orders.js';
import { ShutterTravel } from '../src/devmel/travel.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeClock } from './helpers/fakeClock.js';
import { captureLogs } from './helpers/captureLogs.js';

const SENT = 1;
/** One refusal per order, all "nothing went out", so the failures name their order. */
const REFUSALS = [0x104, 0x101, 0x103];

let run = 0;

/**
 * A fresh integration around one device: real driver, real registry, a fake
 * service that records what it is handed and answers later, when told to.
 */
function rig(t, entry, { repeat, sleep = async () => {} }) {
  // A new channel each run: switch and light keep what they showed per device.
  run += 1;
  const channel = { id: 3000 + run, source: 7 };
  const gladys = createFakeGladys();
  const clock = createFakeClock();
  const config = normalizeConfig({
    devices: JSON.stringify({ devices: { Device: { ...entry, channel } } }),
    service_url: 'http://127.0.0.1:33863',
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
    command_repeat: repeat,
  });
  const device = config.devmelDevices[0];
  const blueprint = findBlueprintByType(device.rtype);
  const ids = gladys.externalIds(blueprint.key, device.platformId);
  const orders = new SentOrders({ now: clock.now });
  const client = new AirSendClient({ sleep, now: clock.now, orders });
  client.configure(config);
  const failures = [];
  const scenes = {
    orderFailed: async (_gladys, { reason }) => {
      failures.push(reason);
      return true;
    },
    remotePressed: async () => true,
  };
  const handed = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/airsend/transfer')) {
      handed.push(JSON.parse(options.body));
    }
    return { status: 200, json: async () => ({ type: 0 }) };
  };
  shutter.travel.clear();
  shutter.travel = new ShutterTravel({ now: clock.now, timers: clock.timers, tickMs: 1000 });
  shutter.scenes = scenes;

  const deliver = (events) =>
    applyEvents(gladys, config, events, new HeardChannels(), orders, scenes, client);
  return {
    gladys,
    clock,
    config,
    device,
    ids,
    client,
    handed,
    failures,
    deliver,
    send: async (key, value) => {
      await findDeviceByExternalId(gladys, config, ids.device).blueprint.onSetValue(gladys, {
        device,
        feature: { external_id: ids.feature(key) },
        value,
        client,
        callbackUrl: 'http://127.0.0.1:9999/airsend',
      });
      await client.idle();
    },
    statesOf: (key) => gladys.statesOf(ids.feature(key)),
    badge: () => client.transportOf(device)?.transport,
  };
}

/** Swap the driver's globals for the test, and put them back after. */
function isolate(t) {
  const realFetch = globalThis.fetch;
  const { travel, scenes } = shutter;
  t.after(() => {
    shutter.travel.clear();
    globalThis.fetch = realFetch;
    shutter.travel = travel;
    shutter.scenes = scenes;
  });
}

/** Every combination of `count` choices among `values`. */
function* combinations(values, count) {
  if (count === 0) {
    yield [];
    return;
  }
  for (const head of values) {
    for (const tail of combinations(values, count - 1)) {
      yield [head, ...tail];
    }
  }
}

/**
 * The box's verdicts, delivered in the order the emissions were handed over
 * — one radio — each when the plan says: `late` ones once the next order went
 * out, the others at once. A verdict never overtakes the one before it. The
 * box also hears itself after every emission it carried: a GOT with no uid,
 * delivered with the verdict, which answers no emission.
 */
function verdicts(h, plan) {
  let next = 0;
  return async (phase, { all = false } = {}) => {
    while (next < h.handed.length) {
      const body = h.handed[next];
      const { order, emission } = plan.of(next, body);
      const { carried, late } = plan.verdict(order, emission);
      if (!all && phase < order + (late ? 1 : 0)) {
        return;
      }
      next += 1;
      const notes = body.thingnotes.notes;
      await h.deliver([
        {
          type: carried ? SENT : REFUSALS[order],
          channel: body.channel,
          thingnotes: { uid: body.thingnotes.uid, notes: carried ? notes : [] },
        },
      ]);
      if (carried) {
        await h.deliver([
          {
            type: 3,
            channel: body.channel,
            thingnotes: { notes: notes.map(({ type, value }) => ({ type, value })) },
          },
        ]);
      }
    }
  };
}

/** The reason a scene reads for each order the box refused. */
const reasonOf = (order) => describeEventType(REFUSALS[order]).split(' ')[0];

/**
 * Orders given to one feature in turn, each answered by its own verdicts:
 * `outcomes[i][e]` says whether emission `e` of order `i` was carried, and
 * `lates[i][e]` whether its verdict came back only after order `i + 1` went
 * out. The device ends in the state of the last order carried.
 */
async function runOrders(t, { entry, repeat, key, initial, values, restore }, outcomes, lates) {
  const h = rig(t, entry, { repeat });
  await restoreDeviceStates(h.gladys, h.config, [
    { external_id: h.ids.device, features: restore(h.ids) },
  ]);
  const emissions = repeat + 1;
  const plan = {
    of: (index) => ({ order: Math.floor(index / emissions), emission: index % emissions }),
    verdict: (order, emission) => ({
      carried: outcomes[order][emission],
      late: lates[order][emission],
    }),
  };
  const answer = verdicts(h, plan);
  for (const [order, value] of values.entries()) {
    await h.send(key, value);
    await answer(order);
    // Faster than the box answers, slower than a double click.
    await h.clock.advance(700);
  }
  await answer(values.length, { all: true });

  const carried = outcomes.map((emitted) => emitted.some(Boolean));
  const real = values.reduce((state, value, order) => (carried[order] ? value : state), initial);
  const label = JSON.stringify({ outcomes, lates });
  assert.equal(h.handed.length, values.length * emissions, label);
  assert.equal(h.statesOf(key).at(-1), real, `${label}: shown`);
  assert.deepEqual(
    h.failures,
    carried.flatMap((went, order) => (went ? [] : [reasonOf(order)])),
    `${label}: order_failed`,
  );
  assert.equal(h.badge(), carried.at(-1) ? 'local' : 'unreachable', `${label}: badge`);
}

/** Every outcome and every timing of the verdicts of `orders` orders. */
async function everyInterleaving(t, setup, orders) {
  const emissions = setup.repeat + 1;
  const count = orders * emissions;
  for (const flat of combinations([true, false], count)) {
    const outcomes = chunk(flat, emissions);
    for (const lateFlat of combinations([false, true], count)) {
      await quietly(() => runOrders(t, setup, outcomes, chunk(lateFlat, emissions)));
    }
  }
}

/** Thousands of runs, each saying what it does at info level: kept out of the test output. */
function quietly(run) {
  return captureLogs(run).result;
}

function chunk(flat, size) {
  const chunks = [];
  for (let index = 0; index < flat.length; index += size) {
    chunks.push(flat.slice(index, index + size));
  }
  return chunks;
}

const SWITCH = {
  entry: { type: 4097 },
  key: 'on-off',
  initial: 0,
  restore: (ids) => [{ external_id: ids.feature('on-off'), last_value: 0 }],
};

const LIGHT = {
  entry: { type: 4100 },
  key: 'brightness',
  initial: 30,
  restore: (ids) => [
    { external_id: ids.feature('on-off'), last_value: 1 },
    { external_id: ids.feature('brightness'), last_value: 30 },
  ],
};

test('a switch shows the state of the last order the box carried, whatever the timing', async (t) => {
  isolate(t);
  await everyInterleaving(t, { ...SWITCH, repeat: 0, values: [1, 0, 1] }, 3);
  await everyInterleaving(t, { ...SWITCH, repeat: 1, values: [1, 0] }, 2);
  await everyInterleaving(t, { ...SWITCH, repeat: 1, values: [1, 0, 1] }, 3);
});

test('a light shows the level of the last order the box carried, whatever the timing', async (t) => {
  isolate(t);
  await everyInterleaving(t, { ...LIGHT, repeat: 0, values: [50, 70, 90] }, 3);
  await everyInterleaving(t, { ...LIGHT, repeat: 1, values: [50, 70] }, 2);
});

/**
 * A timed shutter (20 s) at 0 %: an UP and its repeats, then a STOP 400 ms
 * later — the arrival of a positioning at 2 %, or a Stop the user gives from
 * Gladys three seconds into an Open. `outcomes` and `lates` cover the UP
 * emissions, then the STOP; a late verdict comes back once the STOP went out.
 */
async function runShutter(t, { repeat, stopFromGladys }, outcomes, lates) {
  const h = rig(t, { type: 4098, travel: 20 }, { repeat });
  shutter.travel.set(h.device, 0);
  const ups = repeat + 1;
  const plan = {
    of: (index) => (index < ups ? { order: 0, emission: index } : { order: 1, emission: 0 }),
    verdict: (order, emission) => ({
      carried: outcomes[order === 0 ? emission : ups],
      late: lates[order === 0 ? emission : ups],
    }),
  };
  const answer = verdicts(h, plan);
  if (stopFromGladys) {
    await h.send('state', 1);
    await answer(0);
    await h.clock.advance(3000);
    await h.send('state', 0);
  } else {
    await h.send('position', 2);
    await answer(0);
    await h.clock.advance(400);
    await h.client.idle();
  }
  await answer(1);
  await answer(2, { all: true });
  await h.clock.advance(30000);

  const label = JSON.stringify({ stopFromGladys, repeat, outcomes, lates });
  const upCarried = outcomes.slice(0, ups).some(Boolean);
  const upJudgedEarly = !upCarried && lates.slice(0, ups).every((late) => !late);
  // Taken back at once, a positioning has no STOP left to send.
  const stopSent = stopFromGladys || !upJudgedEarly;
  const stopCarried = stopSent && outcomes[ups];
  assert.equal(h.handed.length, ups + (stopSent ? 1 : 0), label);
  const where = shutter.travel.positionOf(h.device);
  if (upCarried && stopCarried) {
    // Stopped where the travel said.
    assert.equal(where, stopFromGladys ? 15 : 2, label);
    assert.equal(h.statesOf('state').at(-1), 0, label);
  } else if (upCarried) {
    // Nothing stopped the motor: never shown stopped while it runs on.
    assert.equal(where, 100, label);
    assert.equal(h.statesOf('state').at(-1), 1, label);
  } else {
    // The motor never left the bottom.
    assert.equal(where, 0, label);
    assert.notEqual(h.statesOf('state').at(-1), 1, label);
  }
  assert.equal(h.statesOf('position').at(-1) ?? 0, where, `${label}: position shown`);
  const expected = [];
  if (!upCarried) {
    expected.push(reasonOf(0));
  }
  if (stopSent && !stopCarried) {
    expected.push(reasonOf(1));
  }
  assert.deepEqual(h.failures, expected, `${label}: order_failed`);
  const lastFailed = stopSent ? !stopCarried : !upCarried;
  assert.equal(h.badge(), lastFailed ? 'unreachable' : 'local', `${label}: badge`);
}

test('a timed positioning and its STOP are each judged on their own verdicts', async (t) => {
  isolate(t);
  for (const repeat of [0, 1]) {
    const count = repeat + 2;
    for (const outcomes of combinations([true, false], count)) {
      for (const lates of combinations([false, true], count)) {
        await quietly(() => runShutter(t, { repeat, stopFromGladys: false }, outcomes, lates));
      }
    }
  }
});

test('a Stop from Gladys the box refused leaves the shutter running, never shown stopped', async (t) => {
  isolate(t);
  for (const repeat of [0, 1]) {
    const count = repeat + 2;
    for (const outcomes of combinations([true, false], count)) {
      for (const lates of combinations([false, true], count)) {
        await quietly(() => runShutter(t, { repeat, stopFromGladys: true }, outcomes, lates));
      }
    }
  }
});

test('the box hearing itself late is no verdict: a refused STOP after it still fails', async (t) => {
  // Both UPs of a 2 % positioning answered SENT before the STOP went out,
  // the box heard the repeat only after: that GOT carries no uid, and is not
  // the STOP going out.
  isolate(t);
  const h = rig(t, { type: 4098, travel: 20 }, { repeat: 1 });
  shutter.travel.set(h.device, 0);
  await quietly(async () => {
    await h.send('position', 2);
    const [up, repeat] = h.handed;
    for (const body of [up, repeat]) {
      await h.deliver([{ type: SENT, channel: body.channel, thingnotes: body.thingnotes }]);
    }
    await h.clock.advance(400);
    await h.client.idle();
    const stop = h.handed[2];
    await h.deliver([
      {
        type: 3,
        channel: repeat.channel,
        thingnotes: { notes: repeat.thingnotes.notes.map(({ type, value }) => ({ type, value })) },
      },
    ]);
    await h.deliver([
      { type: 0x104, channel: stop.channel, thingnotes: { uid: stop.thingnotes.uid, notes: [] } },
    ]);
    await h.clock.advance(30000);
  });

  assert.equal(shutter.travel.positionOf(h.device), 100);
  assert.equal(h.statesOf('state').at(-1), 1);
  assert.deepEqual(h.failures, ['BUSY']);
  assert.equal(h.badge(), 'unreachable');
});

test('ON, OFF, ON clicked faster than the box answers, none carried, end shown OFF', async (t) => {
  isolate(t);
  const setup = { ...SWITCH, repeat: 1, values: [1, 0, 1] };
  const late = [
    [true, true],
    [true, true],
    [false, false],
  ];
  const refused = [false, false];
  // Every emission refused; then only the OFF carried.
  await quietly(() => runOrders(t, setup, [refused, refused, refused], late));
  await quietly(() => runOrders(t, setup, [refused, [true, true], refused], late));
});

test('an order refused before its repeat was dropped behind the next one is still undone', async (t) => {
  // ON, then OFF clicked while the ON was on its way: the ON's repeat comes
  // after the OFF and is dropped. The box refused the ON before the OFF went
  // out, then refuses the OFF: the plug never left OFF.
  isolate(t);
  const h = rig(t, SWITCH.entry, { repeat: 1 });
  await restoreDeviceStates(h.gladys, h.config, [
    { external_id: h.ids.device, features: SWITCH.restore(h.ids) },
  ]);
  const answered = globalThis.fetch;
  let release = null;
  globalThis.fetch = async (url, options) => {
    const response = await answered(url, options);
    if (h.handed.length === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return response;
  };
  const verdict = (body, type) => ({
    type,
    channel: body.channel,
    thingnotes: { uid: body.thingnotes.uid, notes: [] },
  });
  await quietly(async () => {
    const on = h.send('on-off', 1);
    const off = h.send('on-off', 0);
    await new Promise(setImmediate);
    await h.deliver([verdict(h.handed[0], 0x101)]);
    release();
    await Promise.all([on, off]);
    for (const body of h.handed.slice(1)) {
      await h.deliver([verdict(body, 0x104)]);
    }
  });

  assert.deepEqual(
    h.handed.map((body) => body.thingnotes.notes[0].value),
    [20, 19, 19],
  );
  assert.deepEqual(h.statesOf('on-off'), [1, 0]);
  assert.deepEqual(h.failures, ['NETWORK', 'BUSY']);
  assert.equal(h.badge(), 'unreachable');
});

/** Let every promise in flight settle, the fake clock standing still. */
async function ticks() {
  for (let i = 0; i < 30; i += 1) {
    await new Promise(setImmediate);
  }
}

/** The answer of the box to one emission handed over. */
const answerTo = (body, type) => ({
  type,
  channel: body.channel,
  thingnotes: { uid: body.thingnotes.uid, notes: [] },
});

/** The service restarting: the connection is refused, nothing was received. */
const refusedConnection = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

/** A sleep that holds the radio gap while `held()` says so: a repeat waits its turn. */
function gatedSleep() {
  const gate = { held: true, open: null };
  gate.sleep = async () => {
    if (gate.held) {
      await new Promise((resolve) => {
        gate.open = resolve;
      });
    }
  };
  gate.release = () => {
    gate.held = false;
    gate.open?.();
  };
  return gate;
}

test('an Open refused whose repeat a wall remote dropped is reported then, not with the next order', async (t) => {
  // The box refused the Open (BUSY); the STOP pressed on the wall dropped its
  // repeat. Reported with the next verdict on its uid, it came out with the
  // SENT of the Close given 10 s later: that carried Close was taken back,
  // with an order_failed and an "unreachable" badge.
  isolate(t);
  const gate = gatedSleep();
  const h = rig(
    t,
    { type: 4098, travel: 20, remotes: [{ pid: 300, addr: 99 }] },
    { repeat: 1, sleep: gate.sleep },
  );
  shutter.travel.set(h.device, 0);
  await quietly(async () => {
    const open = h.send('state', 1);
    await ticks();
    await h.clock.advance(100);
    await h.deliver([answerTo(h.handed[0], 0x104)]);
    await h.clock.advance(400);
    await h.deliver([
      {
        type: 3,
        channel: { id: 300, source: 99 },
        reliability: 32,
        thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.STOP }] },
      },
    ]);
    gate.release();
    await open;
    await ticks();
  });
  assert.equal(h.handed.length, 1);
  // Said when it was known: the Open went nowhere, the remote has the last word.
  assert.deepEqual(h.failures, ['BUSY']);
  assert.equal(h.badge(), 'local');

  await quietly(async () => {
    await h.clock.advance(10000);
    await h.send('state', -1);
    for (const body of h.handed.slice(1)) {
      await h.deliver([answerTo(body, SENT)]);
    }
    await h.clock.advance(30000);
  });
  assert.equal(shutter.travel.positionOf(h.device), 0);
  assert.equal(shutter.travel.isMoving(h.device), false);
  assert.equal(h.statesOf('state').at(-1), -1);
  assert.deepEqual(h.failures, ['BUSY']);
  assert.equal(h.badge(), 'local');
});

test('an Open refused whose repeat the restarting service refused is undone then', async (t) => {
  // The repeat never reached the service: the Open is judged on its first
  // emission, refused. Taken back right away, not with the next order's SENT.
  isolate(t);
  const gate = gatedSleep();
  const h = rig(t, { type: 4098, travel: 20 }, { repeat: 1, sleep: gate.sleep });
  shutter.travel.set(h.device, 0);
  const answered = globalThis.fetch;
  let down = false;
  globalThis.fetch = async (url, options) => {
    if (down) {
      throw refusedConnection();
    }
    return answered(url, options);
  };
  await quietly(async () => {
    const open = h.send('state', 1);
    await ticks();
    await h.clock.advance(100);
    await h.deliver([answerTo(h.handed[0], 0x104)]);
    down = true;
    gate.release();
    await open;
    await ticks();
  });
  assert.deepEqual(h.failures, ['BUSY']);
  assert.equal(h.badge(), 'unreachable');
  assert.equal(shutter.travel.positionOf(h.device), 0);
  assert.equal(shutter.travel.isMoving(h.device), false);

  await quietly(async () => {
    down = false;
    await h.clock.advance(10000);
    await h.send('state', -1);
    for (const body of h.handed.slice(1)) {
      await h.deliver([answerTo(body, SENT)]);
    }
    await h.clock.advance(30000);
  });
  assert.equal(shutter.travel.positionOf(h.device), 0);
  assert.deepEqual(h.failures, ['BUSY']);
  assert.equal(h.badge(), 'local');
});

test('an order the service never received does not replace the one before it', async (t) => {
  // ON accepted, then OFF refused twice by a restarting service: Gladys got an
  // error for the OFF, and shows ON. The box then refuses both emissions of
  // the ON: still counted as replaced by the OFF, nothing undid it.
  isolate(t);
  const h = rig(t, SWITCH.entry, { repeat: 1 });
  await restoreDeviceStates(h.gladys, h.config, [
    { external_id: h.ids.device, features: SWITCH.restore(h.ids) },
  ]);
  const answered = globalThis.fetch;
  let down = false;
  globalThis.fetch = async (url, options) => {
    if (down) {
      throw refusedConnection();
    }
    return answered(url, options);
  };
  await quietly(async () => {
    await h.send('on-off', 1);
    down = true;
    await assert.rejects(() => h.send('on-off', 0));
    for (const body of h.handed) {
      await h.deliver([answerTo(body, 0x101)]);
    }
  });
  assert.equal(h.handed.length, 2);
  assert.deepEqual(h.statesOf('on-off'), [1, 0]);
  assert.deepEqual(h.failures, ['NETWORK']);
  assert.equal(h.badge(), 'unreachable');
});

test('an order refused before the next one, which the service never received, is still undone', async (t) => {
  // ON refused, its repeat dropped behind the OFF clicked meanwhile: the ON
  // is judged when the OFF is handed over, and waits for the OFF's verdict to
  // be reported. The OFF never reaches the service: no verdict of it will
  // ever come, and the ON is reported then.
  isolate(t);
  const h = rig(t, SWITCH.entry, { repeat: 1 });
  await restoreDeviceStates(h.gladys, h.config, [
    { external_id: h.ids.device, features: SWITCH.restore(h.ids) },
  ]);
  const answered = globalThis.fetch;
  let release = null;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.thingnotes.notes[0].value === STATE_VALUES.OFF) {
      throw refusedConnection();
    }
    const response = await answered(url, options);
    if (h.handed.length === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return response;
  };
  await quietly(async () => {
    const on = h.send('on-off', 1);
    const off = h.send('on-off', 0);
    await new Promise(setImmediate);
    await h.deliver([answerTo(h.handed[0], 0x101)]);
    release();
    await on;
    await assert.rejects(off);
    await ticks();
  });
  assert.deepEqual(
    h.handed.map((body) => body.thingnotes.notes[0].value),
    [20],
  );
  assert.deepEqual(h.statesOf('on-off'), [1, 0]);
  assert.deepEqual(h.failures, ['NETWORK']);
});

test('two orders in a row the service never received still leave the refused one before them undone', async (t) => {
  // The OFF is refused by the service and waits out its retry delay; the ON
  // tapped meanwhile is refused too. Neither ever reached the box: what Gladys
  // shows again is the first ON, whose refusal must then undo it — not the
  // dead OFF put back in its place.
  isolate(t);
  const held = [];
  const sleep = (ms) => (ms >= 600 ? new Promise((resolve) => held.push(resolve)) : null);
  const h = rig(t, SWITCH.entry, { repeat: 1, sleep });
  await restoreDeviceStates(h.gladys, h.config, [
    { external_id: h.ids.device, features: SWITCH.restore(h.ids) },
  ]);
  const answered = globalThis.fetch;
  let down = false;
  globalThis.fetch = async (url, options) => {
    if (down) {
      throw refusedConnection();
    }
    return answered(url, options);
  };
  await quietly(async () => {
    await h.send('on-off', 1);
    down = true;
    // Settled as soon as they fail: both fail while the retries are let go.
    const outcome = (sent) =>
      sent.then(
        () => 'sent',
        () => 'refused',
      );
    const off = outcome(h.send('on-off', 0));
    await ticks();
    const on = outcome(h.send('on-off', 1));
    await ticks();
    while (held.length > 0) {
      held.shift()();
      await ticks();
    }
    assert.deepEqual(await Promise.all([off, on]), ['refused', 'refused']);
    for (const body of h.handed) {
      await h.deliver([answerTo(body, 0x101)]);
    }
  });
  assert.equal(h.handed.length, 2);
  assert.deepEqual(h.statesOf('on-off'), [1, 0]);
  assert.deepEqual(h.failures, ['NETWORK']);
});
