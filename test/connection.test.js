// -----------------------------------------------------------------------------
// What the Configuration screen says: the status published after every
// initialization, and the "Test the connection" action.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxDevices, describeConnection, testConnection } from '../src/devmel/connection.js';
import { indexChannels, planListening } from '../src/devmel/listening.js';
import { normalizeConfig } from '../src/config.js';
import { HeardChannels } from '../src/devmel/heard.js';
import { applyEvents } from '../src/devices/index.js';
import { SentOrders } from '../src/devmel/orders.js';
import { NOTE_TYPES, STATE_VALUES } from '../src/devmel/notes.js';
import { captureLogs } from './helpers/captureLogs.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const SPURL = 'sp://pass@[fe80::1]?gw=0&rhost=192.168.1.50';

// The airsend.cloud export of a single shutter, as it is pasted in.
const DEVICES =
  '{"devices":[{"name":"Baie vitree","localip":"fe80::dcf6:e5ff:fe8f:89cd",' +
  '"travel_up":30,"travel_down":26,"type":4098,"pid":25455,"addr":8295}]}';

/** A client whose local ping answers, or fails with a given message. */
function fakeClient(error = null) {
  return {
    async pingLocal() {
      if (error) {
        throw new Error(error);
      }
      return true;
    },
  };
}

/** The bundled service, in one of the states it can be in. */
function fakeService(status) {
  return { status: () => ({ url: 'http://127.0.0.1:33863', ...status }) };
}

const RUNNING = fakeService({ wanted: true, running: true, error: null });

test('an empty configuration asks for the connection string, not for a URL', async () => {
  const status = await describeConnection(fakeClient(), normalizeConfig(), RUNNING);

  assert.equal(status.connected, false);
  assert.match(status.message.en, /sp:\/\/ connection string/);
  // The URL is not something to fill in any more: the service is bundled.
  assert.doesNotMatch(status.message.en, /Web Service URL/);
});

test('with the bundled service and a connection string, the box is reachable', async () => {
  const config = normalizeConfig({ spurl: SPURL });

  assert.deepEqual(await describeConnection(fakeClient(), config, RUNNING), { connected: true });
});

test('a bundled service that would not start says so, and why', async () => {
  const service = fakeService({ wanted: true, running: false, error: 'binary missing' });
  const config = normalizeConfig({ spurl: SPURL });

  const status = await describeConnection(fakeClient(), config, service);

  assert.equal(status.connected, false);
  assert.match(status.message.en, /Built-in AirSend service unavailable: binary missing/);
});

test('a service the user runs themselves is never blamed on the bundled one', async () => {
  const service = fakeService({ wanted: false, running: false, error: null });
  const config = normalizeConfig({ service_url: 'http://192.168.1.50:33863', spurl: SPURL });

  const status = await describeConnection(fakeClient('connect ECONNREFUSED'), config, service);

  assert.equal(status.connected, false);
  assert.match(status.message.en, /AirSend Web Service unreachable/);
});

test('test_connection names the built-in service and its address', async () => {
  const config = normalizeConfig({ spurl: SPURL });

  const report = await testConnection(fakeClient(), config, RUNNING);

  assert.match(report.en, /AirSend built-in service reachable at http:\/\/127\.0\.0\.1:33863/);
});

test('test_connection reports a local channel switched off entirely', async () => {
  const config = normalizeConfig({ use_embedded_service: false });

  const report = await testConnection(fakeClient(), config, null);

  assert.match(report.en, /Local: disabled/);
});

test('test_connection says where the heard frames are pushed', async () => {
  const config = normalizeConfig({ spurl: SPURL });

  const report = await testConnection(fakeClient(), config, RUNNING, {
    url: 'http://127.0.0.1:33864/',
    error: null,
  });

  assert.match(report.en, /Listening: channel 1, frames pushed to http:\/\/127\.0\.0\.1:33864\//);
  assert.match(report.fr, /Écoute : canal 1, trames poussées vers/);
});

test('test_connection names the protocol it listens to, and the devices it covers', async () => {
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES });
  const listen = {
    url: 'http://127.0.0.1:33864/',
    error: null,
    plan: planListening(config, indexChannels([{ id: 25455, name: 'Somfy RTS' }])),
  };

  const report = await testConnection(fakeClient(), config, RUNNING, listen);

  assert.match(report.en, /channel 25455 "Somfy RTS" \(deduced from your devices\)/);
  assert.match(report.en, /Devices heard: Baie vitree\./);
  assert.match(report.fr, /Appareils entendus : Baie vitree\./);
  // "Devices heard" on a shutter-only protocol is a promise this report has to
  // qualify: a shutter is heard the way a letterbox is heard.
  assert.match(report.en, /None of them emits by itself/);
  assert.match(report.fr, /Aucun de ces appareils n'émet de lui-même/);
});

test('test_connection stops promising to hear a device that never speaks', async () => {
  // The same shutter with its wall remote attached: something on that protocol
  // does emit now, so the caveat above has no reason to be repeated.
  const config = normalizeConfig({
    spurl: SPURL,
    devices: JSON.stringify({
      devices: [{ name: 'Baie vitree', type: 4098, pid: 25455, addr: 8295, remotes: [94311] }],
    }),
  });
  const listen = { url: 'http://127.0.0.1:33864/', error: null, plan: planListening(config) };

  const report = await testConnection(fakeClient(), config, RUNNING, listen);

  assert.match(report.en, /Devices heard: Baie vitree\./);
  assert.doesNotMatch(report.en, /None of them emits by itself/);
});

test('test_connection says which devices a forced protocol leaves out', async () => {
  // Generic 433 MHz listening, while the only declared device speaks another
  // protocol: the box hears nothing, and nothing else in Gladys would say so.
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES, listen_channel: 4321 });

  const report = await testConnection(fakeClient(), config, RUNNING, {
    url: 'http://127.0.0.1:33864/',
    error: null,
  });

  assert.match(report.en, /channel 4321/);
  assert.doesNotMatch(report.en, /deduced/);
  assert.match(report.en, /No declared device speaks this protocol: Baie vitree/);
});

test('test_connection warns that generic 433 MHz listening is only a default', async () => {
  // Nothing declared: the box listens to channel 1 because there is nothing
  // better to listen to, and an 868 MHz remote is not heard on it at all.
  const config = normalizeConfig({ spurl: SPURL });

  const report = await testConnection(fakeClient(), config, RUNNING, {
    url: 'http://127.0.0.1:33864/',
    error: null,
  });

  assert.match(report.en, /No radio device declared.*deaf to 868 MHz protocols/s);
  assert.match(report.fr, /Aucun appareil radio déclaré.*sourde aux protocoles 868 MHz/s);

  // A declared device makes it a deduction again, and the warning goes away.
  const declared = await testConnection(
    fakeClient(),
    normalizeConfig({ spurl: SPURL, devices: DEVICES }),
    RUNNING,
    { url: 'http://127.0.0.1:33864/', error: null },
  );
  assert.doesNotMatch(declared.en, /No radio device declared/);
});

test('test_connection reports a subscription the box refused', async () => {
  const config = normalizeConfig({ spurl: SPURL });

  const report = await testConnection(fakeClient(), config, RUNNING, {
    url: null,
    error: 'HTTP 405',
  });

  assert.match(report.en, /Listening: channel 1: the box refused the subscription \(HTTP 405\)/);
});

test('test_connection reports listening switched off, and a listener with no route', async () => {
  const off = await testConnection(fakeClient(), normalizeConfig({ listen_channel: 0 }), RUNNING);
  assert.match(off.en, /Listening: disabled/);

  // A service the user runs elsewhere cannot reach our loopback: without the
  // Gladys Plus relay there is nowhere for the frames to go.
  const config = normalizeConfig({ spurl: SPURL, service_url: 'http://192.168.1.50:33863' });
  const orphan = await testConnection(fakeClient(), config, null, { url: null, error: null });
  assert.match(orphan.en, /no route for the frames.*Gladys Plus/s);
});

// --- What the box actually heard ---------------------------------------------
// Every line above answers "can the frames get in?". This one answers "did
// they, and did anything move?" — the question behind an attached wall remote
// that leaves the shutter where it was.

/** The wall remote of the shutter above, on its own 868 MHz protocol. */
const WALL_REMOTE = { id: 14177, source: 3359265281 };

const DEVICES_WITH_REMOTE =
  '{"devices":[{"name":"Baie vitree","travel_up":30,"travel_down":26,"type":4098,' +
  '"pid":25455,"addr":8295,"remotes":[{"pid":14177,"addr":3359265281}]}]}';

test('test_connection says nothing was heard, rather than nothing at all', async () => {
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES });

  const report = await testConnection(fakeClient(), config, RUNNING, null, new HeardChannels());

  assert.match(report.en, /Heard: no radio frame since the integration started/);
  assert.match(report.fr, /Entendu : aucune trame radio depuis le démarrage/);
});

test('test_connection names an emitter no device declares', async () => {
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES });
  const heard = new HeardChannels();
  heard.record(WALL_REMOTE, { readings: [], claimed: false });

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);

  assert.match(report.en, /1 emitter heard: pid 14177, addr 3359265281 \(1 frame, /);
  assert.match(report.en, /no decoded note.*no device declares it: "Attach a remote"/);
  assert.match(report.fr, /aucun appareil ne le déclare/);
});

test('test_connection tells an attached remote that moves nothing from one that works', async () => {
  // Both remotes are declared, both are heard, and only one of them moves the
  // shutter. Before this line the two were the same silence.
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES_WITH_REMOTE });

  const mute = new HeardChannels();
  mute.record(WALL_REMOTE, { readings: [], claimed: true });
  const muteReport = await testConnection(fakeClient(), config, RUNNING, null, mute);

  assert.match(
    muteReport.en,
    /declared on Baie vitree, but its frames carry no order to replay.*the position cannot follow/,
  );
  assert.match(muteReport.fr, /ne portent aucun ordre rejouable.*la position ne peut pas suivre/);

  const working = new HeardChannels();
  working.record(WALL_REMOTE, {
    readings: [{ kind: 'level', value: 100, command: 'up' }],
    claimed: true,
    understood: true,
  });
  const workingReport = await testConnection(fakeClient(), config, RUNNING, null, working);

  assert.match(workingReport.en, /note: level 100 \(up\).*followed by Baie vitree/);
  assert.match(workingReport.fr, /suivi par Baie vitree/);
});

test('test_connection does not blame partial decoding for an order the device ignores', async () => {
  // A TOGGLE is fully decoded: a switch that does nothing with it has the
  // wrong type or the wrong remote attached, and the protocol is not at fault.
  // Through the real routing: a shutter DOES act on a TOGGLE (it goes the
  // other way), so a hand-made "claimed, not understood" shutter tested a
  // state real traffic never produces.
  const config = normalizeConfig({
    spurl: SPURL,
    devices:
      '{"devices":[{"name":"Prise salon","type":4097,"pid":25455,"addr":8295,' +
      '"remotes":[{"pid":14177,"addr":3359265281}]}]}',
  });
  const heard = new HeardChannels();
  const toggle = {
    type: 3,
    channel: WALL_REMOTE,
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.TOGGLE }] },
  };
  const routed = captureLogs(() =>
    applyEvents(createFakeGladys(), config, [toggle], heard, new SentOrders(), null),
  );
  assert.equal(await routed.result, 0);

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);

  assert.match(report.en, /declared on Prise salon, which does nothing with the order decoded/);
  assert.match(report.en, /Button, type 4096/);
  assert.doesNotMatch(report.en, /partially decodes/);
  assert.match(report.fr, /qui ne fait rien de l'ordre décodé/);
  assert.doesNotMatch(report.fr, /partiellement décodé\)/);
});

test('test_connection names the protocol a pid stands for', async () => {
  // "pid 14177" identifies a protocol without saying which one, and the name
  // is what a user compares to the brand written on their remote — a thing no
  // datasheet answers as well as the box that decoded the frame.
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES_WITH_REMOTE });
  const heard = new HeardChannels();
  heard.record(WALL_REMOTE, { readings: [], claimed: true });
  const table = indexChannels([{ id: 14177, name: 'Profalux', getDecoder: 0 }]);

  const named = await testConnection(fakeClient(), config, RUNNING, null, heard, table);
  assert.match(named.en, /pid 14177 "Profalux", addr 3359265281/);

  // Without the table — the service never answered — the pid stands alone
  // rather than being invented.
  const bare = await testConnection(fakeClient(), config, RUNNING, null, heard);
  assert.match(bare.en, /pid 14177, addr 3359265281/);
});

test('test_connection lists every button a remote has been heard pressing', async () => {
  // Three presses, three notes — or the same note three times, which is what a
  // remote the service decodes only halfway looks like. The last frame alone
  // cannot tell those apart, and that is the whole question being asked here.
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES_WITH_REMOTE });
  const heard = new HeardChannels();
  heard.record(WALL_REMOTE, {
    readings: [{ kind: 'level', value: 100, command: 'up' }],
    claimed: true,
    understood: true,
  });
  heard.record(WALL_REMOTE, {
    readings: [{ kind: 'state', value: 'stop', command: 'stop' }],
    claimed: true,
    understood: true,
  });

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);

  assert.match(report.en, /notes: level 100 \(up\); state stop \(stop\)/);
  assert.match(report.fr, /notes : level 100 \(up\) ; state stop \(stop\)/);
});

test('test_connection tells a remote whose every press says the same thing', async () => {
  // Followed, understood, and nothing moves: a STOP replayed on a shutter that
  // is not moving changes a state and not one percent of position.
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES_WITH_REMOTE });
  const heard = new HeardChannels();
  for (let press = 0; press < 3; press += 1) {
    heard.record(WALL_REMOTE, {
      readings: [{ kind: 'state', value: 'stop', command: 'stop' }],
      claimed: true,
      understood: true,
    });
  }

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);

  assert.match(report.en, /every one of its frames carries the same order \(state stop \(stop\)\)/);
  assert.match(report.fr, /toutes ses trames portent le même ordre/);
  // One press proves nothing: no verdict until there is something to compare.
  const once = new HeardChannels();
  once.record(WALL_REMOTE, {
    readings: [{ kind: 'state', value: 'stop', command: 'stop' }],
    claimed: true,
    understood: true,
  });
  const early = await testConnection(fakeClient(), config, RUNNING, null, once);
  assert.doesNotMatch(early.en, /the same order/);
});

test('test_connection keeps the proof that our own orders come back', async () => {
  // The echoes are not emitters, so they are nowhere in the list above — and
  // they are the difference between "my remote is unheard" and "nothing gets
  // in at all", which is worth a few words even when something WAS heard.
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES_WITH_REMOTE });
  const heard = new HeardChannels();
  heard.record(WALL_REMOTE, { readings: [], claimed: true });
  heard.received({ own: true });
  heard.received({ own: true });

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);

  assert.match(report.en, /Plus 2 echoes of your own orders: the route the frames take works\./);
  assert.match(report.fr, /Plus 2 échos de vos propres ordres : la route des trames fonctionne\./);
});

test('test_connection counts the emitters it does not spell out', async () => {
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES });
  const heard = new HeardChannels();
  for (let index = 0; index < 7; index += 1) {
    heard.record({ id: 1, source: index });
  }

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);

  assert.match(report.en, /7 emitters heard: /);
  assert.match(report.en, /\(\+2\)\./);
  // Most recent first: the emitter just pressed is the one being looked for.
  assert.match(report.en, /Heard: 7 emitters heard: pid 1, addr 6/);
});

test('the implicit box follows the service that actually serves the local channel', () => {
  // No box in the device list: one is rebuilt from the global credentials, and
  // the bundled service is enough for it to exist.
  assert.equal(boxDevices(normalizeConfig({ spurl: SPURL })).length, 1);
  assert.equal(
    boxDevices(normalizeConfig({ spurl: SPURL, use_embedded_service: false })).length,
    0,
  );
});

test('a second box declared with its own string does not hide the box behind the global one', () => {
  const config = normalizeConfig({
    spurl: SPURL,
    devices: JSON.stringify({
      devices: [
        {
          name: 'Box garage',
          type: 0,
          spurl: 'sp://other@[fe80::2]?gw=0&rhost=192.168.1.60',
          sensors: true,
        },
        { name: 'Volet salon', type: 4098, pid: 25455, addr: 8295 },
      ],
    }),
  });

  // The shutter's orders go through the global string: that box must be
  // listened through and kept warm too.
  assert.deepEqual(
    boxDevices(config).map((box) => box.spurl),
    ['sp://other@[fe80::2]?gw=0&rhost=192.168.1.60', SPURL],
  );
  // The global box declared in the list, with or without its string: once.
  for (const box of [
    { name: 'Box salon', type: 0 },
    { name: 'Box salon', type: 0, spurl: SPURL },
    { name: 'Box salon', type: 0, spurl: 'sp://pass@[fe80::9]?gw=0&rhost=192.168.1.50' },
  ]) {
    const declared = normalizeConfig({
      spurl: SPURL,
      devices: JSON.stringify({ devices: [box] }),
    });
    assert.deepEqual(
      boxDevices(declared).map((found) => found.name),
      ['Box salon'],
    );
  }
});

test('silence is told apart from a route that carries nothing back', async () => {
  // "Nothing heard" is three problems wearing the same face. The counters of
  // the registry are what separates them, and the answer differs every time.
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES });

  // Nothing at all: the user is sent to check the route, echo in hand.
  const silent = new HeardChannels();
  const nothing = await testConnection(fakeClient(), config, RUNNING, null, silent);
  assert.match(nothing.en, /no radio frame since the integration started/);
  assert.match(nothing.en, /drive a device from Gladys: the echo of that order should come back/);

  // Our own orders come back, nobody else's: the route works, the box is
  // listening to a protocol nothing else speaks.
  const ownOnly = new HeardChannels();
  ownOnly.received({ own: true });
  ownOnly.received({ own: true });
  const own = await testConnection(fakeClient(), config, RUNNING, null, ownOnly);
  assert.match(own.en, /no frame from any other emitter, but 2 echoes of our own orders/);
  assert.match(own.en, /Check the Listening line above/);
  assert.match(own.fr, /2 échos de vos propres ordres/);

  // Frames arrive and are thrown away: a radio problem, not a configuration one.
  const noisy = new HeardChannels();
  noisy.received({ dropped: 'unreliable, graded 2' });
  const dropped = await testConnection(fakeClient(), config, RUNNING, null, noisy);
  assert.match(dropped.en, /1 frame arrived and was dropped before any device/);
  assert.match(dropped.en, /last reason: unreliable, graded 2/);
  assert.match(dropped.fr, /1 trame reçue et écartée/);
});

test('an emitter heard and graded too low is listed, with what happened to it', async () => {
  // It used to be invisible: recorded nowhere, so a box drowning in frames it
  // grades badly reported exactly the same silence as a box hearing nothing.
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES });
  const heard = new HeardChannels();
  heard.received({ dropped: 'unreliable, graded 2' });
  heard.record(WALL_REMOTE, { dropped: 'unreliable, graded 2' });

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);

  assert.match(report.en, /1 emitter heard: pid 14177, addr 3359265281/);
  assert.match(report.en, /its last frame was dropped before any device \(unreliable, graded 2\)/);
  assert.match(report.fr, /sa dernière trame a été écartée avant tout appareil/);
});

test('a mistyped connection string is named before the box is asked about it', async () => {
  const config = normalizeConfig({ spurl: 'sp://pass@fe80:dcf6:e5ff:fe8f:89cd?gw=1' });
  const status = await describeConnection(fakeClient(), config, RUNNING);

  // The probe would have passed — it does not use the connection string — and
  // the screen would have said "connected" while every order answered 401.
  assert.equal(status.connected, false);
  assert.match(status.message.fr, /n’est pas une adresse IPv6 valide/);

  const report = await testConnection(fakeClient(), config, RUNNING);
  assert.match(report.en, /Connection string: "fe80:dcf6:e5ff:fe8f:89cd" is not a valid IPv6/);
});

test('test_connection shows the connection string, without the password in it', async () => {
  const config = normalizeConfig({
    spurl: 'sp://0123456789abcdef@fe80::1?gw=1&rhost=192.168.1.50',
  });
  const report = await testConnection(fakeClient(), config, RUNNING);

  // Nothing is wrong with this one: it is printed anyway, because half of what
  // it catches is what no check can name — the address of the other box, a
  // gw=1 nobody asked for.
  assert.deepEqual(config.spurlProblems, []);
  assert.match(
    report.fr,
    /Chaîne de connexion : sp:\/\/<16 characters>@fe80::1\?gw=1&rhost=192\.168\.1\.50/,
  );
  assert.doesNotMatch(report.en, /0123456789abcdef/);
});

test('a mistyped string on a second box is named too, with the box it is on', async () => {
  const config = normalizeConfig({
    spurl: SPURL,
    devices: JSON.stringify({
      devices: [
        { name: 'Box salon', type: 0, spurl: SPURL },
        { name: 'Box garage', type: 0, spurl: 'sp://pass2@fe80:2:3?gw=0&rhost=192.168.1.60' },
      ],
    }),
  });

  // Every order and every bind through the garage box answers 401: the
  // status cannot say "connected".
  const status = await describeConnection(fakeClient(), config, RUNNING);
  assert.equal(status.connected, false);
  assert.match(status.message.en, /^Connection string: on "Box garage", "fe80:2:3" is not a valid/);
  assert.match(status.message.fr, /^Chaîne de connexion : sur « Box garage », « fe80:2:3 »/);

  // And the report shows both strings, passwords out.
  const report = await testConnection(fakeClient(), config, RUNNING);
  assert.match(report.en, /Connection string: sp:\/\/<4 characters>@\[fe80::1\]/);
  assert.match(
    report.en,
    /Connection string of "Box garage": sp:\/\/<5 characters>@fe80:2:3\?gw=0&rhost=192\.168\.1\.60/,
  );
  assert.match(report.fr, /Chaîne de connexion de « Box garage » : sp:\/\/<5 characters>@/);
  assert.doesNotMatch(report.en, /pass2/);
});

test('a connection string pasted on the box alone is a configured connection', async () => {
  const devices = JSON.stringify({
    devices: { Box: { type: 0, spurl: SPURL }, ...JSON.parse(DEVICES) },
  });
  const status = await describeConnection(fakeClient(), normalizeConfig({ devices }), RUNNING);
  assert.equal(status.connected, true);
});

test('with no box to listen through, test_connection asks for the connection string', async () => {
  const report = await testConnection(
    fakeClient(),
    normalizeConfig({ devices: DEVICES }),
    RUNNING,
    {
      url: null,
      error: null,
    },
  );
  assert.match(report.en, /no AirSend box to listen through/);
  assert.doesNotMatch(report.en, /Gladys Plus/);
  assert.match(report.fr, /aucun boîtier/);
});

test('a box declared before the connection string still asks for the string', async () => {
  // The docs' own example declares the box with no string of its own: it is
  // not a box anything can listen through until the sp:// field is filled in.
  const config = normalizeConfig({
    devices: JSON.stringify({
      devices: { 'AirSend box': { type: 0, sensors: true, refresh: 300 }, ...JSON.parse(DEVICES) },
    }),
  });
  assert.deepEqual(boxDevices(config), []);

  const report = await testConnection(fakeClient(), config, RUNNING, { url: null, error: null });
  assert.match(report.en, /no AirSend box to listen through — paste the sp:\/\/ connection/);
  assert.doesNotMatch(report.en, /Gladys Plus/);
});

test('test_connection names a remote declared by its protocol alone without an address', async () => {
  const config = normalizeConfig({
    spurl: SPURL,
    devices: JSON.stringify({
      devices: {
        'Patio door': { type: 4098, pid: 25455, addr: 8295, remotes: [{ pid: 14177 }] },
        S1: { type: 1, pid: 25455, addr: 1 },
        S2: { type: 1, pid: 25455, addr: 2 },
      },
    }),
  });
  const plan = planListening(config);
  const report = await testConnection(fakeClient(), config, RUNNING, {
    url: 'http://127.0.0.1:33864/',
    plan,
  });

  assert.match(report.en, /so never heard: Patio door \(pid 14177\)\./);
  assert.doesNotMatch(report.en, /undefined/);
  assert.doesNotMatch(report.fr, /undefined/);
});

test('test_connection follows a remote declared by its protocol alone', async () => {
  // The documented last resort, already in place: advising the listening
  // channel the user has set is the wrong answer to frames being followed.
  const config = normalizeConfig({
    spurl: SPURL,
    listen_channel: 14177,
    devices: JSON.stringify({
      devices: { 'Patio door': { type: 4098, pid: 25455, addr: 8295, remotes: [{ pid: 14177 }] } },
    }),
  });
  const heard = new HeardChannels();
  heard.record(
    { id: 14177 },
    { readings: [{ kind: 'level', value: 100, command: 'up' }], claimed: true, understood: true },
  );

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);
  assert.match(report.en, /address not decoded.*followed by Patio door/);
  assert.doesNotMatch(report.en, /did not decode this protocol/);
  assert.match(report.fr, /suivi par Patio door/);

  // Nobody declaring it: the advice is still the one that works.
  const alone = normalizeConfig({ spurl: SPURL, devices: DEVICES });
  const unclaimed = await testConnection(fakeClient(), alone, RUNNING, null, heard);
  assert.match(unclaimed.en, /did not decode this protocol \(no address\)/);
});

test('test_connection does not judge a remote just attached on frames heard before', async () => {
  // Heard while nobody declared it, then attached and saved: what its frames
  // did then says nothing about the device now declaring it.
  const heard = new HeardChannels();
  heard.record(WALL_REMOTE, {
    readings: [{ kind: 'level', value: 100, command: 'up' }],
    claimed: false,
  });
  heard.forgetVerdicts();
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES_WITH_REMOTE });

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);
  assert.match(report.en, /declared on Baie vitree, not heard since the configuration changed/);
  assert.doesNotMatch(report.en, /no order to replay|does nothing with the order/);
  assert.match(report.fr, /pas entendu depuis le changement de configuration/);
});

test('test_connection asks for "generic", never 1, to hear the generic 433 MHz decoder', async () => {
  // The Listening channel field reads 1 as "deduce": a remote declared on pid
  // 1, or an emitter heard on it without an address, was answered "fill in 1",
  // which left the box on the protocol it was already listening to.
  const table = indexChannels([
    { id: 1, name: 'Generic 433MHz', getDecoder: 1 },
    { id: 25455, name: 'Somfy RTS', getDecoder: 25455 },
  ]);
  const config = normalizeConfig({
    spurl: SPURL,
    devices: JSON.stringify({
      devices: [
        { name: 'V1', type: 4098, pid: 25455, addr: 1, remotes: [{ pid: 25455, addr: 11 }] },
        { name: 'V2', type: 4098, pid: 25455, addr: 2, remotes: [{ pid: 25455, addr: 12 }] },
        { name: 'Lampe', type: 4097, pid: 25455, addr: 5, remotes: [{ pid: 1, addr: 4242 }] },
      ],
    }),
  });
  const plan = planListening(config, table);
  assert.equal(plan.channel, 25455);
  const heard = new HeardChannels();
  heard.record({ id: 1 }, { readings: [], claimed: false });

  const report = await testConnection(
    fakeClient(),
    config,
    RUNNING,
    { plan, url: 'http://127.0.0.1:33864/', error: null },
    heard,
    table,
  );

  assert.match(report.en, /never heard: Lampe \(pid 1, addr 4242\)\. Fill in "generic" as the/);
  assert.match(report.fr, /Renseignez « générique » dans le canal d'écoute/);
  assert.match(report.en, /set the listening channel to "generic" so it listens/);
  assert.match(report.fr, /renseignez « générique » comme canal d'écoute/);
  assert.doesNotMatch(report.en, /Fill in their pid|listening channel to 1 /);
});

test('a box with its string but no AirSend service: the Listening line names the service', async () => {
  // Built-in service off, no URL typed: the string is there, the service is
  // not, and "paste the sp:// connection string" sent the user after a field
  // they had already filled in.
  const config = normalizeConfig({
    use_embedded_service: false,
    service_url: '',
    devices: JSON.stringify({
      devices: { 'AirSend box': { type: 0, spurl: SPURL }, ...JSON.parse(DEVICES) },
    }),
  });
  assert.deepEqual(boxDevices(config), []);

  const report = await testConnection(fakeClient(), config, RUNNING, { url: null, error: null });
  assert.match(report.en, /no AirSend box to listen through — no AirSend Web Service to reach it/);
  assert.match(report.fr, /aucun boîtier à qui demander l'écoute — aucun service AirSend/);
  assert.doesNotMatch(report.en, /paste the sp:\/\/ connection string first/);
});

test('a remote dropped for its grade, then attached by its address, is not told to accept unreliable frames', async () => {
  // "Attach a remote" says a remote attached by its address is no longer
  // dropped for its grade: until its next frame, the report must not advise
  // the very switch that answer called unnecessary.
  const heard = new HeardChannels();
  heard.record(WALL_REMOTE, { dropped: 'unreliable, graded 71' });
  heard.forgetVerdicts();
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES_WITH_REMOTE });

  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);
  assert.match(report.en, /declared on Baie vitree, not heard since the configuration changed/);
  assert.doesNotMatch(report.en, /Accept unreliable/);

  // A frame dropped under the new configuration is a current verdict again.
  heard.record(WALL_REMOTE, { dropped: 'unreliable, graded 71' });
  const again = await testConnection(fakeClient(), config, RUNNING, null, heard);
  assert.match(again.en, /dropped before any device \(unreliable, graded 71\)/);
});

test('a reconnection to Gladys keeps the verdicts: only a configuration change forgets them', async () => {
  // Every reconnection re-runs the initialization with the same configuration,
  // and the once-only log lines are said again (reannounce) — but a remote
  // being followed did not become "not heard since the configuration changed".
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES_WITH_REMOTE });
  const heard = new HeardChannels();
  heard.record(WALL_REMOTE, {
    readings: [{ kind: 'level', value: 100, command: 'up' }],
    claimed: true,
    understood: true,
  });

  heard.reannounce();
  const report = await testConnection(fakeClient(), config, RUNNING, null, heard);
  assert.match(report.en, /followed by Baie vitree/);
  assert.doesNotMatch(report.en, /not heard since the configuration changed/);
});

test('test_connection answers in German and Spanish too, line for line', async () => {
  const config = normalizeConfig({ spurl: SPURL, devices: DEVICES });
  const listen = {
    url: 'http://127.0.0.1:33864/',
    error: null,
    plan: planListening(config, indexChannels([{ id: 25455, name: 'Somfy RTS' }])),
  };
  const heard = new HeardChannels();

  const report = await testConnection(fakeClient(), config, RUNNING, listen, heard);

  assert.deepEqual(Object.keys(report), ['en', 'fr', 'de', 'es']);
  const lines = report.en.split('\n').length;
  for (const language of ['fr', 'de', 'es']) {
    assert.equal(report[language].split('\n').length, lines, language);
  }
  assert.match(report.de, /^Verbindungszeichenfolge: sp:\/\//m);
  assert.match(report.de, /Empfang: Kanal 25455 "Somfy RTS" \(aus Ihren Geräten abgeleitet\)/);
  assert.match(report.de, /Gehört: kein Funktelegramm seit dem Start der Integration/);
  assert.match(report.de, /Geräte: 1 gelesen: Baie vitree\./);
  assert.match(report.es, /Escucha: canal 25455 "Somfy RTS" \(deducido de sus dispositivos\)/);
  assert.match(report.es, /Oído: ninguna trama de radio desde que se inició la integración/);
  assert.match(report.es, /Dispositivos: 1 leído\(s\): Baie vitree\./);
});

test('the connection status carries every language, a connection string problem included', async () => {
  const config = normalizeConfig({ spurl: 'sp://pass@fe80:2:3?gw=0&rhost=192.168.1.50' });

  const status = await describeConnection(fakeClient(), config, RUNNING);

  assert.equal(status.connected, false);
  assert.deepEqual(Object.keys(status.message), ['en', 'fr', 'de', 'es']);
  assert.match(status.message.de, /^Verbindungszeichenfolge: „fe80:2:3“ ist keine gültige IPv6/);
  assert.match(status.message.es, /^Cadena de conexión: «fe80:2:3» no es una dirección IPv6/);
});
