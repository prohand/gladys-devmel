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
  restoreDeviceStates,
} from '../src/devices/index.js';
import { shutter } from '../src/devices/shutter.js';
import { NOTE_TYPES, STATE_VALUES } from '../src/devmel/notes.js';
import { toThingUid } from '../src/devmel/client.js';
import { HeardChannels } from '../src/devmel/heard.js';
import { SentOrders } from '../src/devmel/orders.js';
import { ShutterTravel } from '../src/devmel/travel.js';
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
  assert.match(first.of('INFO')[0], /Set the listening channel to that pid/);

  // Once is a diagnosis; every press is noise.
  const again = captureLogs(
    async () => applyEvents(gladys, config, [frame()], heard, new SentOrders()),
    'debug',
  );
  await again.result;
  assert.equal(again.of('INFO').length, 0);
  assert.equal(again.of('DEBUG').length, 1);
});

test('accepting unreliable frames lets a badly graded remote through', async () => {
  const gladys = createFakeGladys();
  const devices = JSON.stringify({
    devices: {
      'Living room shutter': { type: 4098, channel: { id: 300, source: 3 }, remotes: [42] },
    },
  });
  const frame = {
    type: 3,
    reliability: 0x2,
    channel: { id: 300, source: 42 },
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
