// -----------------------------------------------------------------------------
// The loopback server the AirSend Web Service posts the heard frames to.
//
// These tests talk to it the way the service does: a plain HTTP POST carrying
// `{ "events": [...] }`, from the same machine.
// -----------------------------------------------------------------------------

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CallbackServer, DEFAULT_CALLBACK_PORT, eventsOf } from '../src/devmel/callback.js';
import { createServer } from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { applyEvents, findBlueprintByType } from '../src/devices/index.js';
import { shutter } from '../src/devices/shutter.js';
import { ShutterTravel } from '../src/devmel/travel.js';
import { STATE_VALUES } from '../src/devmel/notes.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeClock } from './helpers/fakeClock.js';

const running = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop().stop();
  }
});

function start(options) {
  const server = new CallbackServer({ port: 0, ...options });
  running.push(server);
  return server;
}

async function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const FRAME = {
  events: [
    {
      type: 3,
      reliability: 0x20,
      channel: { id: 25455, source: 8295 },
      thingnotes: { notes: [{ type: 0, value: 35 }] },
      timestamp: 1765432100000,
    },
  ],
};

test('the default port is the one after the AirSend Web Service', () => {
  assert.equal(DEFAULT_CALLBACK_PORT, 33864);
});

test('it listens on the loopback and hands the events over', async () => {
  const received = [];
  const server = start();
  const url = await server.start(async (events) => received.push(events));

  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const response = await post(url, FRAME);

  assert.equal(response.status, 200);
  assert.deepEqual(received, [FRAME.events]);
});

test('the answer is a 200 even when nothing understands the frame', async () => {
  const server = start();
  const url = await server.start(async () => {
    throw new Error('should not be called');
  });

  for (const body of ['not json', '{}', '{"events":[]}']) {
    assert.equal((await post(url, body)).status, 200);
  }
});

test('a handler that throws does not take the server down', async () => {
  const server = start();
  const url = await server.start(async () => {
    throw new Error('Gladys is unreachable');
  });

  assert.equal((await post(url, FRAME)).status, 200);
  // Still serving the next frame.
  assert.equal((await post(url, FRAME)).status, 200);
});

test('starting twice keeps the same URL and only swaps the handler', async () => {
  const first = [];
  const second = [];
  const server = start();

  const url = await server.start(async (events) => first.push(events));
  assert.equal(await server.start(async (events) => second.push(events)), url);

  await post(url, FRAME);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [FRAME.events]);
});

test('a taken port does not cost the listener: a free one is used instead', async () => {
  const busy = createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const port = busy.address().port;

  try {
    const server = start({ port });
    const url = await server.start(async () => {});

    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.notEqual(new URL(url).port, String(port));
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }
});

test('a stopped server stops answering', async () => {
  const server = new CallbackServer({ port: 0 });
  const url = await server.start(async () => {});
  await server.stop();

  assert.equal(server.url, null);
  await assert.rejects(post(url, FRAME));
});

test('a frame posted by the service moves the position of a timed shutter', async (t) => {
  // The whole way in, as it happens in production: the AirSend Web Service
  // posts what it heard on the loopback, and a shutter nobody touched in Gladys
  // starts travelling.
  const gladys = createFakeGladys();
  const config = normalizeConfig({
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
    devices: JSON.stringify({
      devices: { 'Volet salon': { type: 4098, travel_up: 20, pid: 25455, addr: 8295 } },
    }),
  });
  const clock = createFakeClock();
  const previous = shutter.travel;
  shutter.travel = new ShutterTravel({ now: clock.now, timers: clock.timers, tickMs: 1000 });
  t.after(() => {
    shutter.travel.clear();
    shutter.travel = previous;
  });

  const server = start();
  const url = await server.start((events) => applyEvents(gladys, config, events));

  const device = config.devmelDevices[0];
  const ids = gladys.externalIds(findBlueprintByType(device.rtype).key, device.platformId);
  await post(url, {
    events: [
      {
        type: 3,
        reliability: 0x20,
        channel: { id: 25455, source: 8295, mac: 12, seed: 34 },
        thingnotes: { notes: [{ method: 1, type: 0, value: STATE_VALUES.UP }] },
        timestamp: Date.now(),
      },
    ],
  });
  // The travel starts from an unknown position: only the end stop, twenty
  // seconds later, says where the shutter is.
  await clock.advance(20000);

  // The state is dated with the box timestamp, the arrival is dated by Gladys.
  assert.deepEqual(
    gladys.statesOf(ids.feature('state')).map((state) => state.state ?? state),
    [1],
  );
  assert.deepEqual(gladys.statesOf(ids.feature('position')), [100]);
});

test('the events of a body: the documented list, a lone event, or nothing', () => {
  assert.deepEqual(eventsOf(JSON.stringify(FRAME)), FRAME.events);
  assert.deepEqual(eventsOf(JSON.stringify(FRAME.events[0])), [FRAME.events[0]]);
  assert.deepEqual(eventsOf(JSON.stringify(FRAME.events)), FRAME.events);
  assert.deepEqual(eventsOf('{"nothing":true}'), []);
  assert.deepEqual(eventsOf('<html>'), []);
  assert.deepEqual(eventsOf(''), []);
});
