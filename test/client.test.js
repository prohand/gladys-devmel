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

test('a badge learnt by another route gives way to what the new configuration allows', async () => {
  // A configuration saved republishes the badges: the one a failed order left
  // must not survive the connection string that fixes it, nor `local` the
  // removal of that string.
  stubFetch(() => jsonResponse(200));
  const client = clientWith({ spurl: '' });
  await assert.rejects(() => client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]));
  assert.equal(client.transportOf(DEVICE).transport, 'unreachable');

  const fixed = normalizeConfig({
    service_url: 'http://192.168.1.50:33863',
    spurl: 'sp://pass@192.168.1.50',
  });
  client.configure(fixed);
  assert.equal(client.transportOf(DEVICE), undefined);

  await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]);
  assert.deepEqual(client.transportOf(DEVICE), { transport: 'local', degraded: false });
  // The same configuration again (a reconnection): what it taught us stays.
  client.configure(fixed);
  assert.equal(client.transportOf(DEVICE).transport, 'local');

  client.configure(normalizeConfig({ service_url: 'http://192.168.1.50:33863', spurl: '' }));
  assert.equal(client.transportOf(DEVICE), undefined);
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

test('every bind waits for what the integration holds it back for, outside the queue', async () => {
  // A bind holds the radio while the box subscribes: the STOP of a timed
  // shutter falling due meanwhile waited behind it. The hold is the client's,
  // so no path that binds can forget it.
  stubFetch(() => jsonResponse(200));
  const client = clientWith();
  let release = null;
  client.beforeBind = () =>
    new Promise((resolve) => {
      release = resolve;
    });

  const binding = client.bind(1, 'https://webhook.example/gladys', DEVICE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0, 'nothing bound while held back');
  // Held OUTSIDE the queue: what falls due meanwhile goes out first.
  await client.transfer(DEVICE, [stateNote(STATE_VALUES.STOP)]);
  release();
  await binding;

  assert.deepEqual(
    calls.map((call) => call.url.split('/').at(-1)),
    ['transfer', 'bind'],
  );
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

test('a newer order to the same device drops the repeats of the older one', async () => {
  // Past the first repeat, the repeats join the queue one at a time: without
  // this, an UP repeated behind the STOP that followed it set the shutter off
  // again.
  stubFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return jsonResponse(200, { type: 3 });
  });
  const client = clientWith({ command_repeat: 2 });

  await client.transfer(DEVICE, [stateNote(STATE_VALUES.UP)]);
  await client.transfer(DEVICE, [stateNote(STATE_VALUES.STOP)]);
  await client.idle();
  await client.idle();

  const sent = calls.map((call) => JSON.parse(call.options.body).thingnotes.notes[0].value);
  // Nothing after the STOP, which is itself said once (see the next test).
  assert.deepEqual(sent.slice(sent.indexOf(STATE_VALUES.STOP)), [STATE_VALUES.STOP]);
});

test('a STOP goes out once, whatever the repeats: a second one is the Somfy "my" press', async () => {
  // A repeat is a separate press, reaching a shutter the first STOP has just
  // stopped: on Somfy RTS that sends it to its favourite position, while
  // Gladys shows where it was stopped.
  stubFetch(() => jsonResponse(200, { type: 3 }));
  const client = clientWith({ command_repeat: 2 });

  await client.transfer(DEVICE, [stateNote(STATE_VALUES.STOP)]);
  await client.idle();

  assert.equal(calls.length, 1);
});

test('a STOP that may have gone out is not sent a second time', async () => {
  stubFetch(() => jsonResponse(500));
  const client = clientWith();

  await assert.rejects(
    () => client.transfer(DEVICE, [stateNote(STATE_VALUES.STOP)]),
    /no radio confirmation/,
  );
  assert.equal(calls.length, 1);
});

test('an order retried behind a newer one is dropped, not sent after it', async () => {
  // UP hangs until the request times out, though its frame may well have gone
  // out: the shutter moves, the user clicks STOP, which waits behind it. A
  // retry of UP sent after that STOP set the shutter off again.
  let hung = null;
  stubFetch(() => {
    if (calls.length === 1) {
      return new Promise((resolve, reject) => {
        hung = () =>
          reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));
      });
    }
    return jsonResponse(200, { type: 3 });
  });
  const client = clientWith();
  let transports = 0;
  client.rememberTransport = (device, transport) => {
    transports += 1;
    assert.equal(transport, 'local', "the badge is the STOP's, which went through");
  };

  const up = client.transfer(DEVICE, [stateNote(STATE_VALUES.UP)]);
  await new Promise(setImmediate);
  const stop = client.transfer(DEVICE, [stateNote(STATE_VALUES.STOP)]);
  hung();

  // UP did fail: nothing says it reached the shutter, and nothing must now
  // announce it open and start tracking a travel to the top.
  await assert.rejects(up, /timed out/);
  await stop;
  await client.idle();

  assert.deepEqual(
    calls.map((call) => JSON.parse(call.options.body).thingnotes.notes[0].value),
    [STATE_VALUES.UP, STATE_VALUES.STOP],
  );
  assert.equal(transports, 1);
});

test('a repeat waiting behind other devices is dropped once a remote overrode its order', async () => {
  // A scene opens two shutters at once: the repeat of the first one queues
  // behind the second one's order. The wall remote pressed STOP meanwhile, and
  // the repeated UP must not undo it.
  const SECOND = { ...DEVICE, name: 'Office plug', platformId: '201-2', channel: { id: 201 } };
  let release = null;
  stubFetch((url, options) => {
    if (JSON.parse(options.body).channel.id === SECOND.channel.id && !release) {
      return new Promise((resolve) => {
        release = () => resolve(jsonResponse(200, { type: 3 }));
      });
    }
    return jsonResponse(200, { type: 3 });
  });
  const client = clientWith({ command_repeat: 1 });

  const first = client.transfer(DEVICE, [stateNote(STATE_VALUES.UP)]);
  const second = client.transfer(SECOND, [stateNote(STATE_VALUES.UP)]);
  await first;
  await new Promise(setImmediate);
  client.supersede(DEVICE);
  release();
  await second;
  await client.idle();

  const onFirst = calls.filter((call) => JSON.parse(call.options.body).channel.id === 200);
  assert.equal(onFirst.length, 1);
  // The other shutter was told nothing new: its repeat still goes out.
  assert.equal(calls.length - onFirst.length, 2);
});

test('an order that no longer applies when its turn comes is dropped unsent', async () => {
  // The STOP that ends a timed travel waits behind another shutter's order;
  // meanwhile a wall remote sets the shutter off again. Sent anyway, the STOP
  // stopped the shutter the user had just sent somewhere else.
  const SECOND = { ...DEVICE, name: 'Office plug', platformId: '201-2', channel: { id: 201 } };
  let release = null;
  stubFetch((url, options) => {
    if (JSON.parse(options.body).channel.id === SECOND.channel.id) {
      return new Promise((resolve) => {
        release = () => resolve(jsonResponse(200, { type: 3 }));
      });
    }
    return jsonResponse(200, { type: 3 });
  });
  const client = clientWith();
  let stale = false;

  const second = client.transfer(SECOND, [stateNote(STATE_VALUES.UP)]);
  const stop = client.transfer(DEVICE, [stateNote(STATE_VALUES.STOP)], { stale: () => stale });
  await new Promise(setImmediate);
  stale = true;
  release();
  await second;

  const answer = await stop;
  assert.equal(answer.dropped, true);
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.options.body).channel.id),
    [SECOND.channel.id],
  );
  // Nothing failed: the badge has nothing to say about it.
  assert.equal(client.transportOf(DEVICE), undefined);
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

test('a TOGGLE that may have gone out is not sent a second time', async () => {
  // The gate opened on the first emission and the box timed out answering:
  // a second TOGGLE would close it again.
  const client = clientWith();
  const toggle = [stateNote(STATE_VALUES.TOGGLE)];

  stubFetch(() => jsonResponse(200, { type: 0x105 }));
  await assert.rejects(() => client.transfer(DEVICE, toggle, { wait: true }), /TIMEOUT/);
  assert.equal(calls.length, 1);

  stubFetch(() => jsonResponse(200, { type: 0x102 }));
  await assert.rejects(() => client.transfer(DEVICE, toggle, { wait: true }), /SYNCHRONIZATION/);
  assert.equal(calls.length, 1);

  stubFetch(() => jsonResponse(500));
  await assert.rejects(() => client.transfer(DEVICE, toggle), /no radio confirmation/);
  assert.equal(calls.length, 1);

  stubFetch(() => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
  });
  await assert.rejects(() => client.transfer(DEVICE, toggle), /timeout/);
  assert.equal(calls.length, 1);
});

test('a TOGGLE that provably never went out is tried again', async () => {
  const client = clientWith();
  const toggle = [stateNote(STATE_VALUES.TOGGLE)];

  // BUSY: the box refused before transmitting anything.
  stubFetch(() => jsonResponse(200, { type: 0x104 }));
  await assert.rejects(() => client.transfer(DEVICE, toggle, { wait: true }), /BUSY/);
  assert.equal(calls.length, 2);

  // The service could not even be reached.
  stubFetch(() => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  });
  await assert.rejects(() => client.transfer(DEVICE, toggle), /fetch failed/);
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

test('an order repeated is one order to the box, refused only when every emission is', async () => {
  // The verdict of each emission comes back later, all under one uid: a repeat
  // the box refused must not make an order that went out a failed one.
  stubFetch(() => jsonResponse(200, { type: 0 }));
  const client = clientWith({ command_repeat: 1 });
  const uid = toThingUid('feature-1');

  await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { uid: 'feature-1' });
  await client.idle();
  const order = client.orders.match({ thingnotes: { uid } });
  assert.equal(order.emissions, 2);
  assert.equal(client.orders.settle(order, 1).failed, false);
  assert.equal(client.orders.settle(order, 0x104).failed, false);

  // The OFF given next starts over: the ON going out says nothing about it.
  await client.transfer(DEVICE, [stateNote(STATE_VALUES.OFF)], { uid: 'feature-1' });
  await client.idle();
  assert.equal(client.orders.settle(order, 0x104).failed, false);
  const { failed, uncarried, latest, since, superseded, until } = client.orders.settle(
    order,
    0x104,
  );
  assert.deepEqual(
    { failed, uncarried, latest, since, superseded, until },
    {
      failed: true,
      uncarried: true,
      latest: true,
      since: order.since,
      superseded: false,
      until: null,
    },
  );
});

test('an order the service never received is owed no verdict', async () => {
  // The bundled service restarting refuses the connection: the ON never
  // reached it. The ON given again goes out, and both its emissions are
  // refused — that order failed, it does not pay for the one before.
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ECONNREFUSED' },
  });
  let down = true;
  stubFetch(() => {
    if (down) {
      throw refused;
    }
    return jsonResponse(200, { type: 0 });
  });
  const client = clientWith({ command_repeat: 1 });
  const uid = toThingUid('feature-1');
  await captureLogs(() =>
    assert.rejects(() =>
      client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { uid: 'feature-1' }),
    ),
  ).result;
  down = false;
  const sent = await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { uid: 'feature-1' });
  await client.idle();

  const order = client.orders.match({ thingnotes: { uid } });
  assert.equal(client.orders.settle(order, 0x101).failed, false);
  const verdict = client.orders.settle(order, 0x101);
  assert.equal(verdict.failed, true);
  assert.equal(verdict.superseded, false);
  assert.equal(verdict.seq, sent.seq);
  assert.deepEqual(verdict.earlier, []);
});

test('a repeat dropped behind a newer order is owed no verdict', async () => {
  // ON then OFF clicked together over a slow link: the ON's repeat comes
  // after the OFF and is dropped. Three emissions, three verdicts.
  stubFetch(async () => {
    await new Promise(setImmediate);
    return jsonResponse(200, { type: 0 });
  });
  const client = clientWith({ command_repeat: 1 });
  const uid = toThingUid('feature-1');
  const on = client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)], { uid: 'feature-1' });
  const off = client.transfer(DEVICE, [stateNote(STATE_VALUES.OFF)], { uid: 'feature-1' });
  const [onSent, offSent] = await Promise.all([on, off]);
  await client.idle();
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.options.body).thingnotes.notes[0].value),
    [STATE_VALUES.ON, STATE_VALUES.OFF, STATE_VALUES.OFF],
  );

  const order = client.orders.match({ thingnotes: { uid } });
  const first = client.orders.settle(order, 0x101);
  assert.equal(first.failed, true);
  assert.equal(first.seq, onSent.seq);
  assert.equal(first.superseded, true);
  assert.equal(client.orders.settle(order, 0x101).failed, false);
  const last = client.orders.settle(order, 0x101);
  assert.equal(last.failed, true);
  assert.equal(last.seq, offSent.seq);
  assert.equal(last.superseded, false);
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

test('a box that goes cold quickly is touched more often, down to a floor', async () => {
  // Nothing documents how long an AirSend box tolerates being left alone, and
  // it is not the same over Wi-Fi as through the cloud gateway. So the box
  // says: a wake that took seconds is a link that had already gone cold.
  const tick = { at: 0 };
  const client = clientOnClock(tick);
  const wake = (ms) => {
    stubFetch(() => {
      tick.at += ms;
      return jsonResponse(200, { type: 3, thingnotes: { notes: [] } });
    });
    tick.at += client.warmAfter;
    return client.keepWarm(BOX);
  };

  // The first contact builds the session: slow whatever the interval, it
  // teaches nothing (see the test below).
  await wake(50);
  assert.equal(client.warmAfter, WARM_AFTER_MS);
  await wake(3000);
  assert.equal(client.warmAfter, WARM_AFTER_MS / 2);
  await wake(3000);
  assert.equal(client.warmAfter, WARM_AFTER_MS / 4);
  // A minute is as often as it ever goes: past that the cure costs more than
  // the delay it saves.
  await wake(3000);
  await wake(3000);
  assert.equal(client.warmAfter, 60 * 1000);

  // And a fast wake proves the interval it was made at works, never that a
  // longer one would: it is never lengthened back.
  await wake(50);
  assert.equal(client.warmAfter, 60 * 1000);
});

test('a fresh configuration forgets what the old box taught us', async () => {
  const tick = { at: 0 };
  const client = clientOnClock(tick);
  stubFetch(() => jsonResponse(200, { type: 3, thingnotes: { notes: [] } }));
  tick.at += WARM_AFTER_MS;
  await client.keepWarm(BOX);
  stubFetch(() => {
    tick.at += 3000;
    return jsonResponse(200, { type: 3, thingnotes: { notes: [] } });
  });

  tick.at += WARM_AFTER_MS;
  await client.keepWarm(BOX);
  assert.equal(client.warmAfter, WARM_AFTER_MS / 2);

  client.configure(normalizeConfig({ spurl: 'sp://pass@[fe80::2]?rhost=192.168.1.51' }));
  assert.equal(client.warmAfter, WARM_AFTER_MS);
});

test('the first contact with a box, slow by nature, does not shorten the interval', async () => {
  // Nothing had reached the box since start-up: that wake builds the session,
  // and its slowness says nothing about how fast the link goes cold.
  const tick = { at: Date.parse('2026-10-11T08:00:00Z') };
  const client = clientOnClock(tick);
  stubFetch(() => {
    tick.at += 1200;
    return jsonResponse(200, { type: 3, thingnotes: { notes: [] } });
  });

  const lines = captureLogs(() => client.keepWarm(BOX));

  assert.equal(await lines.result, true);
  assert.equal(client.warmAfter, WARM_AFTER_MS);
  assert.equal(lines.of('INFO').length, 0);
});

test('a box that is off does not bring the interval down, nor fill the log', async () => {
  // Every wake of a box that is unplugged lasts the whole timeout: that is the
  // box missing, not a link going cold.
  const tick = { at: 0 };
  const client = clientOnClock(tick);
  stubFetch(() => jsonResponse(200, { type: 3, thingnotes: { notes: [] } }));
  tick.at += WARM_AFTER_MS;
  await client.keepWarm(BOX);

  const lines = captureLogs(async () => {
    for (const failure of [
      () => {
        tick.at += 8000;
        throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
      },
      // The service is there, the box is not.
      () => {
        tick.at += 3000;
        return jsonResponse(200, { type: 0x101 });
      },
      () => {
        tick.at += 3000;
        return jsonResponse(200, { type: 0x105 });
      },
    ]) {
      stubFetch(failure);
      tick.at += client.warmAfter;
      assert.equal(await client.keepWarm(BOX), true);
    }
  });
  await lines.result;

  assert.equal(client.warmAfter, WARM_AFTER_MS);
  assert.equal(lines.of('INFO').length, 0);
});

test('every box is kept warm, each after its own silence', async () => {
  // Two boxes are two radios: the first one woken used to make the second
  // look busy, and its traffic made the second look recently used.
  const tick = { at: 0 };
  const client = clientOnClock(tick);
  const second = {
    ...BOX,
    name: 'Garage box',
    platformId: '1-garage',
    spurl: 'sp://pass@[fe80::2]?rhost=192.168.1.51',
  };
  stubFetch(() => jsonResponse(200, { type: 3, thingnotes: { notes: [] } }));

  tick.at += WARM_AFTER_MS;
  // Called the way index.js does: same tick, not awaited one after the other.
  assert.deepEqual(await Promise.all([client.keepWarm(BOX), client.keepWarm(second)]), [
    true,
    true,
  ]);
  const reached = calls.map((call) => call.options.headers.Authorization);
  assert.equal(new Set(reached).size, 2);

  // Orders through the first box are no news for the second one.
  tick.at += WARM_AFTER_MS - 1000;
  await client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]);
  tick.at += 1000;
  assert.deepEqual(await Promise.all([client.keepWarm(BOX), client.keepWarm(second)]), [
    false,
    true,
  ]);
});

test('one box written two ways is one radio: one transmission at a time', async () => {
  // The device list declares the box with its parameters in another order than
  // the global string: connection.js takes it for the global box, and so must
  // the queue. Keyed on the text, the keep-warm and the listening renewal went
  // out through the box's string while the shutter order went out through the
  // global one, at the same moment, to the same radio.
  const declared = { ...BOX, spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50&gw=0' };
  let inFlight = 0;
  let most = 0;
  stubFetch(async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise(setImmediate);
    inFlight -= 1;
    return jsonResponse(200, { type: 3, thingnotes: { notes: [] } });
  });
  const client = clientWith({ spurl: 'sp://pass@[fe80::1]?gw=0&rhost=192.168.1.50' });

  await Promise.all([
    client.keepWarm(declared),
    client.transfer(DEVICE, [stateNote(STATE_VALUES.ON)]),
    client.bind(5, 'http://127.0.0.1:9999/', declared),
  ]);

  assert.equal(calls.length, 3);
  assert.equal(most, 1);
  // And the shutter orders are news for the keep-warm: a box just used is not
  // woken again.
  assert.equal(await client.keepWarm(declared), false);
  assert.equal(calls.length, 3);
});

test('a box that does not answer holds up only its own orders', async () => {
  // Two boxes, the first one unplugged: each request to it hangs until the
  // timeout. The STOP that ends a timed travel through the second box used to
  // wait behind it, and the shutter ran on.
  const garage = {
    ...DEVICE,
    name: 'Garage door',
    platformId: '300-3',
    channel: { id: 300 },
    spurl: 'sp://pass@[fe80::2]?rhost=192.168.1.51',
  };
  stubFetch((url, options) => {
    if (options.headers.Authorization.includes('fe80::1')) {
      return new Promise(() => {});
    }
    return jsonResponse(200, { type: 3 });
  });
  const client = clientWith();

  client.bind(5, 'http://127.0.0.1:9999/', BOX).catch(() => {});
  await new Promise(setImmediate);
  await client.transfer(garage, [stateNote(STATE_VALUES.STOP)]);

  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /airsend\/transfer$/);
  // And the integration knows a box is still busy: listening waits for it.
  assert.equal(client.busy, true);
});
