import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  applyEvents,
  configureDevices,
  findBlueprintByType,
  findDeviceByExternalId,
  restoreDeviceStates,
} from '../src/devices/index.js';
import { shutter } from '../src/devices/shutter.js';
import { GROUP_SETTLE_MS, ShutterGroups } from '../src/devices/shutterGroups.js';
import { NOTE_TYPES, STATE_VALUES } from '../src/devmel/notes.js';
import { HeardChannels } from '../src/devmel/heard.js';
import { SentOrders } from '../src/devmel/orders.js';
import { ShutterTravel } from '../src/devmel/travel.js';
import { toThingUid } from '../src/devmel/client.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeClient } from './helpers/fakeAirSend.js';
import { createFakeClock } from './helpers/fakeClock.js';

const OPEN = 1;
const STOPPED = 0;
const CLOSED = -1;

// The house of the forum thread, smaller: two shutters on the south side, one
// on the west side, every motor paired with its side's group and with the
// general one. The groups are emitters of their own (pid 13920, RFY).
const HOUSE = {
  Everything: { type: 4098, channel: { id: 13920, source: 100 } },
  South: { type: 4098, channel: { id: 13920, source: 101 }, remotes: [100] },
  West: { type: 4098, channel: { id: 13920, source: 102 }, remotes: [100] },
  'South 1': { type: 4098, channel: { id: 13920, source: 1 }, remotes: [101, 100] },
  'South 2': { type: 4098, channel: { id: 13920, source: 2 }, remotes: [101, 100] },
  'West 1': { type: 4098, channel: { id: 13920, source: 3 }, remotes: [102, 100] },
};

function setup(t, devices = HOUSE) {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({ devices }),
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
  });
  const client = createFakeClient({ config });
  const clock = createFakeClock();
  const previousTravel = shutter.travel;
  const previousGroups = shutter.groups;
  shutter.travel = new ShutterTravel({ now: clock.now, timers: clock.timers, tickMs: 1000 });
  shutter.groups = new ShutterGroups({
    clock: () => shutter.travel,
    refresh: previousGroups.refresh,
  });
  t.after(() => {
    shutter.groups.cancel();
    shutter.travel.clear();
    shutter.travel = previousTravel;
    shutter.groups = previousGroups;
  });
  configureDevices(config);

  const deviceOf = (name) => config.devmelDevices.find((device) => device.name === name);
  const externalIdOf = (name) =>
    `${findBlueprintByType(deviceOf(name).rtype).key}:${deviceOf(name).platformId}`;
  const send = async (name, key, value) => {
    const found = findDeviceByExternalId(gladys, config, externalIdOf(name));
    await found.blueprint.onSetValue(gladys, {
      device: found.device,
      feature: { external_id: `${externalIdOf(name)}:${key}` },
      value,
      client,
    });
  };
  /** Someone presses the wall remote (or the group remote) of `name`. */
  const press = (name, value, orders) =>
    applyEvents(
      gladys,
      config,
      [
        {
          type: 3,
          channel: deviceOf(name).channel,
          thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
        },
      ],
      new HeardChannels(),
      orders,
    );
  const statesOf = (name) => gladys.statesOf(`${externalIdOf(name)}:state`);
  const positionsOf = (name) => gladys.statesOf(`${externalIdOf(name)}:position`);
  return {
    gladys,
    config,
    client,
    clock,
    send,
    press,
    statesOf,
    positionsOf,
    deviceOf,
    externalIdOf,
  };
}

test('a group is made of the shutters that list it in their remotes, through the groups in between', (t) => {
  const { deviceOf } = setup(t);
  const names = (group) =>
    shutter.groups
      .members(deviceOf(group))
      .map((device) => device.name)
      .sort();

  assert.deepEqual(names('South'), ['South 1', 'South 2']);
  assert.deepEqual(names('West'), ['West 1']);
  // The shutters only, never the groups listed under it.
  assert.deepEqual(names('Everything'), ['South 1', 'South 2', 'West 1']);
  assert.equal(shutter.groups.isGroup(deviceOf('South 1')), false);
});

test('a group listed only by the groups under it still has their shutters', (t) => {
  const { deviceOf } = setup(t, {
    Everything: { type: 4098, channel: { id: 13920, source: 100 } },
    South: { type: 4098, channel: { id: 13920, source: 101 }, remotes: [100] },
    'South 1': { type: 4098, channel: { id: 13920, source: 1 }, remotes: [101] },
    'South 2': { type: 4098, channel: { id: 13920, source: 2 }, remotes: [101] },
  });

  assert.deepEqual(
    shutter.groups
      .members(deviceOf('Everything'))
      .map((device) => device.name)
      .sort(),
    ['South 1', 'South 2'],
  );
});

test('a remote declared by its protocol alone makes nobody a group', (t) => {
  const { deviceOf } = setup(t, {
    Gate: { type: 4098, channel: { id: 14177 } },
    Shutter: { type: 4098, channel: { id: 14177, source: 5 }, remotes: [{ pid: 14177 }] },
  });

  assert.equal(shutter.groups.isGroup(deviceOf('Gate')), false);
});

test('groups that list each other do not loop', (t) => {
  const { deviceOf } = setup(t, {
    A: { type: 4098, channel: { id: 900, source: 1 }, remotes: [2] },
    B: { type: 4098, channel: { id: 900, source: 2 }, remotes: [1] },
    Shutter: { type: 4098, channel: { id: 900, source: 3 }, remotes: [1] },
  });

  assert.deepEqual(
    shutter.groups.members(deviceOf('A')).map((device) => device.name),
    ['Shutter'],
  );
});

test('every shutter raised one by one opens their groups, without a word on the air', async (t) => {
  const { client, clock, press, statesOf } = setup(t);
  for (const name of ['South 1', 'South 2', 'West 1']) {
    await press(name, STATE_VALUES.DOWN);
  }
  await clock.advance(GROUP_SETTLE_MS);
  assert.deepEqual(statesOf('Everything'), [CLOSED]);

  for (const name of ['South 1', 'South 2', 'West 1']) {
    await press(name, STATE_VALUES.UP);
  }
  await clock.advance(GROUP_SETTLE_MS);

  assert.deepEqual(statesOf('South'), [CLOSED, OPEN]);
  assert.deepEqual(statesOf('West'), [CLOSED, OPEN]);
  assert.deepEqual(statesOf('Everything'), [CLOSED, OPEN]);
  // Computed, never transmitted.
  assert.equal(client.sent.length, 0);
});

test('one shutter lowered leaves its groups neither open nor closed', async (t) => {
  const { clock, press, statesOf } = setup(t);
  for (const name of ['South 1', 'South 2', 'West 1']) {
    await press(name, STATE_VALUES.UP);
  }
  await clock.advance(GROUP_SETTLE_MS);

  await press('South 1', STATE_VALUES.DOWN);
  await clock.advance(GROUP_SETTLE_MS);

  assert.deepEqual(statesOf('South'), [OPEN, STOPPED]);
  assert.deepEqual(statesOf('Everything'), [OPEN, STOPPED]);
  // The west side did not move: nothing more to say about it.
  assert.deepEqual(statesOf('West'), [OPEN]);
});

test('a group shows nothing until each of its shutters has shown something', async (t) => {
  const { clock, press, statesOf } = setup(t);
  await press('South 1', STATE_VALUES.UP);
  await clock.advance(GROUP_SETTLE_MS);

  assert.deepEqual(statesOf('South'), []);
  assert.deepEqual(statesOf('Everything'), []);
});

test('a group ordered from Gladys is not shown "stopped" while its shutters follow it', async (t) => {
  const { config, client, clock, send, press, statesOf } = setup(t);
  for (const name of ['South 1', 'South 2', 'West 1']) {
    await press(name, STATE_VALUES.UP);
  }
  await clock.advance(GROUP_SETTLE_MS);
  const orders = new SentOrders({ now: clock.now });

  await send('Everything', 'state', CLOSED);
  const last = client.sent.at(-1);
  orders.remember(toThingUid(last.options.uid), config.devmelDevices[0], {
    notes: last.notes,
    fresh: true,
  });
  // The box hears itself on the group's address: every shutter follows.
  await press('Everything', STATE_VALUES.DOWN, orders);
  await clock.advance(GROUP_SETTLE_MS);

  assert.deepEqual(statesOf('Everything'), [OPEN, CLOSED]);
  assert.deepEqual(statesOf('South'), [OPEN, CLOSED]);
});

test('a timed group shows the average position, and travels from where its shutters are', async (t) => {
  const timed = { travel: 20 };
  const { clock, send, press, statesOf, positionsOf, deviceOf, client } = setup(t, {
    South: { type: 4098, ...timed, channel: { id: 13920, source: 101 } },
    'South 1': { type: 4098, ...timed, channel: { id: 13920, source: 1 }, remotes: [101] },
    'South 2': { type: 4098, ...timed, channel: { id: 13920, source: 2 }, remotes: [101] },
  });
  // The group went down last time it was ordered.
  await send('South', 'state', CLOSED);
  await clock.advance(21000);
  assert.equal(shutter.travel.positionOf(deviceOf('South')), 0);

  // Both raised by hand, one after the other.
  await press('South 1', STATE_VALUES.UP);
  await press('South 2', STATE_VALUES.UP);
  await clock.advance(21000 + GROUP_SETTLE_MS);

  assert.equal(statesOf('South').at(-1), OPEN);
  assert.equal(positionsOf('South').at(-1), 100);
  assert.equal(shutter.travel.positionOf(deviceOf('South')), 100);

  // "South to 50 %" goes DOWN, not UP to shutters already at the top.
  const before = client.sent.length;
  await send('South', 'position', 50);
  assert.equal(client.noteAt(before).value, STATE_VALUES.DOWN);
});

test('a timed group whose shutters are apart shows their average and has no position to travel from', async (t) => {
  const timed = { travel: 20 };
  const { clock, press, statesOf, positionsOf, deviceOf } = setup(t, {
    South: { type: 4098, ...timed, channel: { id: 13920, source: 101 } },
    'South 1': { type: 4098, ...timed, channel: { id: 13920, source: 1 }, remotes: [101] },
    'South 2': { type: 4098, ...timed, channel: { id: 13920, source: 2 }, remotes: [101] },
  });
  await press('South 1', STATE_VALUES.UP);
  await press('South 2', STATE_VALUES.DOWN);
  await clock.advance(21000 + GROUP_SETTLE_MS);

  assert.equal(statesOf('South').at(-1), STOPPED);
  assert.equal(positionsOf('South').at(-1), 50);
  assert.equal(shutter.travel.positionOf(deviceOf('South')), null);
});

test('the groups start from what Gladys kept for their shutters', async (t) => {
  const { gladys, config, clock, press, statesOf, externalIdOf } = setup(t);
  const kept = (name, state) => ({
    external_id: externalIdOf(name),
    features: [{ external_id: `${externalIdOf(name)}:state`, last_value: state }],
  });
  await restoreDeviceStates(gladys, config, [
    kept('South 1', OPEN),
    kept('South 2', OPEN),
    kept('West 1', OPEN),
    kept('Everything', CLOSED),
  ]);

  await press('West 1', STATE_VALUES.UP);
  await clock.advance(GROUP_SETTLE_MS);

  assert.deepEqual(statesOf('Everything'), [OPEN]);
});
