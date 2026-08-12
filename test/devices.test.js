import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  applyEvents,
  buildDiscoveredDevices,
  buildTransportEntries,
  findBlueprintByType,
  findDeviceByExternalId,
  identifyDevice,
} from '../src/devices/index.js';
import { NOTE_TYPES, STATE_VALUES } from '../src/devmel/notes.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeClient } from './helpers/fakeAirSend.js';

const DEVICES = `devices:
  AirSend box:
    type: 0
    sensors: true
  Silent box:
    type: 0
    id: 999
  Garage:
    type: 4096
    channel: { id: 100, source: 1 }
  Kitchen plug:
    type: 4097
    channel: { id: 200, source: 2 }
  Living room shutter:
    type: 4098
    channel: { id: 300, source: 3 }
  Bedroom shutter:
    type: 4099
    invert: true
    channel: { id: 400, source: 4 }
  Pergola light:
    type: 4100
    channel: { id: 500, source: 5 }
  Outdoor sensor:
    type: 1
    features: [temperature, humidity]
    channel: { id: 600, source: 6 }`;

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

test('the box sensors are read by polling', async () => {
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
