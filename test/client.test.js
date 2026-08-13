import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AirSendClient, toThingUid } from '../src/devmel/client.js';
import { normalizeConfig } from '../src/config.js';
import { NOTE_TYPES, stateNote, STATE_VALUES } from '../src/devmel/notes.js';

const DEVICE = {
  name: 'Kitchen plug',
  platformId: '200-2',
  channel: { id: 200, source: 2 },
  spurl: null,
  wait: false,
};

const realFetch = globalThis.fetch;
let calls = [];

/** Replace fetch with a scripted responder, one entry per expected call. */
function stubFetch(responder) {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return responder(String(url), options);
  };
}

function jsonResponse(status, body = {}) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function clientWith(overrides = {}) {
  const client = new AirSendClient();
  client.configure(
    normalizeConfig({
      service_url: 'http://192.168.1.50:33863',
      spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
      ...overrides,
    }),
  );
  return client;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a local transfer posts the notes to the AirSend Web Service', async () => {
  stubFetch(() => jsonResponse(200, { type: 3, thingnotes: { notes: [] } }));
  const client = clientWith();

  const result = await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { uid: 'feature-1' });

  assert.equal(result.transport, 'local');
  assert.equal(result.degraded, false);
  assert.equal(calls.length, 1);
  // The trailing slash is added whether or not the user typed it.
  assert.equal(calls[0].url, 'http://192.168.1.50:33863/airsend/transfer');
  assert.equal(
    calls[0].options.headers.Authorization,
    'Bearer sp://pass@[fe80::1]?rhost=192.168.1.50',
  );

  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.channel, DEVICE.channel);
  assert.deepEqual(body.thingnotes.notes, [
    { method: 1, type: NOTE_TYPES.STATE, value: STATE_VALUES.ON },
  ]);
  assert.equal(body.thingnotes.uid, toThingUid('feature-1'));
  // Fire-and-forget: the box needs somewhere to drop the answer.
  assert.equal(body.wait, false);
  assert.equal(body.callback, 'http://127.0.0.1/');
});

test('a read waits for the answer and returns its notes', async () => {
  stubFetch(() =>
    jsonResponse(200, {
      type: 3,
      thingnotes: { notes: [{ type: NOTE_TYPES.TEMPERATURE, value: 294.35 }] },
    }),
  );
  const client = clientWith();

  const result = await client.transfer(DEVICE, [{ method: 'QUERY', type: 'TEMPERATURE' }], {
    wait: true,
  });

  assert.deepEqual(result.notes, [{ type: NOTE_TYPES.TEMPERATURE, value: 294.35 }]);
  assert.equal(JSON.parse(calls[0].options.body).wait, true);
});

test('an unanswered read is an error, not a silent success', async () => {
  stubFetch(() => jsonResponse(200, { type: 0x101 }));
  const client = clientWith();

  await assert.rejects(
    () => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { wait: true }),
    /No radio confirmation/,
  );
});

test('an unreachable box is reported as such, with no other channel to try', async () => {
  stubFetch(() => {
    throw new Error('connect ECONNREFUSED');
  });
  const client = clientWith();

  await assert.rejects(
    () => client.transfer(DEVICE, [stateNote(STATE_VALUES.OFF)]),
    /connect ECONNREFUSED/,
  );
  assert.equal(calls.length, 1);
  // The badge remembers that nothing carried the order.
  assert.equal(client.transportOf(DEVICE).transport, 'unreachable');
});

test('a device with no transport reports itself unreachable', async () => {
  stubFetch(() => jsonResponse(200));
  const client = clientWith({ service_url: '', spurl: '', use_embedded_service: false });

  await assert.rejects(
    () => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]),
    /No transport configured/,
  );
  assert.equal(client.transportOf(DEVICE).transport, 'unreachable');
  assert.equal(calls.length, 0);
});

test('a refused connection string is reported with what to fix', async () => {
  stubFetch(() => jsonResponse(401));
  const client = clientWith();

  await assert.rejects(
    () => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]),
    /Invalid connection string/,
  );
});

test('bind subscribes the box to a radio channel', async () => {
  stubFetch(() => jsonResponse(200));
  const client = clientWith();

  await client.bind(1, 'https://webhook.example/gladys', DEVICE);

  assert.equal(calls[0].url, 'http://192.168.1.50:33863/airsend/bind');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    channel: { id: 1 },
    duration: 0,
    callback: 'https://webhook.example/gladys',
  });
});

test('pingLocal accepts the 401 the service answers on its root path', async () => {
  stubFetch(() => jsonResponse(401));
  assert.equal(await clientWith().pingLocal(), true);

  stubFetch(() => jsonResponse(502));
  await assert.rejects(() => clientWith().pingLocal(), /HTTP 502/);
});
