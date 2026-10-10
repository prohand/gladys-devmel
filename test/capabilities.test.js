// -----------------------------------------------------------------------------
// Gladys 5.1 capabilities: scene triggers, scene actions and the dashboard
// widget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from '../src/config.js';
import { applyEvents, setKnownPosition } from '../src/devices/index.js';
import { shutter } from '../src/devices/shutter.js';
import { NOTE_TYPES, STATE_VALUES } from '../src/devmel/notes.js';
import { AirSendError } from '../src/devmel/client.js';
import { HeardChannels } from '../src/devmel/heard.js';
import { SentOrders } from '../src/devmel/orders.js';
import { ShutterTravel } from '../src/devmel/travel.js';
import {
  failureReason,
  ordersOf,
  PRESS_WINDOW_MS,
  SCENE_TRIGGERS,
  SceneEvents,
} from '../src/capabilities/scenes.js';
import { buildRadioWidget } from '../src/capabilities/widget.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const SPURL = 'sp://pass@[fe80::1]?rhost=192.168.1.50';

const DEVICES = JSON.stringify({
  devices: {
    'AirSend box': { type: 0, sensors: true },
    Garage: { type: 4096, channel: { id: 100, source: 1 }, remotes: [11] },
    'Living room shutter': {
      type: 4098,
      travel: 20,
      channel: { id: 300, source: 3 },
      remotes: [42],
    },
    'Kitchen plug': { type: 4097, channel: { id: 200, source: 2 } },
  },
});

function setup({ now = () => 0 } = {}) {
  const gladys = createFakeGladys();
  const config = normalizeConfig({ devices: DEVICES, spurl: SPURL });
  const scenes = new SceneEvents({ now });
  return { gladys, config, scenes, heard: new HeardChannels(), orders: new SentOrders() };
}

function frame(channel, value) {
  return {
    type: 3,
    reliability: 0x20,
    channel,
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value }] },
  };
}

// --- Scene triggers ----------------------------------------------------------

test('a frame is read as the orders a scene can filter on', () => {
  assert.deepEqual(
    ordersOf([
      { kind: 'level', value: 100, command: 'up' },
      { kind: 'state', value: 'stop', command: 'stop' },
      { kind: 'level', value: 100 },
      { kind: 'level', value: 0 },
      { kind: 'toggle', value: 'TOGGLE' },
      { kind: 'temperature', value: 21 },
      { kind: 'level', value: 100, command: 'up' },
    ]),
    ['up', 'stop', 'on', 'off', 'toggle'],
  );
});

test('a wall remote pressed fires remote_pressed, with the device it drives', async (t) => {
  t.after(() => shutter.travel.clear());
  const { gladys, config, scenes, heard, orders } = setup();

  await applyEvents(
    gladys,
    config,
    [frame({ id: 300, source: 42 }, STATE_VALUES.DOWN)],
    heard,
    orders,
    scenes,
  );

  assert.deepEqual(gladys.sceneEvents, [
    {
      key: SCENE_TRIGGERS.REMOTE_PRESSED,
      data: {
        device: 'shutter:300-3',
        device_name: 'Living room shutter',
        order: 'down',
        pid: 300,
        addr: 42,
      },
    },
  ]);
});

test('a spare remote attached to a button is a scene trigger too', async () => {
  // A BUTTON publishes nothing when it hears a frame: the trigger is the only
  // thing that press can do in Gladys.
  const { gladys, config, scenes, heard, orders } = setup();

  await applyEvents(
    gladys,
    config,
    [frame({ id: 100, source: 11 }, STATE_VALUES.TOGGLE)],
    heard,
    orders,
    scenes,
  );

  assert.deepEqual(
    gladys.sceneEvents.map((event) => [event.data.device, event.data.order]),
    [['button:100-1', 'toggle']],
  );
});

test('a remote held down is one press, not one event per frame', async (t) => {
  t.after(() => shutter.travel.clear());
  let now = 0;
  const { gladys, config, scenes, heard, orders } = setup({ now: () => now });
  const press = () =>
    applyEvents(
      gladys,
      config,
      [frame({ id: 300, source: 42 }, STATE_VALUES.UP)],
      heard,
      orders,
      scenes,
    );

  await press();
  now += 500;
  await press();
  now += PRESS_WINDOW_MS;
  await press();

  assert.equal(gladys.sceneEvents.length, 2);
});

test("Gladys' own orders never fire remote_pressed: no scene can loop on itself", async (t) => {
  t.after(() => shutter.travel.clear());
  const { gladys, config, scenes, heard, orders } = setup();
  const device = config.devmelDevices.find((entry) => entry.name === 'Living room shutter');
  orders.remember('0xabc', device);

  await applyEvents(
    gladys,
    config,
    [frame({ id: 300, source: 3 }, STATE_VALUES.UP)],
    heard,
    orders,
    scenes,
  );

  assert.deepEqual(gladys.sceneEvents, []);
});

test('an order the box reports as failed fires order_failed', async () => {
  const { gladys, config, scenes, heard, orders } = setup();
  const device = config.devmelDevices.find((entry) => entry.name === 'Kitchen plug');
  orders.remember('0xdead', device);

  await applyEvents(
    gladys,
    config,
    [{ type: 0x103, channel: { ...device.channel }, thingnotes: { uid: '0xdead', notes: [] } }],
    heard,
    orders,
    scenes,
  );

  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].key, SCENE_TRIGGERS.ORDER_FAILED);
  assert.equal(gladys.sceneEvents[0].data.device, 'switch:200-2');
  assert.equal(gladys.sceneEvents[0].data.reason, 'SECURITY');
});

test('a failure is named the way a scene can filter it', () => {
  assert.equal(failureReason(new AirSendError('x', { eventType: 0x102 })), 'SYNCHRONIZATION');
  assert.equal(failureReason(new AirSendError('x', { status: 401 })), 'HTTP_401');
  assert.equal(failureReason(new AirSendError('x', { transport: 'unreachable' })), 'UNREACHABLE');
  assert.equal(failureReason(new Error('fetch failed')), 'ERROR');
});

test('a Gladys that refuses scene events costs the radio path nothing', async () => {
  const scenes = new SceneEvents();
  const gladys = {
    async publishSceneEvent() {
      throw new Error('404 Not Found');
    },
  };

  assert.equal(
    await scenes.remotePressed(gladys, { externalId: 'x', name: 'x', order: 'up' }),
    false,
  );
});

// --- The box never claims radio frames ---------------------------------------

test('a frame with no address on pid 1 is somebody else, never the box', async () => {
  const { gladys, config, scenes, heard, orders } = setup();

  await applyEvents(
    gladys,
    config,
    [
      {
        type: 3,
        reliability: 0x20,
        channel: { id: 1 },
        thingnotes: { notes: [{ type: NOTE_TYPES.TEMPERATURE, value: 293.15 }] },
      },
    ],
    heard,
    orders,
    scenes,
  );

  // Not published on the box sensors, and left for "Attach a remote".
  assert.deepEqual(gladys.published, []);
  assert.equal(heard.list()[0].claimed, false);
});

// --- Scene actions -----------------------------------------------------------

test('set_known_position tells the travel where a shutter is, without moving it', async (t) => {
  const previous = shutter.travel;
  shutter.travel = new ShutterTravel();
  t.after(() => {
    shutter.travel.clear();
    shutter.travel = previous;
  });
  const { gladys, config } = setup();

  const position = await setKnownPosition(gladys, config, 'shutter:300-3', 35);

  assert.equal(position, 35);
  const device = config.devmelDevices.find((entry) => entry.name === 'Living room shutter');
  assert.equal(shutter.travel.positionOf(device), 35);
  assert.deepEqual(gladys.statesOf('shutter:300-3:position'), [35]);
  assert.deepEqual(gladys.statesOf('shutter:300-3:state'), [0]);
});

test('set_known_position refuses what is not a shutter with a position', async () => {
  const { gladys, config } = setup();

  await assert.rejects(setKnownPosition(gladys, config, 'switch:200-2', 50), /not a shutter/);
  await assert.rejects(setKnownPosition(gladys, config, 'shutter:999', 50), /No Devmel device/);
  await assert.rejects(setKnownPosition(gladys, config, 'shutter:300-3', 'abc'), /position/);
});

// --- Dashboard widget --------------------------------------------------------

function widgetOf(overrides = {}) {
  const { gladys, config, heard } = setup();
  return buildRadioWidget({
    gladys,
    config,
    service: { status: () => ({ running: true }) },
    listen: {
      url: 'http://127.0.0.1:33864/',
      error: null,
      plan: { enabled: true, channel: 300, name: 'Somfy RTS' },
    },
    heard,
    now: 10000,
    ...overrides,
  });
}

test('the radio widget fits the core vocabulary and budget, empty or full', () => {
  const heard = new HeardChannels({ now: () => 5000 });
  for (let source = 1; source <= 10; source += 1) {
    heard.record({ id: 300, source }, { readings: [], claimed: false, timestamp: 5000 });
  }
  heard.record({ id: 14177 }, { dropped: 'unreliable, graded 2', timestamp: 6000 });
  heard.received({ own: true });

  for (const content of [
    widgetOf(),
    widgetOf({ heard }),
    widgetOf({ heard, settings: { emitters: 0 } }),
    widgetOf({ listen: null, service: { status: () => ({ running: false }) } }),
  ]) {
    assert.deepEqual(validateWidgetContent(content), []);
  }
});

test('the radio widget lists the emitters heard, and what became of them', () => {
  const heard = new HeardChannels({ now: () => 5000 });
  heard.record({ id: 300, source: 42 }, { readings: [], claimed: true, timestamp: 5000 });
  heard.record({ id: 300, source: 99 }, { readings: [], claimed: false, timestamp: 6000 });

  const content = widgetOf({ heard, settings: { emitters: 8 } });
  const list = content.components.find((component) => component.type === 'card-list');

  assert.deepEqual(
    list.items.map((item) => [item.subtitle.en, item.badge.text.en]),
    [
      ['addr 99 · 1 frame', 'unknown'],
      ['addr 42 · 1 frame', 'mute'],
    ],
  );
  // The box sensors, live, bound to their features.
  assert.deepEqual(
    content.components.filter((c) => c.device_feature).map((c) => c.device_feature),
    ['gateway:airsend-box:temperature', 'gateway:airsend-box:illuminance'],
  );
});

test('the radio widget says what is missing before anything can work', () => {
  const gladys = createFakeGladys();
  const content = buildRadioWidget({ gladys, config: normalizeConfig({}) });

  assert.equal(content.components[0].type, 'text');
  assert.match(content.components[0].text.en, /sp:\/\//);
  assert.deepEqual(validateWidgetContent(content), []);
});

test('the radio widget says "no box" rather than "no route" without a connection string', () => {
  const gladys = createFakeGladys();
  const content = buildRadioWidget({
    gladys,
    config: normalizeConfig({}),
    listen: { url: null, error: null, plan: { enabled: true, channel: 1 } },
  });
  const status = content.components.find((component) => component.type === 'status');
  const listening = status.items.find((item) => item.label.en === 'Listening');

  assert.equal(listening.value.en, 'no box');
  assert.deepEqual(validateWidgetContent(content), []);
});

test('every scene event carries each filter and variable its trigger declares', async () => {
  // A declared key missing from the data reads as null in a scene, and a filter
  // on it never matches: the trigger would look broken with nothing in the logs.
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(
    await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
  );
  const sent = [];
  const gladys = { publishSceneEvent: async (key, data) => sent.push({ key, data }) };
  const scenes = new SceneEvents();
  await scenes.remotePressed(gladys, {
    externalId: 'shutter:300-3',
    name: 'Living room shutter',
    order: 'down',
    channel: { id: 300, source: 42 },
  });
  await scenes.orderFailed(gladys, {
    externalId: 'switch:200-2',
    name: 'Kitchen plug',
    reason: 'SECURITY',
    message: 'refused',
  });

  for (const trigger of manifest.scene_triggers) {
    const event = sent.find((entry) => entry.key === trigger.key);
    assert.ok(event, `${trigger.key} is fired by the code`);
    const declared = [...(trigger.fields ?? []), ...(trigger.variables ?? [])].map((f) => f.key);
    for (const key of declared) {
      assert.ok(key in event.data, `${trigger.key} carries ${key}`);
    }
  }

  const rearm = manifest.scene_actions.find((action) => action.key === 'rearm_listening');
  assert.deepEqual(
    rearm.outputs.map((output) => output.key),
    ['channel'],
    'index.js answers rearm_listening with { channel }',
  );
});
