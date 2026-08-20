import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AirSendClient, toThingUid, WARM_AFTER_MS } from '../src/devmel/client.js';
import { DEVICE_TYPES, normalizeConfig } from '../src/config.js';
import {
  levelNote,
  NOTE_TYPES,
  queryNote,
  QUERY_TYPES,
  stateNote,
  STATE_VALUES,
} from '../src/devmel/notes.js';
import { SentOrders } from '../src/devmel/orders.js';
import { captureLogs } from './helpers/captureLogs.js';

const DEVICE = {
  name: 'Kitchen plug',
  platformId: '200-2',
  channel: { id: 200, source: 2 },
  spurl: null,
  wait: false,
};

/** The box itself: it answers on channel 1, and answers for itself. */
const BOX = {
  name: 'AirSend',
  platformId: '1-',
  rtype: DEVICE_TYPES.BOX,
  channel: { id: 1 },
  spurl: null,
  wait: true,
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

/**
 * A client whose radio gaps and retry delays are instant, and which sends every
 * order once: repeats and waiting are what the tests below drive on purpose.
 */
function clientWith(overrides = {}) {
  const client = new AirSendClient({ sleep: async () => {}, orders: new SentOrders() });
  client.configure(
    normalizeConfig({
      service_url: 'http://192.168.1.50:33863',
      spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
      command_repeat: 0,
      ...overrides,
    }),
  );
  return client;
}

/**
 * A client on a clock the test drives: `now` is what every delay is measured
 * against, so a "slow" box is one whose answer moves it.
 */
function clientOnClock(tick) {
  const client = new AirSendClient({
    sleep: async () => {},
    orders: new SentOrders(),
    now: () => tick.at,
  });
  client.configure(
    normalizeConfig({
      service_url: 'http://192.168.1.50:33863',
      spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
      command_repeat: 0,
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
    /did not carry the order: NETWORK \(event type 257\)/,
  );
});

test('a failure the box names is retried only when a second go can change it', async () => {
  // The box says WHERE the order died. A link that lost its thread may well
  // hold the next one; a connection string it refuses is refused just as fast
  // the second time, and trying again only makes the user wait for it.
  const client = clientWith();

  stubFetch(() => jsonResponse(200, { type: 258 }));
  await assert.rejects(
    () => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { wait: true }),
    /SYNCHRONIZATION \(event type 258\)/,
  );
  assert.equal(calls.length, 2);

  stubFetch(() => jsonResponse(200, { type: 259 }));
  await assert.rejects(
    () => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { wait: true }),
    /SECURITY \(event type 259\)/,
  );
  assert.equal(calls.length, 1);
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
  // Tried again — a box that answered nothing may well answer the next one —
  // and then given up on: there is no second channel to fall back to.
  assert.equal(calls.length, 2);
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

test('listChannels reads the protocol table of the service', async () => {
  const table = [
    { id: 1, name: 'Generic 433MHz' },
    { id: 25455, name: 'Somfy RTS', getDecoder: 25455 },
  ];
  stubFetch(() => jsonResponse(200, table));
  const client = clientWith();

  assert.deepEqual(await client.listChannels(), table);
  assert.equal(calls[0].url, 'http://192.168.1.50:33863/channels/');
  assert.equal(calls[0].options.method, 'GET');
  // It describes the service, not a box: no connection string is involved.
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test('listChannels refuses to guess when the service does not answer the table', async () => {
  stubFetch(() => jsonResponse(500));
  await assert.rejects(() => clientWith().listChannels(), /HTTP 500/);

  // A body that is not the expected list is no table either.
  stubFetch(() => jsonResponse(200, { error: 'nope' }));
  assert.deepEqual(await clientWith().listChannels(), []);
});

test('pingLocal accepts the 401 the service answers on its root path', async () => {
  stubFetch(() => jsonResponse(401));
  assert.equal(await clientWith().pingLocal(), true);

  stubFetch(() => jsonResponse(502));
  await assert.rejects(() => clientWith().pingLocal(), /HTTP 502/);
});

// --- Getting the order through --------------------------------------------
// Nothing acknowledges a 433 MHz order: a frame lost in the noise is a click
// that did nothing, and the only defences are to say it again and to leave the
// box alone between two transmissions.

test('an order is repeated on the air, the way a remote repeats it', async () => {
  stubFetch(() => jsonResponse(200, { type: 3 }));
  const client = clientWith({ command_repeat: 2 });

  await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]);

  // Answered as soon as it is on the air: the repeats are a second chance for a
  // frame lost in the noise, and nothing in Gladys has to wait for them.
  assert.equal(calls.length, 1);

  await client.idle();
  assert.equal(calls.length, 3);
  // The same order, word for word: a repeat is not a second command.
  const bodies = calls.map((call) => call.options.body);
  assert.equal(new Set(bodies).size, 1);
});

test('the repeats keep their place in front of the next command', async () => {
  stubFetch(() => jsonResponse(200, { type: 3 }));
  const client = clientWith({ command_repeat: 1 });

  // Exactly what a user does: open, then close. Answering before the repeats
  // must not let the second order overtake the first one on the air.
  await client.transfer(DEVICE, [stateNote(STATE_VALUES.OPEN)]);
  await client.transfer(DEVICE, [stateNote(STATE_VALUES.CLOSE)]);
  await client.idle();

  assert.deepEqual(
    calls.map((call) => JSON.parse(call.options.body).thingnotes.notes[0].value),
    [STATE_VALUES.OPEN, STATE_VALUES.OPEN, STATE_VALUES.CLOSE, STATE_VALUES.CLOSE],
  );
});

test('a repeat that fails changes nothing: the order did go out', async () => {
  let answered = 0;
  stubFetch(() => {
    answered += 1;
    // The first emission is carried; every attempt after it is refused.
    return jsonResponse(answered === 1 ? 200 : 401, { type: 3 });
  });
  const client = clientWith({ command_repeat: 2 });

  const result = await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]);
  await client.idle();

  assert.equal(result.transport, 'local');
  assert.equal(client.busy, false);
});

test('an order whose meaning depends on how often it is heard is sent once', async () => {
  stubFetch(() => jsonResponse(200, { type: 3 }));
  const client = clientWith({ command_repeat: 2 });

  // A push button TOGGLE heard twice is back where it started.
  await client.transfer(DEVICE, [stateNote(STATE_VALUES.TOGGLE)]);
  assert.equal(calls.length, 1);

  // A read is answered once, and the answer is the point.
  await client.transfer(DEVICE, [{ method: 'QUERY', type: 'TEMPERATURE' }], { wait: true });
  assert.equal(calls.length, 2);
});

test('a device can ask for more repeats than the rest of the house', async () => {
  stubFetch(() => jsonResponse(200, { type: 3 }));
  const client = clientWith({ command_repeat: 0 });

  await client.transfer({ ...DEVICE, repeat: 2 }, [levelNote(40)]);
  await client.idle();

  assert.equal(calls.length, 3);
});

test('a transmission the box could not carry is tried again', async () => {
  let answered = 0;
  stubFetch(() => {
    answered += 1;
    // 500 is what the service answers when the box got no radio confirmation.
    return jsonResponse(answered === 1 ? 500 : 200, { type: 3 });
  });
  const client = clientWith();

  const result = await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]);

  assert.equal(result.transport, 'local');
  assert.equal(calls.length, 2);
});

test('a refusal is not tried again: the answer would be the same', async () => {
  stubFetch(() => jsonResponse(405));
  const client = clientWith();

  await assert.rejects(
    () => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]),
    /Invalid input/,
  );
  assert.equal(calls.length, 1);
});

test('orders reach the box one at a time, in the order they were given', async () => {
  const started = [];
  const finished = [];
  let release = null;
  stubFetch((url, options) => {
    const value = JSON.parse(options.body).thingnotes.notes[0].value;
    started.push(value);
    return new Promise((resolve) => {
      release = () => {
        finished.push(value);
        resolve(jsonResponse(200, { type: 3 }));
      };
    });
  });
  const client = clientWith();

  const first = client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]);
  const second = client.transfer(DEVICE, [stateNote(STATE_VALUES.OFF)]);
  await new Promise(setImmediate);

  // The second order waits: a box busy transmitting hears nothing of it.
  assert.deepEqual(started, [STATE_VALUES.ON]);
  release();
  await first;
  await new Promise(setImmediate);
  assert.deepEqual(started, [STATE_VALUES.ON, STATE_VALUES.OFF]);
  release();
  await second;
  assert.deepEqual(finished, [STATE_VALUES.ON, STATE_VALUES.OFF]);
});

test('every exchange says the radio was used, so listening can be re-armed', async () => {
  stubFetch(() => jsonResponse(200, { type: 3 }));
  const client = clientWith();
  let transmissions = 0;
  client.afterTransmit = () => {
    transmissions += 1;
  };

  await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]);
  assert.equal(transmissions, 1);

  // Including the ones that failed: the box transmitted, or tried to.
  stubFetch(() => jsonResponse(401));
  await assert.rejects(() => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]));
  assert.equal(transmissions, 2);
});

test('an order is remembered, so its echo is not replayed as a fresh one', async () => {
  stubFetch(() => jsonResponse(200, { type: 3 }));
  const client = clientWith();

  await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { uid: 'feature-1' });

  const echo = { channel: DEVICE.channel, thingnotes: { uid: toThingUid('feature-1') } };
  assert.equal(client.orders.match(echo)?.name, DEVICE.name);
});

test('an order that took its time says where the time went', async () => {
  // "It reacts, but three seconds later" has two causes that look identical
  // from the sofa: the queue, which is ours, and the box, which is not.
  const tick = { at: 0 };
  const client = clientOnClock(tick);
  stubFetch(() => {
    tick.at += 4000;
    return jsonResponse(200, { type: 3, thingnotes: { notes: [] } });
  });

  const lines = captureLogs(() =>
    client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { uid: 'feature-1' }),
  );
  await lines.result;

  assert.equal(lines.of('INFO').length, 1);
  assert.match(lines.of('INFO')[0], /took 4\.0 s to reach the air/);
  assert.match(lines.of('INFO')[0], /0\.0 s waiting for the radio, 4\.0 s in the box/);
  // The half that can be acted on, named: nothing here says "raise something".
  assert.match(lines.of('INFO')[0], /The time went into the box, not into the queue/);
});

test('an order that left straight away says nothing above debug', async () => {
  const tick = { at: 0 };
  const client = clientOnClock(tick);
  stubFetch(() => {
    tick.at += 120;
    return jsonResponse(200, { type: 3, thingnotes: { notes: [] } });
  });

  const lines = captureLogs(() => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]));
  await lines.result;

  assert.equal(lines.of('INFO').length, 0);
});

test('a box left alone is touched, one that was just used is left in peace', async () => {
  // The delay a user notices is the first order after a quiet evening: it pays
  // for waking a link nothing has used since. This is what stops it.
  const tick = { at: 0 };
  const client = clientOnClock(tick);
  stubFetch(() => jsonResponse(200, { type: 3, thingnotes: { notes: [] } }));

  assert.equal(await client.keepWarm(BOX), false, 'nothing to wake yet');
  assert.equal(calls.length, 0);

  tick.at = WARM_AFTER_MS + 1;
  assert.equal(await client.keepWarm(BOX), true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  // A read of the box own sensors: it reaches the box, and never the air.
  assert.equal(body.wait, true);
  assert.deepEqual(body.thingnotes.notes, [{ method: 'QUERY', type: 'TEMPERATURE' }]);

  // And it counts as having spoken to the box, so the next tick does nothing.
  assert.equal(await client.keepWarm(BOX), false);
});

test('a box that refuses to be warmed is not an error anybody has to read', async () => {
  const tick = { at: WARM_AFTER_MS + 1 };
  const client = clientOnClock(tick);
  // A box with no sensor to read answers UNSUPPORTED, which is an exchange all
  // the same — the very exchange the warming is for.
  stubFetch(() => jsonResponse(200, { type: 262 }));

  const lines = captureLogs(() => client.keepWarm(BOX));

  assert.equal(await lines.result, true);
  assert.equal(lines.of('INFO').length, 0);
  assert.equal(lines.of('WARN').length, 0);
});

test('reading the box own sensors does not file channel 1 as a voice of ours', async () => {
  // The box answers on channel 1 for itself: nothing goes on the air, so there
  // is no echo to recognize. Filing it would make every generic 433 MHz frame
  // heard without an address look like an order of Gladys coming back.
  const orders = new SentOrders();
  const client = new AirSendClient({ sleep: async () => {}, orders });
  client.configure(
    normalizeConfig({
      service_url: 'http://192.168.1.50:33863',
      spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
    }),
  );
  stubFetch(() => jsonResponse(200, { type: 3, thingnotes: { notes: [] } }));

  await client.transfer(BOX, [queryNote(QUERY_TYPES.TEMPERATURE)], { wait: true });

  assert.equal(orders.match({ channel: { id: 1 } }), null);
});
