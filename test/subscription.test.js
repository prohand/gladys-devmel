// -----------------------------------------------------------------------------
// Arming, renewing and re-arming the listening subscription: what each attempt
// binds, and what it says it did.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { indexChannels } from '../src/devmel/listening.js';
import { createListenLoop } from '../src/devmel/listenLoop.js';
import {
  armListening,
  bindBoxes,
  rearmedChannel,
  renewListening,
} from '../src/devmel/subscription.js';
import { captureLogs } from './helpers/captureLogs.js';

const SPURL = 'sp://pass@[fe80::1]?gw=0&rhost=192.168.1.50';
const CALLBACK = 'http://127.0.0.1:33864/';

const TABLE = indexChannels([
  { id: 1, name: 'Generic 433MHz' },
  { id: 25455, name: 'Somfy RTS', getDecoder: 25455 },
  { id: 1368, name: 'Nexus', getDecoder: 1 },
  { id: 1370, name: 'Oregon', getDecoder: 1 },
]);

function configWith(devices, overrides = {}) {
  return normalizeConfig({ spurl: SPURL, devices: JSON.stringify({ devices }), ...overrides });
}

/** A box that takes the subscription, or refuses it while `refuse` is set. */
function fakeBinder() {
  const binder = {
    refuse: null,
    binds: [],
    async bind(channel, url, box) {
      binder.binds.push({ channel, url, box: box.name });
      if (binder.refuse) {
        throw new Error(binder.refuse);
      }
    },
  };
  return binder;
}

/** Run quietly, keeping the log lines for the assertions. */
async function quietly(run) {
  const logs = captureLogs(run);
  return { result: await logs.result, of: logs.of };
}

const SHUTTER = { name: 'Volet salon', type: 4098, pid: 25455, addr: 8295 };

test('a renewal the box refuses is reported, even after a bind that worked', async () => {
  const config = configWith([SHUTTER]);
  const client = fakeBinder();
  const { result: armed } = await quietly(() =>
    armListening({ config, table: TABLE, callbackUrl: CALLBACK, client }),
  );
  assert.equal(armed.url, CALLBACK);
  assert.equal(armed.error, null);

  // The box is unplugged: every renewal fails from now on.
  client.refuse = 'connect EHOSTUNREACH 192.168.1.50:33863';
  const { result: renewed } = await quietly(() =>
    renewListening({ config, table: TABLE, plan: armed.plan, callbackUrl: CALLBACK, client }),
  );

  // What "Test the connection" and the widget read: not "frames pushed to".
  assert.equal(renewed.url, null);
  assert.equal(renewed.error, 'connect EHOSTUNREACH 192.168.1.50:33863');

  // And the next renewal that works says so again.
  client.refuse = null;
  const { result: back } = await quietly(() =>
    renewListening({ config, table: TABLE, plan: renewed.plan, callbackUrl: CALLBACK, client }),
  );
  assert.equal(back.url, CALLBACK);
  assert.equal(back.error, null);
});

test('one box listening is listening, whatever another one answers', async () => {
  const client = {
    async bind(channel, url, box) {
      if (box.name === 'Box garage') {
        throw new Error('HTTP 401');
      }
    },
  };
  const boxes = [{ name: 'Box garage' }, { name: 'AirSend box' }];
  const { result: one } = await quietly(() =>
    bindBoxes({ client, boxes, channel: 25455, callbackUrl: CALLBACK }),
  );
  assert.deepEqual(one, { url: CALLBACK, error: null });

  const { result: none } = await quietly(() =>
    bindBoxes({ client, boxes: [boxes[0]], channel: 25455, callbackUrl: CALLBACK }),
  );
  assert.deepEqual(none, { url: null, error: 'HTTP 401' });
});

test('a renewal binds the protocol the channel table names once it can be read', async () => {
  // Two sensors the generic decoder covers, and a shutter with its remote: the
  // service was still booting when listening was armed.
  const config = configWith([
    { name: 'Temp jardin', type: 1, pid: 1368, addr: 11 },
    { name: 'Temp serre', type: 1, pid: 1370, addr: 12 },
    { ...SHUTTER, remotes: [{ pid: 25455, addr: 777 }] },
  ]);
  const client = fakeBinder();
  const { result: armed } = await quietly(() =>
    armListening({ config, table: new Map(), callbackUrl: CALLBACK, client }),
  );
  assert.equal(armed.plan.channel, 1368);

  // The service is back: the next renewal reads the table and binds channel 1,
  // which hears both sensors.
  const { result: renewed, of } = await quietly(() =>
    renewListening({ config, table: TABLE, plan: armed.plan, callbackUrl: CALLBACK, client }),
  );
  assert.equal(renewed.plan.channel, 1);
  assert.equal(client.binds.at(-1).channel, 1);
  assert.deepEqual(
    renewed.plan.covered.map((device) => device.name),
    ['Temp jardin', 'Temp serre'],
  );
  // A new channel is said like an arm, not buried in the debug renewals.
  assert.equal(
    of('INFO').some((line) => line.includes('Listening on channel 1 through')),
    true,
  );
});

test('each re-arm answers from its own attempt, not from the one queued behind it', async () => {
  // A double click on the widget button: the second request is queued while
  // the first one binds. The first must not read the blank state of the
  // second and answer "no route" for a bind that worked.
  const config = configWith([SHUTTER]);
  const client = fakeBinder();
  const loop = createListenLoop({
    renew: () => {},
    intervalMs: 600000,
    timers: { set: () => 1, clear: () => {} },
  });
  const shared = { url: null, error: null, plan: null };

  // What index.js does for every request.
  async function start() {
    let outcome = null;
    await loop.start(async () => {
      outcome = await armListening({ config, table: TABLE, callbackUrl: CALLBACK, client });
      Object.assign(shared, { plan: outcome.plan, url: outcome.url, error: outcome.error });
      return outcome.renewable;
    });
    return outcome;
  }

  const { result } = await quietly(() =>
    Promise.all([start(), start()]).then((outcomes) =>
      outcomes.map((outcome) => rearmedChannel(outcome, config)),
    ),
  );
  assert.deepEqual(result, [25455, 25455]);
  // And the shared state was never left half-way for the reports.
  assert.equal(shared.url, CALLBACK);
  loop.stop();
});

test('a re-arm says why it did not take', async () => {
  const config = configWith([SHUTTER]);
  const client = fakeBinder();
  client.refuse = 'HTTP 401';
  const { result: refused } = await quietly(() =>
    armListening({ config, table: TABLE, callbackUrl: CALLBACK, client }),
  );
  assert.throws(() => rearmedChannel(refused, config), /refused the subscription: HTTP 401/);

  const off = configWith([SHUTTER], { listen_channel: '0' });
  const { result: disabled } = await quietly(() =>
    armListening({ config: off, table: TABLE, callbackUrl: CALLBACK, client }),
  );
  assert.equal(disabled.renewable, false);
  assert.throws(() => rearmedChannel(disabled, off), /turned off/);

  const { result: noRoute } = await quietly(() =>
    armListening({ config, table: TABLE, callbackUrl: null, client }),
  );
  assert.throws(() => rearmedChannel(noRoute, config), /No route/);

  // Cancelled by a disconnection before it ran.
  assert.throws(() => rearmedChannel(null, config), /stopped/);
});

test('a box declared before the connection string is pasted is not listened through', async () => {
  // The docs' own example declares the box with no string of its own: until
  // the sp:// field is filled in, there is nothing to bind with, and the user
  // must be asked for the string, not told every ten minutes that the box
  // refused a subscription it was never asked for.
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: { 'AirSend box': { type: 0, sensors: true, refresh: 300 }, Volet: SHUTTER },
    }),
  });
  const client = fakeBinder();
  const { result: outcome, of } = await quietly(() =>
    armListening({ config, table: TABLE, callbackUrl: CALLBACK, client }),
  );

  assert.deepEqual(client.binds, []);
  assert.equal(outcome.error, null);
  // No renewal timer binding nothing.
  assert.equal(outcome.renewable, false);
  assert.ok(of('INFO').some((line) => /paste the sp:\/\/ connection string/.test(line)));
  assert.equal(of('WARN').length, 0);
  assert.throws(() => rearmedChannel(outcome, config), /paste the sp:\/\/ connection string/);
});
