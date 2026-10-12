import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from '../src/config.js';
import {
  applyEvents,
  buildDiscoveredDevices,
  buildTransportEntries,
  findBlueprintByType,
  findDeviceByExternalId,
  identifyDevice,
  replayDeviceStates,
  restoreDeviceStates,
  stopDeviceTracking,
  stopDueIn,
} from '../src/devices/index.js';
import { shutter } from '../src/devices/shutter.js';
import { isRadioFailure } from '../src/devices/helpers.js';
import { describeFate } from '../src/devmel/connection.js';
import { resetSensorClicks, sensor } from '../src/devices/sensor.js';
import { resetGatewayReads } from '../src/devices/gateway.js';
import { NOTE_TYPES, READINGS, STATE_VALUES } from '../src/devmel/notes.js';
import { AirSendClient, toThingUid } from '../src/devmel/client.js';
import { HeardChannels } from '../src/devmel/heard.js';
import { SentOrders } from '../src/devmel/orders.js';
import { ShutterTravel } from '../src/devmel/travel.js';
import { SceneEvents } from '../src/capabilities/scenes.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeClient } from './helpers/fakeAirSend.js';
import { createFakeClock } from './helpers/fakeClock.js';
import { captureLogs } from './helpers/captureLogs.js';

const DEVICES = JSON.stringify({
  devices: {
    'AirSend box': { type: 0, sensors: true },
    'Silent box': { type: 0 },
    Garage: { type: 4096, channel: { id: 100, source: 1 } },
    'Kitchen plug': { type: 4097, channel: { id: 200, source: 2 } },
    'Living room shutter': { type: 4098, channel: { id: 300, source: 3 } },
    'Bedroom shutter': { type: 4099, invert: true, channel: { id: 400, source: 4 } },
    'Pergola light': { type: 4100, channel: { id: 500, source: 5 } },
    'Outdoor sensor': {
      type: 1,
      features: ['temperature', 'humidity'],
      channel: { id: 600, source: 6 },
    },
  },
});

function setup() {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: DEVICES,
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
  });
  const client = createFakeClient({ config });
  return { gladys, config, client };
}

function deviceNamed(config, name) {
  return config.devmelDevices.find((device) => device.name === name);
}

function deviceExternalId(config, name) {
  const device = deviceNamed(config, name);
  return `${findBlueprintByType(device.rtype).key}:${device.platformId}`;
}

function featureOf(gladys, config, name, key) {
  return { external_id: `${deviceExternalId(config, name)}:${key}` };
}

test('every configured device becomes a Gladys device, except a box with no sensor', () => {
  const { gladys, config } = setup();
  const devices = buildDiscoveredDevices(gladys, config);

  assert.deepEqual(
    devices.map((device) => device.name),
    [
      'AirSend box',
      'Garage',
      'Kitchen plug',
      'Living room shutter',
      'Bedroom shutter',
      'Pergola light',
      'Outdoor sensor',
    ],
  );

  // Every feature carries a unique external id derived from the AirSend channel.
  const externalIds = devices.flatMap((device) => device.features.map((f) => f.external_id));
  assert.equal(new Set(externalIds).size, externalIds.length);
});

test('every feature carries a min and a max, which Gladys refuses to store as null', () => {
  const { gladys, config } = setup();
  for (const device of buildDiscoveredDevices(gladys, config)) {
    for (const feature of device.features) {
      assert.equal(typeof feature.min, 'number', `${device.name} / ${feature.name}: min`);
      assert.equal(typeof feature.max, 'number', `${device.name} / ${feature.name}: max`);
    }
  }
});

test('only the positionable shutter exposes a position', () => {
  const { gladys, config } = setup();
  const devices = buildDiscoveredDevices(gladys, config);
  const types = (name) =>
    devices.find((device) => device.name === name).features.map((feature) => feature.type);

  assert.deepEqual(types('Living room shutter'), ['state']);
  assert.deepEqual(types('Bedroom shutter'), ['state', 'position']);
  assert.deepEqual(types('Pergola light'), ['binary', 'brightness']);
  assert.deepEqual(types('Outdoor sensor'), ['decimal', 'integer']);
});

test('a command is turned into the matching radio note', async () => {
  const { gladys, config, client } = setup();
  const send = async (name, key, value) => {
    const found = findDeviceByExternalId(gladys, config, deviceExternalId(config, name));
    await found.blueprint.onSetValue(gladys, {
      device: found.device,
      feature: featureOf(gladys, config, name, key),
      value,
      client,
    });
  };

  await send('Kitchen plug', 'on-off', 1);
  assert.deepEqual(client.noteAt(0), {
    method: 1,
    type: NOTE_TYPES.STATE,
    value: STATE_VALUES.ON,
  });

  await send('Garage', 'push', 1);
  assert.equal(client.noteAt(1).value, STATE_VALUES.TOGGLE);

  await send('Living room shutter', 'state', 1);
  assert.equal(client.noteAt(2).value, STATE_VALUES.UP);

  await send('Living room shutter', 'state', 0);
  assert.equal(client.noteAt(3).value, STATE_VALUES.STOP);

  // `invert: true` swaps the two orders: this shutter opens by going down.
  await send('Bedroom shutter', 'state', 1);
  assert.equal(client.noteAt(4).value, STATE_VALUES.DOWN);

  await send('Bedroom shutter', 'position', 30);
  assert.deepEqual(client.noteAt(5), { method: 1, type: NOTE_TYPES.LEVEL, value: 70 });
});

test('switching a light on restores the last brightness', async () => {
  const { gladys, config, client } = setup();
  const found = findDeviceByExternalId(gladys, config, 'light:500-5');
  const brightness = featureOf(gladys, config, 'Pergola light', 'brightness');
  const onOff = featureOf(gladys, config, 'Pergola light', 'on-off');

  await found.blueprint.onSetValue(gladys, {
    device: found.device,
    feature: brightness,
    value: 40,
    client,
  });
  await found.blueprint.onSetValue(gladys, {
    device: found.device,
    feature: onOff,
    value: 0,
    client,
  });
  await found.blueprint.onSetValue(gladys, {
    device: found.device,
    feature: onOff,
    value: 1,
    client,
  });

  assert.deepEqual(client.noteAt(1), {
    method: 1,
    type: NOTE_TYPES.STATE,
    value: STATE_VALUES.OFF,
  });
  assert.deepEqual(client.noteAt(2), { method: 1, type: NOTE_TYPES.LEVEL, value: 40 });
  assert.deepEqual(gladys.statesOf(onOff.external_id), [1, 0, 1]);
});

test('the box is published with a poll frequency Gladys accepts', () => {
  const { gladys, config } = setup();
  const found = findDeviceByExternalId(gladys, config, 'gateway:airsend-box');
  const device = found.blueprint.buildDevice(gladys, found.device);
  // `refresh` defaults to 300 s: published as is, Gladys rejected the whole
  // discovery batch.
  assert.equal(device.poll_frequency, 60000);
  assert.equal(device.should_poll, true);
});

test('the box polls inside the refresh interval read nothing', async () => {
  resetGatewayReads();
  const { gladys, config } = setup();
  const client = createFakeClient({
    config,
    answers: [
      [{ type: NOTE_TYPES.TEMPERATURE, value: 294.35 }],
      [{ type: NOTE_TYPES.ILLUMINANCE, value: 320 }],
      [{ type: NOTE_TYPES.TEMPERATURE, value: 295.35 }],
      [{ type: NOTE_TYPES.ILLUMINANCE, value: 330 }],
    ],
  });
  const found = findDeviceByExternalId(gladys, config, 'gateway:airsend-box');
  await found.blueprint.onPoll(gladys, { device: found.device, client, now: 0 });
  await found.blueprint.onPoll(gladys, { device: found.device, client, now: 60_000 });
  assert.equal(client.sent.length, 2, 'one minute later: skipped');
  await found.blueprint.onPoll(gladys, { device: found.device, client, now: 300_000 });
  assert.equal(client.sent.length, 4, 'after the refresh interval: read again');
});

test('a box poll that read nothing is tried again at the next tick', async () => {
  resetGatewayReads();
  const { gladys, config } = setup();
  const client = createFakeClient({ config });
  let down = true;
  const transfer = client.transfer;
  client.transfer = async (...args) => {
    if (down) {
      client.sent.push({ failed: true });
      throw new Error('box unreachable');
    }
    return transfer(...args);
  };
  const found = findDeviceByExternalId(gladys, config, 'gateway:airsend-box');

  await found.blueprint.onPoll(gladys, { device: found.device, client, now: 0 });
  assert.equal(client.sent.length, 2);

  // The box is back a minute later: no need to wait for the whole interval.
  down = false;
  await found.blueprint.onPoll(gladys, { device: found.device, client, now: 60_000 });
  assert.equal(client.sent.length, 4);

  // And a successful read is the one the interval counts from.
  await found.blueprint.onPoll(gladys, { device: found.device, client, now: 120_000 });
  assert.equal(client.sent.length, 4);
});

test('a box created in Gladys is read at once, inside its refresh interval', async () => {
  resetGatewayReads();
  const { gladys, config } = setup();
  const client = createFakeClient({
    config,
    answers: [
      [{ type: NOTE_TYPES.TEMPERATURE, value: 294.35 }],
      [{ type: NOTE_TYPES.ILLUMINANCE, value: 320 }],
      [{ type: NOTE_TYPES.TEMPERATURE, value: 295.35 }],
      [{ type: NOTE_TYPES.ILLUMINANCE, value: 330 }],
    ],
  });
  const found = findDeviceByExternalId(gladys, config, 'gateway:airsend-box');
  // Read before the device existed in Gladys: those states were dropped.
  await found.blueprint.onPoll(gladys, { device: found.device, client });

  await replayDeviceStates(gladys, { external_id: 'gateway:airsend-box' }, { config, client });

  assert.equal(client.sent.length, 4);
  assert.deepEqual(gladys.statesOf('gateway:airsend-box:illuminance'), [320, 330]);
});

test('the box sensors are read by polling', async () => {
  resetGatewayReads();
  const { gladys, config } = setup();
  const client = createFakeClient({
    config,
    answers: [
      [{ type: NOTE_TYPES.TEMPERATURE, value: 294.35 }],
      [{ type: NOTE_TYPES.ILLUMINANCE, value: 320 }],
    ],
  });
  const found = findDeviceByExternalId(gladys, config, 'gateway:airsend-box');

  await found.blueprint.onPoll(gladys, { device: found.device, client });

  assert.deepEqual(gladys.statesOf('gateway:airsend-box:temperature'), [21.2]);
  assert.deepEqual(gladys.statesOf('gateway:airsend-box:illuminance'), [320]);
  // A read must wait for the answer, otherwise the box replies to the callback.
  assert.ok(client.sent.every((call) => call.options.wait === true));
});

test('a radio frame updates the device sharing its channel', async () => {
  const { gladys, config } = setup();
  const applied = await applyEvents(gladys, config, [
    {
      type: 3,
      reliability: 0x20,
      timestamp: 1700000000000,
      channel: { id: 600, source: 6, counter: 12 },
      thingnotes: {
        notes: [
          { type: NOTE_TYPES.TEMPERATURE, value: 280.65 },
          { type: NOTE_TYPES.R_HUMIDITY, value: 71 },
        ],
      },
    },
  ]);

  assert.equal(applied, 1);
  assert.deepEqual(gladys.published, [
    {
      featureExternalId: 'sensor:600-6:temperature',
      state: { state: 7.5, created_at: '2023-11-14T22:13:20.000Z' },
    },
    {
      featureExternalId: 'sensor:600-6:humidity',
      state: { state: 71, created_at: '2023-11-14T22:13:20.000Z' },
    },
  ]);
});

test('with listening turned off, a frame still pushed by the box moves nothing', async () => {
  // The subscription made before the user set the listening channel to 0
  // outlives the change: the box keeps pushing what it hears.
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: DEVICES,
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
    listen_channel: '0',
  });
  const registry = new HeardChannels();
  const applied = await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        reliability: 0x20,
        timestamp: 1700000000000,
        channel: { id: 600, source: 6, counter: 12 },
        thingnotes: { notes: [{ type: NOTE_TYPES.TEMPERATURE, value: 280.65 }] },
      },
    ],
    registry,
    new SentOrders(),
  );

  assert.equal(applied, 0);
  assert.deepEqual(gladys.published, []);
});

test('the wall remote of a shutter drives it like Gladys does', async () => {
  // The AirSend emits on the shutter's protocol from its own address; the
  // remote screwed on the wall emits on the same protocol from another one.
  // Declared as a remote, it moves the same Gladys device.
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: {
        'Living room shutter': {
          type: 4098,
          travel: 20,
          channel: { id: 300, source: 3 },
          remotes: [42],
        },
      },
    }),
  });

  const applied = await applyEvents(gladys, config, [
    {
      type: 3,
      reliability: 0x20,
      channel: { id: 300, source: 42, counter: 7 },
      thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
    },
  ]);

  assert.equal(applied, 1);
  shutter.travel.clear();
});

// Each light test gets a lamp of its own: the brightness to restore is kept
// per device for the life of the process.
function setupLamp(id, remotes = []) {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: { Lamp: { type: 4100, channel: { id, source: 5 }, remotes } },
    }),
  });
  const client = createFakeClient({ config });
  const found = findDeviceByExternalId(gladys, config, `light:${id}-5`);
  const set = (key, value, using = client) =>
    found.blueprint.onSetValue(gladys, {
      device: found.device,
      feature: { external_id: `light:${id}-5:${key}` },
      value,
      client: using,
    });
  return { gladys, config, client, set };
}

test('switching a light on while a brightness order waits for the radio keeps that brightness', async () => {
  // Gladys runs two orders for one lamp side by side (a scene group, a
  // HomeKit write of Brightness and On together): the On read the brightness
  // before the slider's order had gone, and put the lamp back at the old one.
  const { gladys, client, set } = setupLamp(510);
  await set('brightness', 60);
  await set('on-off', 0);

  await Promise.all([set('brightness', 30), set('on-off', 1)]);

  assert.deepEqual(client.noteAt(2), { method: 1, type: NOTE_TYPES.LEVEL, value: 30 });
  assert.deepEqual(client.noteAt(3), { method: 1, type: NOTE_TYPES.LEVEL, value: 30 });
  assert.equal(gladys.statesOf('light:510-5:brightness').at(-1), 30);
});

test('a brightness the radio never carried is not the one the light switches back on at', async () => {
  const { client, set } = setupLamp(511);
  await set('brightness', 60);
  await set('on-off', 0);
  const failing = {
    ...client,
    async transfer() {
      throw new Error('box unreachable');
    },
  };

  await assert.rejects(set('brightness', 30, failing), /box unreachable/);
  await set('on-off', 1);

  assert.deepEqual(client.noteAt(2), { method: 1, type: NOTE_TYPES.LEVEL, value: 60 });
});

/**
 * A box whose transfers are settled by hand, one call at a time: `settle(i,
 * error)` answers the ith transfer, sending its note on success.
 */
function handSettledClient(client) {
  const pending = [];
  return {
    pending,
    using: {
      ...client,
      transfer(...args) {
        return new Promise((resolve, reject) => pending.push({ args, resolve, reject }));
      },
    },
    async settle(index, error) {
      while (pending.length <= index) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const call = pending[index];
      if (error) {
        call.reject(error);
      } else {
        call.resolve(await client.transfer(...call.args));
      }
    },
  };
}

for (const onFirst of [false, true]) {
  test(`a failed brightness order an On carried all the same stays the one to restore${onFirst ? ', the On answered first' : ''}`, async () => {
    // A transient box error on the slider's order, the On queued behind it
    // carrying the same level: the lamp is at 30 % and Gladys shows it, yet
    // the failure put 60 % back and the next On sent the lamp there.
    const { gladys, client, set } = setupLamp(onFirst ? 516 : 515);
    await set('brightness', 60);
    await set('on-off', 0);
    const box = handSettledClient(client);

    const brightness = set('brightness', 30, box.using);
    const on = set('on-off', 1, box.using);
    if (onFirst) {
      await box.settle(1);
      await on;
      await box.settle(0, new Error('box busy'));
    } else {
      await box.settle(0, new Error('box busy'));
      await assert.rejects(brightness, /box busy/);
      await box.settle(1);
    }
    await assert.rejects(brightness, /box busy/);
    await on;
    await set('on-off', 0);
    await set('on-off', 1);

    assert.deepEqual(client.noteAt(2), { method: 1, type: NOTE_TYPES.LEVEL, value: 30 });
    assert.deepEqual(client.noteAt(4), { method: 1, type: NOTE_TYPES.LEVEL, value: 30 });
    assert.deepEqual(
      gladys.statesOf(`light:${onFirst ? 516 : 515}-5:brightness`),
      [60, 0, 30, 0, 30],
    );
  });
}

test('a brightness order and the On carrying its level both failing switch back on at the level before', async () => {
  const { client, set } = setupLamp(517);
  await set('brightness', 60);
  await set('on-off', 0);
  const box = handSettledClient(client);

  const brightness = set('brightness', 30, box.using);
  const on = set('on-off', 1, box.using);
  await box.settle(0, new Error('box busy'));
  await box.settle(1, new Error('box busy'));
  await assert.rejects(brightness, /box busy/);
  await assert.rejects(on, /box busy/);
  await set('on-off', 1);

  assert.deepEqual(client.noteAt(2), { method: 1, type: NOTE_TYPES.LEVEL, value: 60 });
});

test('a wall remote switching a dimmer on leaves the brightness to restore alone', async () => {
  // A plain ON names no level: the dimmer goes back to its own. Read as
  // 100 %, Gladys showed full brightness and its next On sent the lamp there.
  const { gladys, config, client, set } = setupLamp(512, [77]);
  await set('brightness', 30);
  await set('on-off', 0);
  const wall = (value) => ({
    type: 3,
    reliability: 0x20,
    channel: { id: 512, source: 77 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
  });

  await applyEvents(
    gladys,
    config,
    [wall(STATE_VALUES.ON), wall(STATE_VALUES.OFF)],
    new HeardChannels(),
    new SentOrders(),
  );
  await set('on-off', 1);

  assert.deepEqual(gladys.statesOf('light:512-5:brightness'), [30, 0, 30, 0, 30]);
  assert.deepEqual(gladys.statesOf('light:512-5:on-off'), [1, 0, 1, 0, 1]);
  assert.deepEqual(client.noteAt(2), { method: 1, type: NOTE_TYPES.LEVEL, value: 30 });
});

test('the brightness to restore survives a restart of the integration', async () => {
  // Kept in memory only, it was lost on every restart: the first On sent the
  // lamp to 100 % while Gladys still showed 30 %.
  const { gladys, config, client, set } = setupLamp(513);
  await restoreDeviceStates(gladys, config, [
    {
      external_id: 'light:513-5',
      features: [
        { external_id: 'light:513-5:on-off', last_value: 1 },
        { external_id: 'light:513-5:brightness', last_value: 30 },
      ],
    },
  ]);

  await set('on-off', 0);
  await set('on-off', 1);

  assert.deepEqual(client.noteAt(1), { method: 1, type: NOTE_TYPES.LEVEL, value: 30 });
});

test('a brightness known in memory wins over the older one Gladys kept', async () => {
  // Restoring also runs on every reconnection and saved configuration.
  const { gladys, config, client, set } = setupLamp(514);
  await set('brightness', 70);
  await restoreDeviceStates(gladys, config, [
    {
      external_id: 'light:514-5',
      features: [{ external_id: 'light:514-5:brightness', last_value: 30 }],
    },
  ]);

  await set('on-off', 1);

  assert.deepEqual(client.noteAt(1), { method: 1, type: NOTE_TYPES.LEVEL, value: 70 });
});

test('a decoded order a device ignores is not blamed on partial decoding', async () => {
  // A one-button remote attached to a plug sends TOGGLE, fully decoded: the
  // fix is the device type or the remote attached, never the protocol.
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: { Plug: { type: 4097, channel: { id: 210, source: 2 }, remotes: [88] } },
    }),
  });

  const lines = captureLogs(async () =>
    applyEvents(
      gladys,
      config,
      [
        {
          type: 3,
          reliability: 0x20,
          channel: { id: 210, source: 88 },
          thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.TOGGLE }] },
        },
      ],
      new HeardChannels(),
      new SentOrders(),
    ),
  );

  assert.equal(await lines.result, 0);
  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /"Plug", but it says nothing this device can follow: toggle/);
  assert.match(lines.of('INFO')[0], /Button, type 4096/);
  assert.doesNotMatch(lines.of('INFO')[0], /partially decoded/);
});

test('what a wall remote does is published as the current state, not a past one', async () => {
  // Gladys only makes a dated state the current value when it is newer than
  // the one it holds — and that one was stamped by the Gladys host, through an
  // order or a step of the travel. A box clock behind it filed every press of
  // the wall remote in the history, and the shutter showed where it had been.
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: {
        'Living room shutter': { type: 4099, channel: { id: 300, source: 3 }, remotes: [42] },
        Plug: { type: 4097, channel: { id: 500, source: 5 }, remotes: [43] },
        Lamp: { type: 4100, channel: { id: 700, source: 7 }, remotes: [44] },
      },
    }),
  });
  // Dated 2023: a box clock far behind, so a dated state could never win.
  const press = (id, source, value) => ({
    type: 3,
    reliability: 0x20,
    timestamp: 1700000000000,
    channel: { id, source },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
  });

  const applied = await applyEvents(gladys, config, [
    press(300, 42, STATE_VALUES.DOWN),
    press(300, 42, STATE_VALUES.STOP),
    press(500, 43, STATE_VALUES.ON),
    press(700, 44, STATE_VALUES.ON),
  ]);

  assert.equal(applied, 4);
  assert.ok(gladys.published.length > 0);
  for (const { featureExternalId, state } of gladys.published) {
    assert.equal(typeof state, 'number', `${featureExternalId} was published as a past state`);
  }
  shutter.travel.clear();
});

test('noisy and unknown radio frames are dropped', async () => {
  const { gladys, config } = setup();
  const applied = await applyEvents(gladys, config, [
    // Reliability too low: the box is not sure of what it decoded.
    {
      type: 3,
      reliability: 0x2,
      channel: { id: 600, source: 6 },
      thingnotes: { notes: [{ type: NOTE_TYPES.R_HUMIDITY, value: 71 }] },
    },
    // Error event.
    {
      type: 0x101,
      channel: { id: 600, source: 6 },
      thingnotes: { notes: [{ type: NOTE_TYPES.R_HUMIDITY, value: 71 }] },
    },
    // Channel nobody listens to.
    {
      type: 3,
      channel: { id: 4242, source: 1 },
      thingnotes: { notes: [{ type: NOTE_TYPES.R_HUMIDITY, value: 71 }] },
    },
    'not an event',
  ]);

  assert.equal(applied, 0);
  assert.deepEqual(gladys.published, []);
});

test('an undeclared emitter is named in the logs, whatever its notes say', async () => {
  // The point of that line is discovery: it tells the user the pid/addr pair
  // to paste into `remotes`. A frame carrying a note the integration cannot
  // decode is exactly what an unknown remote sends, so it must be logged too.
  const { gladys, config } = setup();
  const lines = captureLogs(async () =>
    applyEvents(gladys, config, [
      {
        type: 3,
        reliability: 0x20,
        channel: { id: 300, source: 94311, counter: 7 },
        thingnotes: { notes: [{ type: 4242, value: 'unknown to us' }] },
      },
    ]),
  );

  assert.equal(await lines.result, 0);
  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /pid 300, addr 94311/);
  assert.match(lines.of('INFO')[0], /remotes/);
});

test('a frame carrying no decodable note still names its emitter', async () => {
  // A rolling-code 868 MHz protocol (Profalux, Somfy io) is often only
  // partially decoded: the box grades the frame, names the emitter, and hands
  // over no note at all. Dropping it made the remote look exactly like a box
  // that hears nothing — the one thing the user is trying to tell apart.
  const { gladys, config } = setup();
  const lines = captureLogs(async () =>
    applyEvents(gladys, config, [
      { type: 3, reliability: 0x20, channel: { id: 25605, source: 1187 } },
    ]),
  );

  assert.equal(await lines.result, 0);
  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /pid 25605, addr 1187/);
  assert.match(lines.of('INFO')[0], /no note the service could decode/);
});

test('a declared emitter whose frames decode to nothing says so, once', async () => {
  // The shape of "I attached my wall remote and nothing moves": the frame
  // reaches its device, the device publishes nothing, and a line at debug level
  // is a line nobody reads. Said at info the first time that emitter is heard —
  // and only the first time, because a partially decoded protocol sends this
  // very frame again on every single press.
  const { gladys, config } = setup();
  const shutterChannel = deviceNamed(config, 'Living room shutter').channel;
  const heard = new HeardChannels();
  const mute = () => ({
    type: 3,
    reliability: 0x20,
    channel: { ...shutterChannel },
    thingnotes: { notes: [] },
  });

  const first = captureLogs(async () => applyEvents(gladys, config, [mute()], heard), 'debug');

  assert.equal(await first.result, 0);
  assert.deepEqual(gladys.published, []);
  assert.equal(first.of('INFO').length, 1);
  assert.match(first.of('INFO')[0], /pid 300, addr 3.*"Living room shutter"/);
  assert.match(first.of('INFO')[0], /only partially decoded/);
  assert.equal(first.of('DEBUG').length, 0);

  const again = captureLogs(async () => applyEvents(gladys, config, [mute()], heard), 'debug');

  assert.equal(await again.result, 0);
  assert.equal(again.of('INFO').length, 0);
  assert.equal(again.of('DEBUG').length, 1);
  assert.match(again.of('DEBUG')[0], /only partially decoded/);
});

test('a frame its own device cannot follow is not swallowed in silence', async () => {
  // The trap this line exists for: the user has just declared the wall remote,
  // the frame now reaches the shutter, and the shutter has nothing to do with
  // what it carries (a rolling-code protocol hands over a raw DATA note, never
  // an order). Publishing nothing AND saying nothing looks exactly like a
  // remote that was never attached.
  const { gladys, config } = setup();
  const shutterChannel = deviceNamed(config, 'Living room shutter').channel;
  const heard = new HeardChannels();
  const lines = captureLogs(async () =>
    applyEvents(
      gladys,
      config,
      [
        {
          type: 3,
          reliability: 0x20,
          channel: { ...shutterChannel },
          thingnotes: { notes: [{ type: NOTE_TYPES.DATA, value: 'a1b2c3' }] },
        },
      ],
      heard,
    ),
  );

  assert.equal(await lines.result, 0);
  assert.deepEqual(gladys.published, []);
  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /pid 300, addr 3.*"Living room shutter"/);
  assert.match(lines.of('INFO')[0], /data a1b2c3/);
  // Heard, claimed, understood by nobody: what the registry has to remember.
  assert.deepEqual(
    heard.list().map(({ id, source, claimed, understood }) => ({
      id,
      source,
      claimed,
      understood,
    })),
    [{ id: 300, source: 3, claimed: true, understood: false }],
  );
});

test('an emitter nobody declares is remembered, for the action to attach it', async () => {
  const { gladys, config } = setup();
  const heard = new HeardChannels();

  await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        reliability: 0x20,
        channel: { id: 14177, source: 3359265281 },
        thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
      },
    ],
    heard,
  );

  const [emitter] = heard.list();
  assert.equal(emitter.id, 14177);
  assert.equal(emitter.source, 3359265281);
  assert.equal(emitter.claimed, false);
});

test('a frame dropped again is said once, then left on the debug channel', async () => {
  const { gladys, config } = setup();
  const heard = new HeardChannels();
  // Graded too low by the box: never published, but heard — twice, because a
  // remote at the edge of its range is pressed again, and again.
  const frame = {
    type: 3,
    reliability: 0x2,
    channel: { id: 300, source: 94311 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
  };
  const lines = captureLogs(
    async () => applyEvents(gladys, config, [frame, frame], heard),
    'debug',
  );

  assert.equal(await lines.result, 0);
  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /unreliable, graded 2.*pid 300, addr 94311/);
  assert.equal(lines.of('DEBUG').length, 1);
  assert.match(lines.of('DEBUG')[0], /unreliable, graded 2.*pid 300, addr 94311/);
});

test('a configuration change gives every emitter its info line back', async () => {
  const { gladys, config } = setup();
  const heard = new HeardChannels();
  const frame = {
    type: 3,
    reliability: 0x20,
    channel: { id: 14177, source: 3359265281 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
  };

  const first = captureLogs(async () => applyEvents(gladys, config, [frame, frame], heard));
  await first.result;
  // Said once, then quiet: a remote held down emits for as long as it is held.
  assert.equal(first.of('INFO').length, 1);

  // The user just changed something to fix exactly what that line described.
  // The next press is the one they are watching for, and it has to speak.
  heard.reannounce();
  const after = captureLogs(async () => applyEvents(gladys, config, [frame], heard));
  await after.result;
  assert.equal(after.of('INFO').length, 1);
  assert.match(after.of('INFO')[0], /pid 14177, addr 3359265281/);
});

test('a remote that drives its device says so, once', async () => {
  const { gladys } = setup();
  const heard = new HeardChannels();
  // The same shutter, with its wall remote attached: another address on the
  // protocol of the device it drives.
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: {
        'Living room shutter': { type: 4098, channel: { id: 300, source: 3 }, remotes: [94311] },
      },
    }),
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
  });
  const frame = {
    type: 3,
    reliability: 0x20,
    channel: { id: 300, source: 94311 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.DOWN }] },
  };

  const lines = captureLogs(
    async () => applyEvents(gladys, config, [frame, frame], heard),
    'debug',
  );

  assert.equal(await lines.result, 2);
  // The one line that says listening WORKS: without it, a remote that is heard,
  // routed and followed logs exactly as much as one nobody ever hears.
  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /pid 300, addr 94311 -> "Living room shutter" followed it/);
  assert.match(lines.of('INFO')[0], /level 0 \(down\)/);
  assert.ok(lines.of('DEBUG').some((line) => /followed it/.test(line)));
});

test('transports report the channel each device would use', () => {
  const { gladys, config, client } = setup();
  const entries = buildTransportEntries(gladys, config, client);
  assert.equal(entries.length, 7);
  assert.ok(entries.every((entry) => entry.transport === 'local'));
});

test('identify pings the chosen device and answers in both languages', async () => {
  const { gladys, config, client } = setup();

  const answer = await identifyDevice(gladys, 'switch:200-2', { config, client });
  assert.equal(client.noteAt(0).value, STATE_VALUES.PING);
  assert.match(answer.en, /Kitchen plug/);
  assert.match(answer.fr, /Kitchen plug/);

  // A radio sensor cannot be asked anything: it only talks.
  const unknown = await identifyDevice(gladys, 'sensor:600-6', { config, client });
  assert.match(unknown.en, /cannot signal itself/);
});

// --- Timed shutters ----------------------------------------------------------
// The radio says nothing about where a shutter is; a shutter given its travel
// times has its position computed instead (see src/devmel/travel.js).

const TIMED_DEVICES = JSON.stringify({
  devices: {
    // A plain 4098 — no positionable motor — but timed, so it gets a position.
    'Timed shutter': {
      type: 4098,
      travel_up: 20,
      travel_down: 10,
      channel: { id: 700, source: 7 },
      // The wall remote next to it: same protocol, its own address.
      remotes: [42],
    },
    // Installed upside down, symmetrical, with a programmed "my" position.
    'Sun sail': {
      type: 4099,
      invert: true,
      travel: 10,
      favorite_position: 40,
      channel: { id: 800, source: 8 },
    },
  },
});

function setupTimed(t) {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: TIMED_DEVICES,
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
  });
  const client = createFakeClient({ config });
  const clock = createFakeClock();
  const previous = shutter.travel;
  shutter.travel = new ShutterTravel({ now: clock.now, timers: clock.timers, tickMs: 1000 });
  t.after(() => {
    shutter.travel.clear();
    shutter.travel = previous;
  });

  const send = async (name, key, value) => {
    const found = findDeviceByExternalId(gladys, config, deviceExternalId(config, name));
    await found.blueprint.onSetValue(gladys, {
      device: found.device,
      feature: featureOf(gladys, config, name, key),
      value,
      client,
    });
  };
  const positionsOf = (name) => gladys.statesOf(`${deviceExternalId(config, name)}:position`);
  const statesOf = (name) => gladys.statesOf(`${deviceExternalId(config, name)}:state`);

  return { gladys, config, client, clock, send, positionsOf, statesOf };
}

/** A radio frame heard on the channel of one of the timed shutters. */
function radioState(config, name, value) {
  return {
    type: 3,
    channel: deviceNamed(config, name).channel,
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
  };
}

test('a timed shutter exposes a position even without a positionable motor', (t) => {
  const { gladys, config } = setupTimed(t);
  const devices = buildDiscoveredDevices(gladys, config);
  const types = (name) =>
    devices.find((device) => device.name === name).features.map((feature) => feature.type);

  assert.deepEqual(types('Timed shutter'), ['state', 'position']);
  assert.deepEqual(types('Sun sail'), ['state', 'position']);
});

test('the first full travel establishes the position, then it is followed live', async (t) => {
  const { clock, send, positionsOf, statesOf } = setupTimed(t);

  // Nothing is known yet: closing publishes nothing until the shutter reaches
  // the bottom, where the motor physically stops — an exact 0 %.
  await send('Timed shutter', 'state', -1);
  await clock.advance(5000);
  assert.deepEqual(positionsOf('Timed shutter'), []);
  await clock.advance(5000);
  assert.deepEqual(positionsOf('Timed shutter'), [0]);

  // From a known position, the way up is published second by second.
  await send('Timed shutter', 'state', 1);
  await clock.advance(4000);
  assert.deepEqual(positionsOf('Timed shutter'), [0, 5, 10, 15, 20]);

  // And it lands exactly on the top end stop, which resynchronizes the estimate.
  await clock.advance(16000);
  assert.equal(positionsOf('Timed shutter').at(-1), 100);
  // One state per order: arriving where the order said adds nothing to say.
  assert.deepEqual(statesOf('Timed shutter'), [-1, 1]);
});

test('a shutter stopped mid-travel keeps the position it reached', async (t) => {
  const { client, clock, send, positionsOf, statesOf } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'state', 1);
  await clock.advance(5000);
  await send('Timed shutter', 'state', 0);

  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  // A quarter of the way up, and Gladys is told so instead of keeping the 100 %
  // the order announced.
  assert.equal(positionsOf('Timed shutter').at(-1), 25);
  assert.equal(statesOf('Timed shutter').at(-1), 0);

  await clock.advance(60000);
  assert.equal(positionsOf('Timed shutter').at(-1), 25);
});

test('a wall remote heard on the radio moves the position too', async (t) => {
  const { gladys, config, clock, send, positionsOf } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  // Someone presses the wall remote: the box relays the order it heard.
  await applyEvents(gladys, config, [radioState(config, 'Timed shutter', STATE_VALUES.UP)]);
  await clock.advance(2000);

  assert.deepEqual(positionsOf('Timed shutter'), [0, 5, 10]);
});

test('an inverted shutter travels the other way round', async (t) => {
  const { gladys, config, clock, positionsOf, statesOf } = setupTimed(t);

  // Wired upside down: the radio order to go UP closes it, in Gladys terms.
  await applyEvents(gladys, config, [radioState(config, 'Sun sail', STATE_VALUES.UP)]);
  await clock.advance(15000);

  assert.equal(positionsOf('Sun sail').at(-1), 0);
  assert.deepEqual(statesOf('Sun sail'), [-1]);
});

test('the favourite position of the motor is published when it was configured', async (t) => {
  const { gladys, config, clock, positionsOf, statesOf } = setupTimed(t);

  await applyEvents(gladys, config, [radioState(config, 'Sun sail', STATE_VALUES.USERPOSITION)]);
  await clock.advance(1000);

  assert.deepEqual(positionsOf('Sun sail'), [40]);
  assert.deepEqual(statesOf('Sun sail'), [0]);
});

test('the "my" button of a Somfy remote, heard as STOP, sends a still shutter to its favourite', async (t) => {
  // Seen in the field: the remote says "stop" for its middle button. On a
  // shutter at rest that is "my": the motor runs to its programmed position,
  // and Gladys kept showing the shutter where it was.
  const { gladys, config, clock, positionsOf, statesOf } = setupTimed(t);
  const sail = deviceNamed(config, 'Sun sail');
  const stop = [{ kind: 'state', value: 'stop', command: 'stop' }];
  shutter.travel.set(sail, 100);

  await shutter.applyReadings(gladys, { device: sail, readings: stop });
  // The same press, repeated by the remote 0.4 s later: no new order.
  await clock.advance(400);
  await shutter.applyReadings(gladys, { device: sail, readings: stop });
  await clock.advance(10000);

  assert.equal(positionsOf('Sun sail').at(-1), 40);
  assert.deepEqual(statesOf('Sun sail'), [0]);
});

test('a STOP still stops a moving shutter that has a favourite position', async (t) => {
  const { gladys, config, clock, positionsOf, statesOf } = setupTimed(t);
  const sail = deviceNamed(config, 'Sun sail');
  shutter.travel.set(sail, 100);

  // Inverted: the radio DOWN opens it, so UP closes it, 10 s end to end.
  await shutter.applyReadings(gladys, {
    device: sail,
    readings: [{ kind: 'level', value: 100, command: 'up' }],
  });
  await clock.advance(2000);
  await shutter.applyReadings(gladys, {
    device: sail,
    readings: [{ kind: 'state', value: 'stop', command: 'stop' }],
  });
  await clock.advance(10000);

  assert.equal(positionsOf('Sun sail').at(-1), 80);
  assert.deepEqual(statesOf('Sun sail'), [-1, 0]);
});

test('a shutter with no favourite position configured says nothing about it', async (t) => {
  const { gladys, config, clock, send, positionsOf } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await applyEvents(gladys, config, [radioState(config, 'Timed shutter', STATE_VALUES.MIDDLE)]);

  // The motor went to a position only it knows: inventing one would be worse
  // than the 0 % Gladys already shows.
  assert.deepEqual(positionsOf('Timed shutter'), [0]);
});

test('a shutter with no travel time still publishes the destination of the order', async (t) => {
  const { gladys, config, client } = setup();
  const previous = shutter.travel;
  t.after(() => {
    shutter.travel = previous;
  });

  const found = findDeviceByExternalId(gladys, config, deviceExternalId(config, 'Bedroom shutter'));
  await found.blueprint.onSetValue(gladys, {
    device: found.device,
    feature: featureOf(gladys, config, 'Bedroom shutter', 'state'),
    value: 1,
    client,
  });

  assert.deepEqual(gladys.statesOf('shutter:400-4:position'), [100]);
});

test('the position of a shutter survives a restart of the integration', async (t) => {
  const { gladys, config, clock, send, positionsOf } = setupTimed(t);

  const restored = await restoreDeviceStates(gladys, config, [
    {
      external_id: deviceExternalId(config, 'Timed shutter'),
      features: [
        { external_id: `${deviceExternalId(config, 'Timed shutter')}:position`, last_value: 60 },
      ],
    },
  ]);
  assert.equal(restored, 1);

  // No full travel needed to know where it is: closing from 60 % takes 6 s.
  await send('Timed shutter', 'state', -1);
  await clock.advance(2000);
  assert.deepEqual(positionsOf('Timed shutter'), [50, 40]);
});

test('a shutter created in Gladys after the start gets the position already known', async (t) => {
  const { gladys, config, client, clock, send, positionsOf, statesOf } = setupTimed(t);

  // The shutter was used before the user added it: those states were dropped.
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  gladys.published.length = 0;

  const known = await replayDeviceStates(
    gladys,
    { external_id: deviceExternalId(config, 'Timed shutter'), features: [] },
    { config, client },
  );

  assert.equal(known, true);
  assert.deepEqual(positionsOf('Timed shutter'), [0]);
  assert.deepEqual(statesOf('Timed shutter'), [-1]);
});

test('a shutter updated in Gladys picks its stored position back up', async (t) => {
  const { gladys, config, client, positionsOf } = setupTimed(t);
  const externalId = deviceExternalId(config, 'Timed shutter');

  await replayDeviceStates(
    gladys,
    {
      external_id: externalId,
      features: [{ external_id: `${externalId}:position`, last_value: 35 }],
    },
    { config, client },
  );

  assert.deepEqual(positionsOf('Timed shutter'), [35]);
});

test('a device unknown to the configuration is not replayed', async (t) => {
  const { gladys, config, client } = setupTimed(t);
  assert.equal(
    await replayDeviceStates(gladys, { external_id: 'shutter:nope' }, { config, client }),
    false,
  );
  assert.equal(gladys.published.length, 0);
});

test('a timed shutter with no positionable motor is driven with a stopwatch', async (t) => {
  const { client, clock, send, positionsOf, statesOf } = setupTimed(t);

  // A reference first: the position slider needs to know where it starts from.
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  await send('Timed shutter', 'position', 60);
  assert.equal(client.noteAt(1).value, STATE_VALUES.UP);
  await clock.advance(11000);

  // Opening takes 20 s, so 60 % is 12 s of it: still running at 11 s...
  assert.equal(positionsOf('Timed shutter').at(-1), 55);
  assert.equal(client.sent.length, 2);

  // ...and stopped by us on arrival, since no end stop would do it.
  await clock.advance(1000);
  assert.equal(positionsOf('Timed shutter').at(-1), 60);
  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  assert.deepEqual(statesOf('Timed shutter'), [-1, 1, 0]);
});

test('a timed shutter is still stopped when Gladys refuses its positions', async (t) => {
  const { gladys, config, client, clock, send, positionsOf } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);

  // Gladys goes away mid-course: every publication fails, during the travel
  // AND at the arrival.
  const publishState = gladys.publishState;
  gladys.publishState = async () => {
    throw new Error('Gladys unreachable');
  };
  await clock.advance(9000);

  // The stopwatch kept running and the STOP went out at 40 %: the motor was
  // not left to run into the top end stop.
  assert.equal(client.sent.length, 3);
  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), 40);

  gladys.publishState = publishState;
  assert.equal(positionsOf('Timed shutter').at(-1), 0);
});

test('a timed shutter is stopped before its arrival is published', async (t) => {
  const { gladys, client, clock, send } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);
  await clock.advance(7000);

  // Only the arrival publication fails: the STOP must already be on the air.
  const publishState = gladys.publishState;
  gladys.publishState = async () => {
    throw new Error('Gladys unreachable');
  };
  await clock.advance(2000);
  gladys.publishState = publishState;

  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  assert.equal(client.sent.length, 3);
});

test('a timed shutter sent to an end stop lets the motor stop itself', async (t) => {
  const { client, clock, send, positionsOf } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 100);
  await clock.advance(25000);

  assert.equal(positionsOf('Timed shutter').at(-1), 100);
  // The open order, and nothing else: the top end stop is the motor's business.
  assert.equal(client.sent.length, 2);
});

test('a shutter with no reference yet is sent to the nearest end stop', async (t) => {
  const { client, clock, send, positionsOf } = setupTimed(t);

  await send('Timed shutter', 'position', 30);
  await clock.advance(15000);

  // 30 % is nearer the bottom: it closes fully, which is what establishes the
  // reference the next positioning needs.
  assert.equal(client.noteAt(0).value, STATE_VALUES.DOWN);
  assert.deepEqual(positionsOf('Timed shutter'), [0]);
  assert.equal(client.sent.length, 1);
});

test('a timed shutter is stopped on time when Gladys refuses the state of the order', async (t) => {
  const { gladys, config, client, clock, send } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  // The one publication made as the order goes out is refused (429: a scene
  // closing every shutter in the same minute). The order is on the air.
  const publishState = gladys.publishState;
  gladys.publishState = async () => {
    gladys.publishState = publishState;
    throw new Error('Too many requests (429)');
  };
  await send('Timed shutter', 'position', 40);
  assert.ok(shutter.travel.isMoving(deviceNamed(config, 'Timed shutter')));

  // The stopwatch runs all the same: STOP at 40 %, not the top end stop.
  await clock.advance(8000);
  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), 40);
});

test('a STOP heard while the order before it is still being published stops the shutter', async (t) => {
  const { gladys, config, clock, send, positionsOf } = setupTimed(t);
  const device = deviceNamed(config, 'Timed shutter');

  await send('Timed shutter', 'state', 1);
  await clock.advance(25000);

  // Gladys takes its time answering: DOWN, then STOP from the wall remote a
  // moment later, while the state of the DOWN is still on its way.
  const publishState = gladys.publishState;
  const held = [];
  gladys.publishState = (...args) =>
    new Promise((resolve) => held.push(() => publishState(...args).then(resolve)));
  const down = applyEvents(gladys, config, [
    radioState(config, 'Timed shutter', STATE_VALUES.DOWN),
  ]);
  await new Promise(setImmediate);
  const stop = applyEvents(gladys, config, [
    radioState(config, 'Timed shutter', STATE_VALUES.STOP),
  ]);
  await new Promise(setImmediate);
  gladys.publishState = publishState;
  for (const release of held) {
    release();
  }
  await Promise.all([down, stop]);

  // The STOP came last and wins: no travel starting after it.
  assert.equal(shutter.travel.isMoving(device), false);
  await clock.advance(15000);
  assert.equal(shutter.travel.positionOf(device), 100);
  assert.notEqual(positionsOf('Timed shutter').at(-1), 0);
});

test('a timed shutter is stopped on time even when Gladys is slow to take its positions', async (t) => {
  const { gladys, config, client, clock, send } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);

  // Gladys is loaded: a position published on the way is answered much later.
  const publishState = gladys.publishState;
  const held = [];
  gladys.publishState = (...args) =>
    new Promise((resolve) => held.push(() => publishState(...args).then(resolve)));
  await clock.advance(8000);

  // The STOP is due at 8 s and went out at 8 s, not once Gladys answered.
  assert.equal(client.noteAt(2)?.value, STATE_VALUES.STOP);
  gladys.publishState = publishState;
  for (const release of held) {
    release();
  }
  await clock.advance(1000);
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), 40);
});

test('a timed shutter whose STOP could not go out is followed to its end stop, and it is said', async (t) => {
  const { gladys, config, client, clock, send, positionsOf } = setupTimed(t);
  const previousScenes = shutter.scenes;
  shutter.scenes = new SceneEvents();
  t.after(() => {
    shutter.scenes = previousScenes;
  });

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);

  // The service restarts at the worst moment: the STOP never reaches the air.
  const transfer = client.transfer;
  client.transfer = async (device, notes, options) => {
    if (notes[0].value === STATE_VALUES.STOP) {
      throw new Error('fetch failed');
    }
    return transfer(device, notes, options);
  };
  await clock.advance(8000);

  // Nothing stopped the motor: it runs on to the top, and so does the travel.
  assert.ok(shutter.travel.isMoving(deviceNamed(config, 'Timed shutter')));
  await clock.advance(12000);
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), 100);
  assert.equal(positionsOf('Timed shutter').at(-1), 100);
  assert.deepEqual(
    gladys.sceneEvents.map((event) => [event.key, event.data.device_name, event.data.reason]),
    [['order_failed', 'Timed shutter', 'ERROR']],
  );
});

test('the STOP of a timed travel is dropped when a wall remote set the shutter off meanwhile', async (t) => {
  const { gladys, config, client, clock, send, positionsOf, statesOf } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);

  // The radio is busy with another order when the STOP falls due...
  const transfer = client.transfer;
  let release = null;
  client.transfer = async (device, notes, options) => {
    if (notes[0].value === STATE_VALUES.STOP) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return transfer(device, notes, options);
  };
  await clock.advance(8000);
  assert.ok(release, 'the STOP waits for the radio');

  // ...and the user presses UP on the wall remote in the meantime.
  const remote = {
    type: 3,
    channel: { id: 700, source: 42 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
  };
  await applyEvents(gladys, config, [remote], new HeardChannels(), new SentOrders());
  release();
  await clock.advance(15000);

  // The STOP never went out, and the old arrival did not land over the UP.
  assert.deepEqual(
    client.sent.map((entry) => entry.notes[0].value),
    [STATE_VALUES.DOWN, STATE_VALUES.UP],
  );
  assert.equal(positionsOf('Timed shutter').at(-1), 100);
  assert.equal(statesOf('Timed shutter').at(-1), 1);
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), 100);
});

test('a moving shutter that reaches the position asked for is stopped there', async (t) => {
  const { config, client, clock, send, positionsOf } = setupTimed(t);
  const device = deviceNamed(config, 'Timed shutter');

  await send('Timed shutter', 'state', 1);
  await clock.advance(25000);
  await send('Timed shutter', 'state', -1);
  await clock.advance(4500);

  // Closing, at 55 %, and an order takes half a second to reach the air: by
  // then the shutter is at 50 %, which is where it was asked to go.
  const transfer = client.transfer;
  client.transfer = async (...args) => {
    await clock.advance(500);
    return transfer(...args);
  };
  await send('Timed shutter', 'position', 50);
  assert.equal(client.sent.at(-1).notes[0].value, STATE_VALUES.STOP);
  assert.equal(shutter.travel.isMoving(device), false);
  client.transfer = transfer;

  // Asked for exactly where a moving shutter is: stopped there as well.
  await send('Timed shutter', 'state', 1);
  await clock.advance(3000);
  const passing = shutter.travel.positionOf(device);
  await send('Timed shutter', 'position', passing);
  assert.equal(client.sent.at(-1).notes[0].value, STATE_VALUES.STOP);
  await clock.advance(20000);
  assert.equal(positionsOf('Timed shutter').at(-1), passing);
});

test('two positions asked at once are followed in turn, the last one winning', async (t) => {
  const { client, clock, send, positionsOf } = setupTimed(t);

  await send('Timed shutter', 'state', 1);
  await clock.advance(25000);

  const transfer = client.transfer;
  client.transfer = async (...args) => {
    await clock.advance(800);
    return transfer(...args);
  };
  await Promise.all([
    send('Timed shutter', 'position', 40),
    send('Timed shutter', 'position', 100),
  ]);
  client.transfer = transfer;
  await clock.advance(30000);

  assert.equal(positionsOf('Timed shutter').at(-1), 100);
  assert.equal(client.sent.at(-1).notes[0].value, STATE_VALUES.UP);
});

// --- The integration hearing itself ------------------------------------------
// Everything Gladys transmits comes back to Gladys: the answer to the transfer,
// and the box hearing its own emission. Read as a fresh order, that echo undoes
// what the order was doing (see src/devmel/orders.js).

/** The frame the box pushes back after an order we sent ourselves. */
function ownEcho(config, name, value, { uid, type = 3 } = {}) {
  return {
    type,
    channel: { ...deviceNamed(config, name).channel },
    thingnotes: {
      uid,
      notes: value === undefined ? [] : [{ type: NOTE_TYPES.STATE, value }],
    },
  };
}

test('the echo of our own order does not take a positioned shutter to the top', async (t) => {
  const { gladys, config, client, clock, send, positionsOf } = setupTimed(t);
  const orders = new SentOrders();
  const device = deviceNamed(config, 'Timed shutter');

  // Establish the position first: a timed shutter knows where it is only once
  // it has been to an end stop.
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  // 40 % of a 20 s travel: the stopwatch drives it there and stops it.
  await send('Timed shutter', 'position', 40);
  assert.equal(client.noteAt(1).value, STATE_VALUES.UP);
  orders.remember(toThingUid('shutter:700-7:position'), device);

  // The box answers the transfer with the very order it carried.
  await applyEvents(
    gladys,
    config,
    [
      ownEcho(config, 'Timed shutter', STATE_VALUES.UP, {
        uid: toThingUid('shutter:700-7:position'),
      }),
    ],
    new HeardChannels(),
    orders,
  );
  await clock.advance(8000);

  // Stopped at 40 %, not run to the top: the echo carried no new order.
  assert.equal(positionsOf('Timed shutter').at(-1), 40);
  assert.equal(client.sent.at(-1).notes[0].value, STATE_VALUES.STOP);

  await clock.advance(20000);
  assert.equal(positionsOf('Timed shutter').at(-1), 40);
});

test('the box hearing its own emission is the same echo, with no uid to go by', async (t) => {
  const { gladys, config, clock, send, positionsOf } = setupTimed(t);
  const orders = new SentOrders();
  const device = deviceNamed(config, 'Timed shutter');

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);
  orders.remember(toThingUid('shutter:700-7:position'), device);

  // Same frame, relayed by the listening subscription this time: no uid at all,
  // just the channel the integration was talking on a moment ago.
  await applyEvents(
    gladys,
    config,
    [ownEcho(config, 'Timed shutter', STATE_VALUES.UP)],
    new HeardChannels(),
    orders,
  );
  await clock.advance(8000);

  assert.equal(positionsOf('Timed shutter').at(-1), 40);
});

test('an echo that comes back late is still ours, not a fresh order', async (t) => {
  const { gladys, config, clock, send, positionsOf } = setupTimed(t);
  let stamp = 0;
  const orders = new SentOrders({ now: () => stamp });
  const heard = new HeardChannels();

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);
  orders.remember(toThingUid('shutter:700-7:position'), deviceNamed(config, 'Timed shutter'));

  // A box repeating itself takes as long as it takes. A minute is well past
  // any window, and this frame is still the order Gladys sent: it comes from
  // the address Gladys transmits on, which nothing else in the house uses.
  stamp += 60000;
  await applyEvents(
    gladys,
    config,
    [ownEcho(config, 'Timed shutter', STATE_VALUES.UP)],
    heard,
    orders,
  );
  await clock.advance(8000);

  assert.equal(positionsOf('Timed shutter').at(-1), 40);
  // And it is counted as ours: an echo is not an emitter, it is the proof that
  // the frames have a route back in.
  assert.equal(heard.own, 1);
  assert.deepEqual(heard.list(), []);
});

test('a wall remote pressed during that time is still a fresh order', async (t) => {
  const { gladys, config, clock, send, positionsOf } = setupTimed(t);
  const orders = new SentOrders();
  orders.remember(toThingUid('shutter:700-7:position'), deviceNamed(config, 'Timed shutter'));

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  // Another address on the same protocol: somebody's finger, not our echo.
  const remote = {
    type: 3,
    channel: { id: 700, source: 42 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
  };
  await applyEvents(gladys, config, [remote], new HeardChannels(), orders);
  await clock.advance(2000);

  assert.deepEqual(positionsOf('Timed shutter'), [0, 5, 10]);
});

test('a wall remote heard on the air cancels the repeat of the Gladys order it overrides', async (t) => {
  // A scene opens two shutters at once, so the repeat of the first UP waits
  // behind the second shutter's order. STOP pressed on the wall meanwhile: the
  // repeated UP used to go out after it and run the shutter to the top, its
  // echo filtered as ours, while Gladys showed it stopped.
  const { gladys, config } = setupTimed(t);
  const orders = new SentOrders();
  const client = new AirSendClient({ sleep: async () => {}, orders });
  client.configure(
    normalizeConfig({
      service_url: 'http://192.168.1.50:33863',
      spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
      command_repeat: 1,
    }),
  );
  const channels = [];
  let release = null;
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async (url, options) => {
    const channel = JSON.parse(options.body).channel.id;
    channels.push(channel);
    if (channel === 800 && !release) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return { status: 200, json: async () => ({ type: 3 }) };
  };
  const open = (name) => {
    const found = findDeviceByExternalId(gladys, config, deviceExternalId(config, name));
    return found.blueprint.onSetValue(gladys, {
      device: found.device,
      feature: featureOf(gladys, config, name, 'state'),
      value: 1,
      client,
    });
  };

  const first = open('Timed shutter');
  const second = open('Sun sail');
  await first;
  await new Promise(setImmediate);
  await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        channel: { id: 700, source: 42 },
        thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.STOP }] },
      },
    ],
    new HeardChannels(),
    orders,
    undefined,
    client,
  );
  release();
  await second;
  await client.idle();

  assert.deepEqual(
    channels.filter((channel) => channel === 700),
    [700],
  );
  // The other shutter was told nothing new: its repeat still goes out.
  assert.deepEqual(
    channels.filter((channel) => channel === 800),
    [800, 800],
  );
});

test('an order the box could not transmit is said out loud, not swallowed', async (t) => {
  // The shape of "I have to click Open three times": the order never made it to
  // the air, and until this line nothing said so above debug level.
  const { gladys, config } = setupTimed(t);
  const orders = new SentOrders();
  orders.remember('0xdead', deviceNamed(config, 'Timed shutter'));

  const lines = captureLogs(async () =>
    applyEvents(
      gladys,
      config,
      [ownEcho(config, 'Timed shutter', undefined, { uid: '0xdead', type: 0x101 })],
      new HeardChannels(),
      orders,
    ),
  );

  assert.equal(await lines.result, 0);
  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /did not carry the order sent to "Timed shutter"/);
  // NETWORK: the box was never reached, so nothing was transmitted — and that
  // is a thing to go and check, not a number to read.
  assert.match(lines.of('INFO')[0], /NETWORK \(event type 257\)/);
  assert.match(lines.of('INFO')[0], /Nothing went out on the air/);
});

test('a failure the box reports is not answered with "raise Command repeats"', async (t) => {
  // 258 is SYNCHRONIZATION: the link between the service and the box lost its
  // thread. Sending the user to the repeats setting for it is sending them to
  // the one setting that cannot help — and they arrive with it already at 3.
  const { gladys, config } = setupTimed(t);
  const orders = new SentOrders();
  orders.remember('0xbeef', deviceNamed(config, 'Timed shutter'));

  const lines = captureLogs(async () =>
    applyEvents(
      gladys,
      config,
      [ownEcho(config, 'Timed shutter', undefined, { uid: '0xbeef', type: 258 })],
      new HeardChannels(),
      orders,
    ),
  );

  await lines.result;
  const line = lines.of('INFO')[0];
  assert.match(line, /SYNCHRONIZATION \(event type 258\)/);
  // Nothing claims the shutter stayed put: a link that dropped mid-exchange
  // says nothing about what did or did not reach the air.
  assert.match(line, /Whether anything went out on the air, nothing says/);
  assert.doesNotMatch(line, /raise "Command repeats"/);
});

test('a device reporting where it actually is, is believed even in an echo', async (t) => {
  // The answer to our own transfer is the route a positionable motor uses to
  // say where it ended up: the order it carries is old news, that reading is not.
  const { gladys, config, clock, positionsOf } = setupTimed(t);
  const orders = new SentOrders();
  orders.remember('0xbeef', deviceNamed(config, 'Sun sail'));

  await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        channel: { ...deviceNamed(config, 'Sun sail').channel },
        thingnotes: { uid: '0xbeef', notes: [{ type: NOTE_TYPES.LEVEL, value: 70 }] },
      },
    ],
    new HeardChannels(),
    orders,
  );
  await clock.advance(1000);

  // Inverted shutter: 70 % on the radio is 30 % open in Gladys.
  assert.deepEqual(positionsOf('Sun sail'), [30]);
});

test('a frame dropped on the way in is counted, and its emitter remembered', async () => {
  // The registry is what the "Heard" line of the report reads. Leaving the
  // dropped frames out of it made a box hearing plenty and grading it badly
  // report exactly the same silence as a box hearing nothing at all.
  const { gladys, config } = setup();
  const heard = new HeardChannels();

  await applyEvents(
    gladys,
    config,
    [
      // Graded too low by the box, but its emitter is named.
      {
        type: 3,
        reliability: 0x2,
        channel: { id: 300, source: 94311 },
        thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
      },
      // Not even a channel: nothing to remember, everything to count.
      { type: 3, reliability: 0x20 },
    ],
    heard,
    new SentOrders(),
  );

  assert.equal(heard.seen, 2);
  assert.equal(heard.dropped, 2);
  assert.match(heard.lastDrop, /no channel/);
  assert.deepEqual(
    heard.list().map(({ id, source, dropped }) => ({ id, source, dropped })),
    [{ id: 300, source: 94311, dropped: 'unreliable, graded 2' }],
  );
});

test('the echo of our own order proves the route works, without posing as an emitter', async () => {
  const { gladys, config } = setup();
  const heard = new HeardChannels();
  const orders = new SentOrders();
  orders.remember('0xabc', deviceNamed(config, 'Kitchen plug'));

  await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        reliability: 0x20,
        channel: { id: 200, source: 2 },
        thingnotes: { uid: '0xabc', notes: [] },
      },
    ],
    heard,
    orders,
  );

  assert.equal(heard.own, 1);
  assert.equal(heard.seen, 1);
  // Not an emitter of the house: it is us, and "Attach a remote" must not offer it.
  assert.deepEqual(heard.list(), []);
});

test('a frame the box graded badly says what it carried, and what to do about it', async () => {
  // The user's own case: the box picks up a protocol without decoding it — no
  // address, no grade it trusts. Silence here (or a bare debug line) leaves
  // them with "the remote does nothing" and nowhere to go.
  const { gladys, config } = setup();
  const heard = new HeardChannels();
  const frame = () => ({
    type: 3,
    reliability: 0,
    channel: { id: 14177 },
    thingnotes: { notes: [] },
  });

  const first = captureLogs(
    async () => applyEvents(gladys, config, [frame()], heard, new SentOrders()),
    'debug',
  );

  assert.equal(await first.result, 0);
  assert.equal(first.of('INFO').length, 1);
  assert.match(first.of('INFO')[0], /unreliable, graded 0.*pid 14177/);
  assert.match(first.of('INFO')[0], /carrying no note the service could decode/);
  assert.match(first.of('INFO')[0], /Set the listening channel to 14177 so the box/);

  // Once is a diagnosis; every press is noise.
  const again = captureLogs(
    async () => applyEvents(gladys, config, [frame()], heard, new SentOrders()),
    'debug',
  );
  await again.result;
  assert.equal(again.of('INFO').length, 0);
  assert.equal(again.of('DEBUG').length, 1);
});

test('a dropped frame of the generic channel asks for "generic", not for pid 1', async () => {
  // pid 1 typed in the Listening channel field reads as "deduce": the log line
  // has to name it the way Test the connection and the widget do.
  const { gladys, config } = setup();
  const lines = captureLogs(
    async () =>
      applyEvents(
        gladys,
        config,
        [{ type: 3, reliability: 0, channel: { id: 1 }, thingnotes: { notes: [] } }],
        new HeardChannels(),
        new SentOrders(),
      ),
    'debug',
  );
  await lines.result;
  assert.match(lines.of('INFO')[0], /Set the listening channel to "generic" so the box/);
  assert.doesNotMatch(lines.of('INFO')[0], /listening channel to (1|that pid)\b/);
});

test('accepting unreliable frames lets a badly graded frame through', async () => {
  const gladys = createFakeGladys();
  const devices = JSON.stringify({
    devices: {
      'Living room shutter': { type: 4098, channel: { id: 300, source: 3 }, remotes: [42] },
    },
  });
  // Heard on the channel of the device itself, not from a declared remote.
  const frame = {
    type: 3,
    reliability: 0x2,
    channel: { id: 300, source: 3 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
  };

  // Graded too low: refused, exactly as the reference implementation does.
  const strict = normalizeConfig({ devices });
  assert.equal(
    await applyEvents(gladys, strict, [frame], new HeardChannels(), new SentOrders()),
    0,
  );
  assert.deepEqual(gladys.published, []);

  // Unless the user decided a doubtful frame beats no frame at all.
  const lenient = normalizeConfig({ devices, accept_unreliable: true });
  assert.equal(
    await applyEvents(gladys, lenient, [frame], new HeardChannels(), new SentOrders()),
    1,
  );
  assert.deepEqual(gladys.statesOf('shutter:300-3:state'), [1]);
  shutter.travel.clear();
});

test('a declared wall remote is followed whatever grade the box gives it', async () => {
  // Seen in the field: the remote of a shutter, its exact address, a plain UP,
  // graded 71 — one past the window. Dropped, the shutter went up and Gladys
  // kept it closed. Its full pid/addr pair is declared: that is no noise.
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: {
        'Chambre parents': {
          type: 4098,
          channel: { id: 25455, source: 57447 },
          remotes: [{ pid: 14177, addr: 3359265281 }],
        },
      },
    }),
  });
  const frame = (source, reliability) => ({
    type: 3,
    reliability,
    channel: { id: 14177, source },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
  });

  assert.equal(
    await applyEvents(
      gladys,
      config,
      [frame(3359265281, 71), frame(3359265281, 0)],
      new HeardChannels(),
      new SentOrders(),
    ),
    2,
  );
  // Another address on the same protocol stays noise until it is declared.
  assert.equal(
    await applyEvents(gladys, config, [frame(1234, 71)], new HeardChannels(), new SentOrders()),
    0,
  );
  assert.deepEqual(gladys.statesOf('shutter:25455-57447:state'), [1, 1]);
  shutter.travel.clear();
});

test('a remote declared by its protocol alone follows the frames nobody can attribute', async () => {
  // Last resort for a protocol the box picks up without decoding an address:
  // there is no pid/addr pair to declare, only the pid.
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    accept_unreliable: true,
    devices: JSON.stringify({
      devices: {
        'Living room shutter': {
          type: 4098,
          channel: { id: 300, source: 3 },
          remotes: [{ pid: 14177 }],
        },
      },
    }),
  });

  const applied = await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        reliability: 0,
        channel: { id: 14177 },
        thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.DOWN }] },
      },
    ],
    new HeardChannels(),
    new SentOrders(),
  );

  assert.equal(applied, 1);
  assert.deepEqual(gladys.statesOf('shutter:300-3:state'), [-1]);
});

// --- What a restart, a reconnection or a saved configuration must not undo ---

test('a reconnection in the middle of a timed travel does not cancel its STOP', async (t) => {
  const { gladys, config, client, clock, send, positionsOf } = setupTimed(t);
  const externalId = deviceExternalId(config, 'Timed shutter');

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);
  await clock.advance(3000);

  // Gladys reconnects (or the configuration is saved): the initialization
  // restores the states Gladys kept, older than what the travel knows.
  await restoreDeviceStates(gladys, config, [
    {
      external_id: externalId,
      features: [{ external_id: `${externalId}:position`, last_value: 15 }],
    },
  ]);
  await clock.advance(5000);

  // 40 % of a 20 s opening is 8 s: stopped on time, and known to be there.
  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  assert.equal(positionsOf('Timed shutter').at(-1), 40);
});

test('a shutdown in the middle of a timed positioning stops the shutter and says where', async (t) => {
  const { gladys, config, client, clock, send, positionsOf, statesOf } = setupTimed(t);
  const device = deviceNamed(config, 'Timed shutter');

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);
  await clock.advance(5000);

  // SIGTERM (an update, a restart of Gladys): the radio still works, so the
  // shutter is stopped now rather than left to run into the top end stop...
  await stopDeviceTracking();
  assert.equal(client.sent.length, 3);
  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  // ...and Gladys keeps where it was stopped, which the next start restores.
  assert.equal(positionsOf('Timed shutter').at(-1), 25);
  assert.equal(statesOf('Timed shutter').at(-1), 0);
  assert.equal(shutter.travel.positionOf(device), 25);
  assert.equal(shutter.travel.isMoving(device), false);

  const published = gladys.published.length;
  await clock.advance(60000);
  assert.equal(client.sent.length, 3);
  assert.equal(gladys.published.length, published);
});

test('a shutdown in the middle of a full opening publishes the end stop the motor runs to', async (t) => {
  const { client, clock, send, positionsOf, statesOf } = setupTimed(t);

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'state', 1);
  await clock.advance(5000);

  await stopDeviceTracking();

  // The motor stops at the top by itself: nothing to send, and the top is
  // where it is, not the 25 % of the last tick.
  assert.equal(client.sent.length, 2);
  assert.equal(positionsOf('Timed shutter').at(-1), 100);
  assert.deepEqual(statesOf('Timed shutter'), [-1, 1]);
});

test('a timed shutter says when its STOP falls due, so a bind does not hold the radio then', async (t) => {
  const { client, clock, send } = setupTimed(t);

  // Heading for an end stop: the motor stops itself, there is no STOP to wait for.
  await send('Timed shutter', 'state', -1);
  assert.equal(stopDueIn(), null);
  await clock.advance(10000);

  // 40 % of a 20 s opening: the STOP is due in 8 s, and nowhere in the radio
  // queue until then.
  await send('Timed shutter', 'position', 40);
  assert.equal(stopDueIn(), 8000);
  await clock.advance(5000);
  assert.equal(stopDueIn(), 3000);

  await clock.advance(3000);
  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  assert.equal(stopDueIn(), null);

  await send('Timed shutter', 'position', 100);
  assert.equal(stopDueIn(), null);
});

test('a position known in memory wins over the older one Gladys kept', async (t) => {
  const { gladys, config, clock, send, positionsOf } = setupTimed(t);
  const externalId = deviceExternalId(config, 'Timed shutter');

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await restoreDeviceStates(gladys, config, [
    {
      external_id: externalId,
      features: [{ external_id: `${externalId}:position`, last_value: 60 }],
    },
  ]);

  // Gladys is told again where it is, and opening starts from the bottom it
  // reached, not from a stale 60 %.
  await send('Timed shutter', 'state', 1);
  await clock.advance(2000);
  assert.deepEqual(positionsOf('Timed shutter'), [0, 0, 5, 10]);
});

test('an untimed shutter stopped mid-course is not sent to its favourite position', async (t) => {
  // Nothing tells the travel this shutter moves, so it cannot tell "my" from
  // a STOP: it is a STOP, the way it was before the favourite position existed.
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: { Store: { type: 4099, favorite_position: 40, channel: { id: 710, source: 1 } } },
    }),
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
  });
  const client = createFakeClient({ config });
  const clock = createFakeClock();
  const previous = shutter.travel;
  shutter.travel = new ShutterTravel({ now: clock.now, timers: clock.timers, tickMs: 1000 });
  t.after(() => {
    shutter.travel.clear();
    shutter.travel = previous;
  });

  const found = findDeviceByExternalId(gladys, config, deviceExternalId(config, 'Store'));
  for (const value of [-1, 1, 0]) {
    await found.blueprint.onSetValue(gladys, {
      device: found.device,
      feature: featureOf(gladys, config, 'Store', 'state'),
      value,
      client,
    });
  }

  assert.deepEqual(gladys.statesOf(`${deviceExternalId(config, 'Store')}:position`), [0, 100]);
  assert.equal(gladys.statesOf(`${deviceExternalId(config, 'Store')}:state`).at(-1), 0);
});

// --- One press, one click -----------------------------------------------------

const KEYFOB = JSON.stringify({
  devices: { Keyfob: { type: 1, channel: { id: 610, source: 1 } } },
});

test('a press of a remote is one click, however many frames it sends', async (t) => {
  resetSensorClicks();
  t.after(resetSensorClicks);
  const gladys = createFakeGladys();
  const config = normalizeConfig({ devices: KEYFOB });
  const frame = {
    type: 3,
    channel: { id: 610, source: 1 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.TOGGLE }] },
  };

  const applied = await applyEvents(
    gladys,
    config,
    [frame, frame, frame],
    new HeardChannels(),
    new SentOrders(),
    null,
  );

  // Every frame was understood; one click went to Gladys.
  assert.equal(applied, 3);
  assert.deepEqual(gladys.statesOf(`${deviceExternalId(config, 'Keyfob')}:click`), [52]);
});

test('another button clicks at once, the same one again after the press window', async (t) => {
  resetSensorClicks();
  t.after(resetSensorClicks);
  const gladys = createFakeGladys();
  const config = normalizeConfig({ devices: KEYFOB });
  const device = deviceNamed(config, 'Keyfob');
  const toggle = [{ kind: READINGS.TOGGLE, value: 'TOGGLE' }];

  await sensor.applyReadings(gladys, { device, readings: toggle, now: 0 });
  await sensor.applyReadings(gladys, { device, readings: toggle, now: 1000 });
  await sensor.applyReadings(gladys, {
    device,
    readings: [{ kind: READINGS.LEVEL, value: 0 }],
    now: 1200,
  });
  await sensor.applyReadings(gladys, { device, readings: toggle, now: 2600 });

  assert.equal(gladys.statesOf(`${deviceExternalId(config, 'Keyfob')}:click`).length, 3);
});

// --- What the remembered position of a shutter means -------------------------

/**
 * Shutters of their own, with a clock, a travel and a configuration the test
 * can save again (`reconfigure`), as the Configuration screen does: same
 * process, same travel, a new device behind the same platform id.
 */
function setupShutters(t, devices) {
  const gladys = createFakeGladys();
  const configOf = (list) =>
    normalizeConfig({
      devices: JSON.stringify({ devices: list }),
      spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
    });
  const context = { config: configOf(devices) };
  const client = createFakeClient({ config: context.config });
  const clock = createFakeClock();
  const previous = shutter.travel;
  shutter.travel = new ShutterTravel({ now: clock.now, timers: clock.timers, tickMs: 1000 });
  t.after(() => {
    shutter.travel.clear();
    shutter.travel = previous;
  });

  const externalIdOf = (name) => deviceExternalId(context.config, name);
  const send = async (name, key, value) => {
    const found = findDeviceByExternalId(gladys, context.config, externalIdOf(name));
    await found.blueprint.onSetValue(gladys, {
      device: found.device,
      feature: featureOf(gladys, context.config, name, key),
      value,
      client,
    });
  };
  /** A saved configuration: initialize() restores from what Gladys kept. */
  const reconfigure = async (list, stored = {}) => {
    context.config = configOf(list);
    await restoreDeviceStates(
      gladys,
      context.config,
      Object.keys(list).map((name) => ({
        external_id: externalIdOf(name),
        features: [{ external_id: `${externalIdOf(name)}:position`, last_value: stored[name] }],
      })),
    );
  };
  const positionsOf = (name) => gladys.statesOf(`${externalIdOf(name)}:position`);
  const statesOf = (name) => gladys.statesOf(`${externalIdOf(name)}:state`);
  const sentValues = () => client.sent.map((entry) => entry.notes[0].value);

  return {
    gladys,
    context,
    client,
    clock,
    send,
    reconfigure,
    positionsOf,
    statesOf,
    sentValues,
    deviceOf: (name) => deviceNamed(context.config, name),
  };
}

test('a shutter given travel times starts from an unknown position, not from its last order', async (t) => {
  const channel = { id: 730, source: 3 };
  const { gladys, context, client, clock, send, reconfigure, positionsOf, sentValues, deviceOf } =
    setupShutters(t, { Store: { type: 4098, channel } });

  // Untimed: opened, then stopped a few seconds later, somewhere half-way.
  await send('Store', 'state', 1);
  await clock.advance(5000);
  await send('Store', 'state', 0);

  // The user times it and saves; Gladys creates the Position feature.
  await reconfigure({ Store: { type: 4098, travel: 20, channel } });
  await replayDeviceStates(
    gladys,
    { external_id: deviceExternalId(context.config, 'Store'), features: [] },
    { config: context.config, client },
  );
  assert.equal(shutter.travel.positionOf(deviceOf('Store')), null);
  assert.deepEqual(positionsOf('Store'), []);

  // So the first percentage runs to the nearest end stop, to find its reference.
  await send('Store', 'position', 40);
  await clock.advance(25000);
  assert.deepEqual(sentValues(), [STATE_VALUES.UP, STATE_VALUES.STOP, STATE_VALUES.DOWN]);
  assert.deepEqual(positionsOf('Store'), [0]);
});

test('correcting invert on a shutter mirrors the position it remembers', async (t) => {
  const channel = { id: 740, source: 4 };
  const { clock, send, reconfigure, positionsOf, statesOf, sentValues } = setupShutters(t, {
    Sail: { type: 4098, travel: 20, channel },
  });

  // Declared the wrong way round: "close" sends DOWN, which opens this sail.
  await send('Sail', 'state', -1);
  await clock.advance(25000);
  assert.deepEqual(positionsOf('Sail'), [0]);

  // The user adds invert and saves: the sail did not move, it is fully open.
  await reconfigure({ Sail: { type: 4098, travel: 20, invert: true, channel } }, { Sail: 0 });
  assert.equal(positionsOf('Sail').at(-1), 100);
  assert.equal(statesOf('Sail').at(-1), 1);

  // Closing it to 40 % now runs the motor away from the end stop it rests at.
  await send('Sail', 'position', 40);
  await clock.advance(25000);
  assert.deepEqual(sentValues(), [STATE_VALUES.DOWN, STATE_VALUES.UP, STATE_VALUES.STOP]);
  assert.equal(positionsOf('Sail').at(-1), 40);
});

test('correcting invert while the shutter travels ends the travel in the new terms', async (t) => {
  const channel = { id: 741, source: 4 };
  const { clock, send, reconfigure, positionsOf, statesOf, deviceOf } = setupShutters(t, {
    Sail: { type: 4098, travel: 20, channel },
  });
  await send('Sail', 'state', -1);
  await clock.advance(25000);

  // "Open" sets the sail off the wrong way; the user adds invert while it runs.
  await send('Sail', 'state', 1);
  await clock.advance(5000);
  await reconfigure({ Sail: { type: 4098, travel: 20, invert: true, channel } }, { Sail: 25 });
  await clock.advance(16000);

  // The motor is at its radio-UP end stop: closed, once inverted.
  assert.equal(shutter.travel.positionOf(deviceOf('Sail')), 0);
  assert.equal(shutter.travel.isMoving(deviceOf('Sail')), false);
  assert.equal(positionsOf('Sail').at(-1), 0);
  assert.equal(statesOf('Sail').at(-1), -1);
});

test('a positioning whose order is still on its way at shutdown is stopped and published', async (t) => {
  const { client, clock, send, positionsOf, deviceOf } = setupShutters(t, {
    Store: { type: 4098, travel: 20, channel: { id: 742, source: 4 } },
  });
  await send('Store', 'state', -1);
  await clock.advance(25000);

  // The UP waits for a slow box when SIGTERM arrives.
  const transfer = client.transfer;
  let carry;
  client.transfer = async (...args) => {
    await new Promise((resolve) => {
      carry = resolve;
    });
    client.transfer = transfer;
    return transfer(...args);
  };
  const positioning = send('Store', 'position', 40);
  await new Promise(setImmediate);
  const settling = stopDeviceTracking();
  carry();
  await positioning;
  await settling;

  // Its travel was armed, then stopped by the shutdown: STOP sent, and the
  // shutter known (and shown) where it was stopped.
  assert.deepEqual(
    client.sent.map((entry) => entry.notes[0].value),
    [STATE_VALUES.DOWN, STATE_VALUES.UP, STATE_VALUES.STOP],
  );
  assert.equal(shutter.travel.isMoving(deviceOf('Store')), false);
  assert.equal(positionsOf('Store').at(-1), 0);
  assert.equal(clock.armed, 0);
});

test('a position made unknown by the favourite button stays unknown after a reconnection', async (t) => {
  const { gladys, config, client, clock, send } = setupTimed(t);
  const externalId = deviceExternalId(config, 'Timed shutter');

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await applyEvents(gladys, config, [radioState(config, 'Timed shutter', STATE_VALUES.MIDDLE)]);

  // Gladys still holds the 0 % from before: it is not where the motor went.
  await restoreDeviceStates(gladys, config, [
    {
      external_id: externalId,
      features: [{ external_id: `${externalId}:position`, last_value: 0 }],
    },
  ]);
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), null);

  // 30 % from an unknown spot: down to the end stop first, never a timed DOWN.
  await send('Timed shutter', 'position', 30);
  await clock.advance(12000);
  assert.deepEqual(
    client.sent.map((entry) => entry.notes[0].value),
    [STATE_VALUES.DOWN, STATE_VALUES.DOWN],
  );
});

test('a travel that ended while Gladys was away is published again when it comes back', async (t) => {
  const { gladys, config, client, clock, send, positionsOf, statesOf } = setupTimed(t);
  const externalId = deviceExternalId(config, 'Timed shutter');

  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);
  await clock.advance(3000);

  // Gladys restarts: every publication is refused, the STOP still goes out.
  const publishState = gladys.publishState;
  gladys.publishState = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  await clock.advance(10000);
  gladys.publishState = publishState;
  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  assert.equal(positionsOf('Timed shutter').at(-1), 15);

  // Back: the initialization finds the stale 15 % and "closing", and fixes them.
  await restoreDeviceStates(gladys, config, [
    {
      external_id: externalId,
      features: [{ external_id: `${externalId}:position`, last_value: 15 }],
    },
  ]);
  assert.equal(positionsOf('Timed shutter').at(-1), 40);
  assert.equal(statesOf('Timed shutter').at(-1), 0);

  // Nothing missed, nothing said again.
  gladys.published.length = 0;
  await restoreDeviceStates(gladys, config, [
    {
      external_id: externalId,
      features: [{ external_id: `${externalId}:position`, last_value: 40 }],
    },
  ]);
  assert.deepEqual(gladys.published, []);
});

test('a position order to a shutter with no travel times says its state too', async (t) => {
  const { send, positionsOf, statesOf } = setupShutters(t, {
    Store: { type: 4099, channel: { id: 750, source: 5 } },
  });

  await send('Store', 'state', 1);
  await send('Store', 'position', 0);
  await send('Store', 'position', 40);

  assert.deepEqual(positionsOf('Store'), [100, 0, 40]);
  assert.deepEqual(statesOf('Store'), [1, -1, 0]);
});

test('a one-button keyfob heard by a timed shutter makes its position unknown', async (t) => {
  const { gladys, config, client, clock, send, statesOf } = setupTimed(t);
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  const toggle = {
    type: 3,
    channel: { id: 700, source: 42 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.TOGGLE }] },
  };
  const lines = captureLogs(async () =>
    applyEvents(gladys, config, [toggle], new HeardChannels(), new SentOrders()),
  );
  assert.equal(await lines.result, 1);
  assert.ok(lines.of('INFO').some((line) => line.includes('followed it: toggle')));
  assert.ok(!lines.of('INFO').some((line) => line.includes('partially decoded')));

  // Opened, closed or stopped: nobody can tell, and nothing is invented.
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), null);
  assert.equal(statesOf('Timed shutter').at(-1), 0);
  await send('Timed shutter', 'position', 60);
  assert.equal(client.noteAt(1).value, STATE_VALUES.UP);
  await clock.advance(25000);
  assert.equal(client.sent.length, 2, 'no timed STOP: run to the end stop');
});

test('the ON of an on/off remote sets a timed shutter off, it does not put it at the top', async (t) => {
  const { gladys, config, clock, send, positionsOf, statesOf } = setupTimed(t);
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  const on = {
    type: 3,
    channel: { id: 700, source: 42 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.ON }] },
  };
  await applyEvents(gladys, config, [on], new HeardChannels(), new SentOrders());
  await clock.advance(2000);

  // Opening, 20 s end to end: 10 % after two seconds, announced "open".
  assert.deepEqual(positionsOf('Timed shutter'), [0, 5, 10]);
  assert.equal(statesOf('Timed shutter').at(-1), 1);
  assert.equal(shutter.travel.isMoving(deviceNamed(config, 'Timed shutter')), true);
});

test('the ON of an on/off remote is followed by an untimed shutter', async () => {
  const { gladys, config } = setup();
  const on = {
    type: 3,
    channel: { id: 300, source: 3 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.OFF }] },
  };

  await applyEvents(gladys, config, [on], new HeardChannels(), new SentOrders());

  assert.deepEqual(
    gladys.statesOf(`${deviceExternalId(config, 'Living room shutter')}:state`),
    [-1],
  );
});

test('the echo of our own order, heard as ON, does not retarget a timed shutter', async (t) => {
  const { gladys, config, client, clock, send, positionsOf } = setupTimed(t);
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);
  await send('Timed shutter', 'position', 40);
  const orders = new SentOrders();
  orders.remember('0xbeef', deviceNamed(config, 'Timed shutter'));

  await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        channel: { ...deviceNamed(config, 'Timed shutter').channel },
        thingnotes: { uid: '0xbeef', notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.ON }] },
      },
    ],
    new HeardChannels(),
    orders,
  );
  await clock.advance(10000);

  assert.equal(client.noteAt(2).value, STATE_VALUES.STOP);
  assert.equal(positionsOf('Timed shutter').at(-1), 40);
});

// --- What an echo says, and what the box says about an order ------------------

/** Remember the last transfer the fake client carried, as the real client does. */
function rememberLast(orders, config, client, { emissions = null } = {}) {
  const last = client.sent.at(-1);
  const uid = toThingUid(last.options.uid);
  orders.remember(uid, deviceNamed(config, last.device), {
    notes: last.notes,
    fresh: true,
    emissions,
  });
  return uid;
}

test('the echo of a percentage we sent does not cut short the travel it started', async (t) => {
  const { gladys, config, client, clock, send, positionsOf } = setupTimed(t);
  const orders = new SentOrders({ now: clock.now });
  const device = deviceNamed(config, 'Sun sail');

  // Opened all the way first, so the travel knows where it starts from.
  await send('Sun sail', 'state', 1);
  await clock.advance(10000);
  await send('Sun sail', 'position', 30);
  const uid = rememberLast(orders, config, client);
  await clock.advance(1000);

  // The box answers with the very percentage it carried (70: the sail is inverted).
  await applyEvents(
    gladys,
    config,
    [
      {
        type: 1,
        channel: { ...device.channel },
        thingnotes: { uid, notes: [{ type: NOTE_TYPES.LEVEL, value: 70 }] },
      },
    ],
    new HeardChannels(),
    orders,
  );

  // Still on its way, not landed at 30 % a second after it set off.
  assert.ok(shutter.travel.isMoving(device));
  await clock.advance(10000);
  assert.deepEqual(positionsOf('Sun sail'), [100, 90, 80, 70, 60, 50, 40, 30]);
});

test('a late echo of ON does not switch back on a plug switched off since', async () => {
  const { gladys, config, client } = setup();
  const orders = new SentOrders();
  const plug = (value) =>
    findDeviceByExternalId(
      gladys,
      config,
      deviceExternalId(config, 'Kitchen plug'),
    ).blueprint.onSetValue(gladys, {
      device: deviceNamed(config, 'Kitchen plug'),
      feature: featureOf(gladys, config, 'Kitchen plug', 'on-off'),
      value,
      client,
    });

  await plug(1);
  const uid = rememberLast(orders, config, client);
  await plug(0);
  rememberLast(orders, config, client);

  // The answer to the ON comes back after the OFF went out.
  await applyEvents(
    gladys,
    config,
    [
      {
        type: 1,
        channel: { id: 200, source: 2 },
        thingnotes: { uid, notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.ON }] },
      },
    ],
    new HeardChannels(),
    orders,
  );

  assert.deepEqual(gladys.statesOf(`${deviceExternalId(config, 'Kitchen plug')}:on-off`), [1, 0]);
});

test('a remote copied onto a plug is followed within the minute after an order of Gladys', async () => {
  // The copied remote speaks with the plug's own voice: its frames reach the
  // integration as echoes. Only one repeating what Gladys just said is one.
  const { gladys, config, client } = setup();
  let now = 0;
  const orders = new SentOrders({ now: () => now });
  await findDeviceByExternalId(
    gladys,
    config,
    deviceExternalId(config, 'Kitchen plug'),
  ).blueprint.onSetValue(gladys, {
    device: deviceNamed(config, 'Kitchen plug'),
    feature: featureOf(gladys, config, 'Kitchen plug', 'on-off'),
    value: 0,
    client,
  });
  rememberLast(orders, config, client);
  const press = (value) => ({
    type: 0,
    channel: { id: 200, source: 2 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
  });

  now += 10000;
  await applyEvents(gladys, config, [press(STATE_VALUES.ON)], new HeardChannels(), orders);
  now += 5000;
  await applyEvents(gladys, config, [press(STATE_VALUES.OFF)], new HeardChannels(), orders);

  assert.deepEqual(
    gladys.statesOf(`${deviceExternalId(config, 'Kitchen plug')}:on-off`),
    [0, 1, 0],
  );
});

test('a shutter following a group channel follows the order Gladys sent to that group', async (t) => {
  const { gladys, context, client, clock, send, positionsOf } = setupShutters(t, {
    'All shutters': { type: 4098, channel: { id: 900, source: 100 } },
    'Living room': { type: 4098, travel: 20, channel: { id: 900, source: 1 }, remotes: [100] },
  });
  const orders = new SentOrders({ now: clock.now });
  await send('Living room', 'state', 1);
  await clock.advance(21000);

  // Gladys closes the whole group; the box hears itself on the group channel.
  await send('All shutters', 'state', -1);
  rememberLast(orders, context.config, client);
  await applyEvents(
    gladys,
    context.config,
    [
      {
        type: 3,
        channel: { id: 900, source: 100 },
        thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.DOWN }] },
      },
    ],
    new HeardChannels(),
    orders,
  );
  await clock.advance(2000);

  // The motor of the living room went down with the others, and so does Gladys.
  assert.deepEqual(positionsOf('Living room'), [100, 95, 90]);
});

test('a group order is followed once, never over an order the member was given since', async (t) => {
  const { gladys, context, client, clock, send, positionsOf } = setupShutters(t, {
    'All shutters': { type: 4098, channel: { id: 910, source: 100 } },
    'Living room': { type: 4098, travel: 20, channel: { id: 910, source: 1 }, remotes: [100] },
  });
  const orders = new SentOrders({ now: clock.now });
  const groupEcho = (uid) => ({
    type: 3,
    channel: { id: 910, source: 100 },
    thingnotes: { uid, notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.DOWN }] },
  });
  await send('Living room', 'state', 1);
  rememberLast(orders, context.config, client);
  await clock.advance(21000);

  // A scene: close everything, then the living room to 50 % straight away.
  await send('All shutters', 'state', -1);
  const groupUid = rememberLast(orders, context.config, client);
  await send('Living room', 'position', 50);
  rememberLast(orders, context.config, client);
  // The box hears the group's DOWN, then answers its repeat, late.
  await applyEvents(gladys, context.config, [groupEcho()], new HeardChannels(), orders);
  await clock.advance(3000);
  await applyEvents(gladys, context.config, [groupEcho(groupUid)], new HeardChannels(), orders);
  await clock.advance(20000);

  // Its STOP went out at 50 %: the echoes did not send it to the bottom.
  assert.equal(client.sent.at(-1).device, 'Living room');
  assert.equal(client.noteAt(client.sent.length - 1).value, STATE_VALUES.STOP);
  assert.equal(positionsOf('Living room').at(-1), 50);
});

test('a group order followed by its member is not replayed by its next echo', async (t) => {
  const { gladys, context, client, clock, send } = setupShutters(t, {
    'All shutters': { type: 4098, channel: { id: 911, source: 100 } },
    'Living room': { type: 4098, travel: 20, channel: { id: 911, source: 1 }, remotes: [100] },
  });
  const orders = new SentOrders({ now: clock.now });
  await send('All shutters', 'state', -1);
  const uid = rememberLast(orders, context.config, client);
  const echo = (withUid) => ({
    type: 3,
    channel: { id: 911, source: 100 },
    thingnotes: {
      ...(withUid ? { uid } : {}),
      notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.DOWN }],
    },
  });

  assert.equal(
    await applyEvents(gladys, context.config, [echo(false)], new HeardChannels(), orders),
    1,
  );
  await clock.advance(1000);
  assert.equal(
    await applyEvents(gladys, context.config, [echo(true)], new HeardChannels(), orders),
    0,
  );
});

test('a transfer answer that says nothing does not use up the group order of its member', async (t) => {
  const { gladys, context, client, clock, send, positionsOf } = setupShutters(t, {
    'All shutters': { type: 4098, channel: { id: 912, source: 100 } },
    'Living room': { type: 4098, travel: 20, channel: { id: 912, source: 1 }, remotes: [100] },
  });
  const orders = new SentOrders({ now: clock.now });
  await send('Living room', 'state', 1);
  rememberLast(orders, context.config, client);
  await clock.advance(21000);

  await send('All shutters', 'state', -1);
  const uid = rememberLast(orders, context.config, client, { emissions: 2 });
  // The service answers the transfer (SENT, no notes), then the box hears
  // itself with the DOWN: that frame is the one the member follows.
  const channel = { id: 912, source: 100 };
  await applyEvents(
    gladys,
    context.config,
    [{ type: 1, channel, thingnotes: { uid, notes: [] } }],
    new HeardChannels(),
    orders,
  );
  const heard = {
    type: 3,
    channel,
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.DOWN }] },
  };
  assert.equal(await applyEvents(gladys, context.config, [heard], new HeardChannels(), orders), 1);
  await clock.advance(2000);

  assert.deepEqual(positionsOf('Living room'), [100, 95, 90]);
});

test('a late echo of a group DOWN is not taken for the STOP given since', async (t) => {
  const { gladys, context, client, clock, send, positionsOf } = setupShutters(t, {
    'All shutters': { type: 4098, channel: { id: 913, source: 100 } },
    'Living room': { type: 4098, travel: 20, channel: { id: 913, source: 1 }, remotes: [100] },
  });
  const orders = new SentOrders({ now: clock.now });
  const heard = (value) => ({
    type: 3,
    channel: { id: 913, source: 100 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
  });
  await send('Living room', 'state', 1);
  rememberLast(orders, context.config, client);
  await clock.advance(21000);

  // "Close all", heard; "Stop all" 3 s later; then a repeat of the DOWN heard
  // late, and the STOP.
  await send('All shutters', 'state', -1);
  rememberLast(orders, context.config, client, { emissions: 2 });
  await clock.advance(500);
  await applyEvents(
    gladys,
    context.config,
    [heard(STATE_VALUES.DOWN)],
    new HeardChannels(),
    orders,
  );
  await clock.advance(2500);
  await send('All shutters', 'state', 0);
  rememberLast(orders, context.config, client, { emissions: 2 });
  await clock.advance(300);
  await applyEvents(
    gladys,
    context.config,
    [heard(STATE_VALUES.DOWN)],
    new HeardChannels(),
    orders,
  );
  await clock.advance(300);
  await applyEvents(
    gladys,
    context.config,
    [heard(STATE_VALUES.STOP)],
    new HeardChannels(),
    orders,
  );
  await clock.advance(30000);

  // Its motor stopped with the group's: so does its travel.
  const position = shutter.travel.positionOf(deviceNamed(context.config, 'Living room'));
  assert.equal(position, 85);
  assert.equal(positionsOf('Living room').at(-1), 85);
});

test('a timed shutter whose order the box never carried does not move, nor get its STOP', async (t) => {
  const { gladys, config, client, clock, send, positionsOf, statesOf } = setupTimed(t);
  const orders = new SentOrders({ now: clock.now });
  const transports = new AirSendClient({ orders: new SentOrders() });
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  await send('Timed shutter', 'position', 40);
  const uid = rememberLast(orders, config, client);
  // Another client had the box locked: the UP never went out.
  await applyEvents(
    gladys,
    config,
    [{ type: 0x104, channel: { id: 700, source: 7 }, thingnotes: { uid, notes: [] } }],
    new HeardChannels(),
    orders,
    new SceneEvents(),
    transports,
  );
  await clock.advance(20000);

  // No STOP sent to a still motor (a Somfy one would set off for "my").
  assert.deepEqual(
    client.sent.map((entry) => entry.notes[0].value),
    [STATE_VALUES.DOWN, STATE_VALUES.UP],
  );
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), 0);
  assert.equal(positionsOf('Timed shutter').at(-1), 0);
  assert.equal(statesOf('Timed shutter').at(-1), -1);
  assert.equal(
    transports.transportOf(deviceNamed(config, 'Timed shutter'))?.transport,
    'unreachable',
  );
});

test('a timed shutter whose STOP the box refuses after the arrival runs on to its end stop', async (t) => {
  const { gladys, config, client, clock, send, positionsOf, statesOf } = setupTimed(t);
  const orders = new SentOrders({ now: clock.now });
  const scenes = new SceneEvents({ now: clock.now });
  const previous = shutter.scenes;
  shutter.scenes = scenes;
  t.after(() => {
    shutter.scenes = previous;
  });
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  // 40 % of a 20 s opening: the STOP goes out at 8 s, and the service takes
  // it (`wait: false`).
  await send('Timed shutter', 'position', 40);
  await clock.advance(8000);
  assert.equal(client.noteAt(client.sent.length - 1).value, STATE_VALUES.STOP);
  const uid = rememberLast(orders, config, client, { emissions: 1 });
  assert.equal(positionsOf('Timed shutter').at(-1), 40);

  // Then the box says, on the callback, that another client held the radio.
  await applyEvents(
    gladys,
    config,
    [{ type: 0x104, channel: { id: 700, source: 7 }, thingnotes: { uid, notes: [] } }],
    new HeardChannels(),
    orders,
    scenes,
    new AirSendClient({ orders: new SentOrders() }),
  );
  await clock.advance(15000);

  // Nothing stopped the motor: the travel follows it to the top.
  assert.deepEqual(
    gladys.sceneEvents.map((event) => event.data.reason),
    ['BUSY'],
  );
  assert.equal(shutter.travel.positionOf(deviceNamed(config, 'Timed shutter')), 100);
  assert.equal(positionsOf('Timed shutter').at(-1), 100);
  assert.equal(statesOf('Timed shutter').at(-1), 1);
});

test('a short positioning whose UP the box refuses after its STOP is taken back', async (t) => {
  const { gladys, config, client, clock, send, positionsOf, statesOf } = setupTimed(t);
  const orders = new SentOrders({ now: clock.now });
  const device = deviceNamed(config, 'Timed shutter');
  await send('Timed shutter', 'state', -1);
  await clock.advance(10000);

  // 2 % of a 20 s opening: the STOP is due 400 ms after the UP, sooner than
  // the box answers the UP and its repeat.
  await send('Timed shutter', 'position', 2);
  const uid = rememberLast(orders, config, client, { emissions: 2 });
  orders.remember(uid, device);
  await clock.advance(400);
  assert.equal(client.noteAt(client.sent.length - 1).value, STATE_VALUES.STOP);
  rememberLast(orders, config, client, { emissions: 2 });

  // The box was BUSY: it refuses both emissions of the UP, then the STOP.
  const busy = { type: 0x104, channel: { id: 700, source: 7 }, thingnotes: { uid, notes: [] } };
  for (let i = 0; i < 3; i += 1) {
    await applyEvents(
      gladys,
      config,
      [{ ...busy }],
      new HeardChannels(),
      orders,
      new SceneEvents(),
    );
  }
  await clock.advance(30000);

  // The motor never left the bottom: no run to the top, no 2 % either.
  assert.equal(shutter.travel.positionOf(device), 0);
  assert.equal(positionsOf('Timed shutter').at(-1), 0);
  assert.equal(statesOf('Timed shutter').at(-1), -1);
});

test('a plug or a lamp whose order the box never carried is shown as it was before', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: {
        Plug: { type: 4097, channel: { id: 230, source: 2 } },
        Lamp: { type: 4100, channel: { id: 231, source: 5 } },
      },
    }),
  });
  const client = createFakeClient({ config });
  const orders = new SentOrders();
  const transports = new AirSendClient({ orders: new SentOrders() });
  const send = (name, key, value) =>
    findDeviceByExternalId(gladys, config, deviceExternalId(config, name)).blueprint.onSetValue(
      gladys,
      {
        device: deviceNamed(config, name),
        feature: featureOf(gladys, config, name, key),
        value,
        client,
      },
    );
  // The service could not reach the box: nothing went out on the air.
  const answer = (name, uid, type) =>
    applyEvents(
      gladys,
      config,
      [{ type, channel: { ...deviceNamed(config, name).channel }, thingnotes: { uid } }],
      new HeardChannels(),
      orders,
      new SceneEvents(),
      transports,
    );
  const notCarried = (name, uid) => answer(name, uid, 0x101);
  // The order before went out (SENT): the verdict that follows is the new one's.
  const carried = (name, uid) => answer(name, uid, 1);

  await send('Plug', 'on-off', 0);
  await carried('Plug', rememberLast(orders, config, client));
  await send('Plug', 'on-off', 1);
  await notCarried('Plug', rememberLast(orders, config, client, { emissions: 1 }));
  assert.deepEqual(gladys.statesOf(`${deviceExternalId(config, 'Plug')}:on-off`), [0, 1, 0]);
  assert.equal(transports.transportOf(deviceNamed(config, 'Plug'))?.transport, 'unreachable');

  await send('Lamp', 'brightness', 30);
  await carried('Lamp', rememberLast(orders, config, client));
  await send('Lamp', 'brightness', 70);
  await notCarried('Lamp', rememberLast(orders, config, client, { emissions: 1 }));
  assert.deepEqual(gladys.statesOf(`${deviceExternalId(config, 'Lamp')}:brightness`), [30, 70, 30]);
  // And the next On goes back to the brightness the lamp really has.
  await send('Lamp', 'on-off', 1);
  assert.equal(client.noteAt(client.sent.length - 1).value, 30);
});

test('a plug or a lamp is not switched back when an identify PING fails', async () => {
  for (const type of [4097, 4100]) {
    const gladys = createFakeGladys();
    const config = normalizeConfig({
      devices: JSON.stringify({ devices: { Dev: { type, channel: { id: 233, source: 2 } } } }),
    });
    const client = createFakeClient({ config });
    let now = 1000;
    const orders = new SentOrders({ now: () => now });
    const externalId = deviceExternalId(config, 'Dev');
    const device = deviceNamed(config, 'Dev');
    const verdict = (eventType, uid) =>
      applyEvents(
        gladys,
        config,
        [{ type: eventType, channel: { id: 233, source: 2 }, thingnotes: { uid, notes: [] } }],
        new HeardChannels(),
        orders,
      );
    await restoreDeviceStates(gladys, config, [
      {
        external_id: externalId,
        features: [
          { external_id: `${externalId}:on-off`, last_value: 0 },
          { external_id: `${externalId}:brightness`, last_value: 0 },
        ],
      },
    ]);
    await findDeviceByExternalId(gladys, config, externalId).blueprint.onSetValue(gladys, {
      device,
      feature: featureOf(gladys, config, 'Dev', 'on-off'),
      value: 1,
      client,
    });
    await verdict(1, rememberLast(orders, config, client, { emissions: 2 }));

    // Two minutes later, the box unreachable: "identify" sends a PING, refused.
    now += 120000;
    await identifyDevice(gladys, externalId, { config, client });
    const ping = rememberLast(orders, config, client, { emissions: 2 });
    await verdict(0x101, ping);
    await verdict(0x101, ping);

    // The ON went out minutes ago: the device is still shown on.
    assert.deepEqual(gladys.statesOf(`${externalId}:on-off`), [1]);
  }
});

test('a plug switched ON then OFF, neither carried, is shown as it was before both', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({ devices: { Plug: { type: 4097, channel: { id: 234, source: 2 } } } }),
  });
  const client = createFakeClient({ config });
  let now = 1000;
  const orders = new SentOrders({ now: () => now });
  const externalId = deviceExternalId(config, 'Plug');
  await restoreDeviceStates(gladys, config, [
    { external_id: externalId, features: [{ external_id: `${externalId}:on-off`, last_value: 0 }] },
  ]);
  const send = async (value) => {
    await findDeviceByExternalId(gladys, config, externalId).blueprint.onSetValue(gladys, {
      device: deviceNamed(config, 'Plug'),
      feature: featureOf(gladys, config, 'Plug', 'on-off'),
      value,
      client,
    });
    return rememberLast(orders, config, client, { emissions: 2 });
  };
  await send(1);
  now += 800;
  const uid = await send(0);
  now += 2000;

  // The ON's two refusals, then the OFF's: nothing reached the air.
  const refused = { type: 0x101, channel: { id: 234, source: 2 }, thingnotes: { uid, notes: [] } };
  await applyEvents(
    gladys,
    config,
    [refused, { ...refused }, { ...refused }, { ...refused }],
    new HeardChannels(),
    orders,
  );

  assert.deepEqual(gladys.statesOf(`${externalId}:on-off`), [1, 0]);
});

test('a plug whose first order after a restart was never carried is shown as Gladys kept it', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({ devices: { Plug: { type: 4097, channel: { id: 232, source: 2 } } } }),
  });
  const client = createFakeClient({ config });
  const orders = new SentOrders();
  const externalId = deviceExternalId(config, 'Plug');
  await restoreDeviceStates(gladys, config, [
    { external_id: externalId, features: [{ external_id: `${externalId}:on-off`, last_value: 0 }] },
  ]);

  await findDeviceByExternalId(gladys, config, externalId).blueprint.onSetValue(gladys, {
    device: deviceNamed(config, 'Plug'),
    feature: featureOf(gladys, config, 'Plug', 'on-off'),
    value: 1,
    client,
  });
  const uid = rememberLast(orders, config, client, { emissions: 1 });
  await applyEvents(
    gladys,
    config,
    [{ type: 0x101, channel: { id: 232, source: 2 }, thingnotes: { uid } }],
    new HeardChannels(),
    orders,
  );

  assert.deepEqual(gladys.statesOf(`${externalId}:on-off`), [1, 0]);
});

test('a repeat the box refused is no failed order when the order itself went out', async (t) => {
  const { gladys, config, client, clock, send } = setupTimed(t);
  const orders = new SentOrders({ now: clock.now });
  const scenes = new SceneEvents();
  await send('Timed shutter', 'state', 1);
  // Sent, then repeated once: two emissions under one uid.
  const uid = rememberLast(orders, config, client, { emissions: 2 });
  orders.remember(uid, deviceNamed(config, 'Timed shutter'));

  const lines = captureLogs(async () =>
    applyEvents(
      gladys,
      config,
      [
        { type: 1, channel: { id: 700, source: 7 }, thingnotes: { uid, notes: [] } },
        { type: 0x105, channel: { id: 700, source: 7 }, thingnotes: { uid, notes: [] } },
      ],
      new HeardChannels(),
      orders,
      scenes,
    ),
  );
  await lines.result;

  assert.deepEqual(lines.of('INFO'), []);
  assert.deepEqual(gladys.sceneEvents, []);
  // Every emission refused, on the other hand, is an order that failed.
  await send('Timed shutter', 'state', -1);
  const next = rememberLast(orders, config, client, { emissions: 2 });
  orders.remember(next, deviceNamed(config, 'Timed shutter'));
  const refused = { type: 0x105, channel: { id: 700, source: 7 }, thingnotes: { uid: next } };
  await applyEvents(gladys, config, [refused], new HeardChannels(), orders, scenes);
  assert.deepEqual(gladys.sceneEvents, []);
  await applyEvents(gladys, config, [refused], new HeardChannels(), orders, scenes);
  assert.deepEqual(
    gladys.sceneEvents.map((event) => [event.key, event.data.reason]),
    [['order_failed', 'TIMEOUT']],
  );
});

test('a state Gladys refuses once the order is on the air is not a failed radio order', async () => {
  const { gladys, config, client } = setup();
  const found = findDeviceByExternalId(gladys, config, deviceExternalId(config, 'Kitchen plug'));
  const command = () =>
    found.blueprint.onSetValue(gladys, {
      device: found.device,
      feature: featureOf(gladys, config, 'Kitchen plug', 'on-off'),
      value: 1,
      client,
    });

  gladys.publishState = async () => {
    throw new GladysApiError(429, 'TOO_MANY_REQUESTS', 'Too many states');
  };
  const refused = await command().catch((err) => err);
  assert.equal(client.sent.length, 1);
  assert.equal(refused.status, 429);
  assert.equal(isRadioFailure(refused), false);

  // The radio order failing is, and that one does fire order_failed.
  client.transfer = async () => {
    throw new Error('fetch failed');
  };
  assert.equal(isRadioFailure(await command().catch((err) => err)), true);
});

test('a weather sensor pasted without its features is told so, not blamed on its protocol', async () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify([{ name: 'Thermometer', type: 1, pid: 1368, addr: 542 }]),
  });
  const heard = new HeardChannels();
  const frame = {
    type: 3,
    channel: { id: 1368, source: 542 },
    thingnotes: {
      notes: [
        { type: NOTE_TYPES.TEMPERATURE, value: 294.65 },
        { type: NOTE_TYPES.R_HUMIDITY, value: 63 },
      ],
    },
  };

  const lines = captureLogs(async () =>
    applyEvents(gladys, config, [frame], heard, new SentOrders()),
  );
  await lines.result;

  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /temperature 21\.5, humidity 63/);
  assert.match(lines.of('INFO')[0], /Add "temperature", "humidity" to its "features"/);
  assert.doesNotMatch(lines.of('INFO')[0], /rolling-code/);
  const [entry] = heard.list();
  assert.match(
    describeFate(config, entry, 'en'),
    /add "temperature", "humidity" to its "features"/,
  );
  assert.match(describeFate(config, entry, 'fr'), /ajoutez "temperature", "humidity"/);
});

test('a remote held down for two seconds is still one click', async (t) => {
  // Its frames keep coming every half second: the window runs from the last
  // one, or a scene "on click, toggle" toggles twice in one long press.
  resetSensorClicks();
  t.after(resetSensorClicks);
  const gladys = createFakeGladys();
  const config = normalizeConfig({ devices: KEYFOB });
  const device = deviceNamed(config, 'Keyfob');
  const toggle = [{ kind: READINGS.TOGGLE, value: 'TOGGLE' }];

  for (let now = 0; now <= 2000; now += 500) {
    await sensor.applyReadings(gladys, { device, readings: toggle, now });
  }

  assert.deepEqual(gladys.statesOf(`${deviceExternalId(config, 'Keyfob')}:click`), [52]);
});

test('every button of a three-button remote clicks, stop and "my" included', async (t) => {
  resetSensorClicks();
  t.after(resetSensorClicks);
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({ devices: { Remote: { type: 1, channel: { id: 300, source: 9 } } } }),
  });
  const press = (value) => ({
    type: 3,
    channel: { id: 300, source: 9 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
  });

  const logs = captureLogs(() =>
    applyEvents(
      gladys,
      config,
      [
        press(STATE_VALUES.UP),
        press(STATE_VALUES.STOP),
        press(STATE_VALUES.DOWN),
        press(STATE_VALUES.USERPOSITION),
      ],
      new HeardChannels(),
      new SentOrders(),
      null,
    ),
  );

  assert.equal(await logs.result, 4);
  assert.deepEqual(
    gladys.statesOf(`${deviceExternalId(config, 'Remote')}:click`),
    [52, 52, 52, 52],
  );
  // Nothing claims a fully decoded STOP is a protocol only partially decoded.
  assert.deepEqual(
    logs.of('INFO').filter((line) => line.includes('says nothing')),
    [],
  );
});

test('a stop press on a sensor without "click" is told to add it, like up', async (t) => {
  // STOP and "my" click since any order is a press: the advice blamed the
  // device type and the remote instead of naming the missing feature.
  resetSensorClicks();
  t.after(resetSensorClicks);
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: { T: { type: 1, features: ['temperature'], channel: { id: 300, source: 9 } } },
    }),
  });
  const heard = new HeardChannels();
  const press = (value) => ({
    type: 3,
    channel: { id: 300, source: 9 },
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
  });

  for (const value of [STATE_VALUES.STOP, STATE_VALUES.USERPOSITION, STATE_VALUES.UP]) {
    const logs = captureLogs(() =>
      applyEvents(gladys, config, [press(value)], heard, new SentOrders(), null),
    );
    assert.equal(await logs.result, 0);
    assert.equal(logs.of('INFO').length, 1);
    assert.match(logs.of('INFO')[0], /Add "click" to its "features"/);
    assert.match(describeFate(config, heard.list()[0], 'en'), /add "click" to its "features"/);
  }
});

test('a click and a reading heard live are current states, so Gladys scenes run on them', async (t) => {
  // Gladys files a dated state as history and checks no scene trigger
  // against it: every live frame dated by the box was a scene that never ran.
  resetSensorClicks();
  t.after(resetSensorClicks);
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: {
        Keyfob: { type: 1, channel: { id: 610, source: 1 } },
        'Outdoor sensor': { type: 1, features: ['temperature'], channel: { id: 600, source: 6 } },
      },
    }),
  });
  const timestamp = Date.now() - 2000;

  await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        timestamp,
        channel: { id: 610, source: 1 },
        thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.TOGGLE }] },
      },
      {
        type: 3,
        timestamp,
        channel: { id: 600, source: 6 },
        thingnotes: { notes: [{ type: NOTE_TYPES.TEMPERATURE, value: 272.15 }] },
      },
    ],
    new HeardChannels(),
    new SentOrders(),
    null,
  );

  assert.deepEqual(gladys.published, [
    { featureExternalId: `${deviceExternalId(config, 'Keyfob')}:click`, state: 52 },
    { featureExternalId: `${deviceExternalId(config, 'Outdoor sensor')}:temperature`, state: -1 },
  ]);
});
