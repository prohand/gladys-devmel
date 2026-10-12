import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { HeardChannels } from '../src/devmel/heard.js';
import { attachHeardRemote, attachRemote, unclaimedEmitters } from '../src/devmel/remotes.js';
import { NOTE_TYPES, READINGS, STATE_VALUES } from '../src/devmel/notes.js';
import { indexChannels, planListening } from '../src/devmel/listening.js';
import { applyEvents } from '../src/devices/index.js';
import { SentOrders } from '../src/devmel/orders.js';
import { captureLogs } from './helpers/captureLogs.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

// The line a user actually pastes: the airsend.cloud export, one shutter, one
// line. Every test below starts from it, because that is what the action has
// to give back — same shape, same fields, plus the remote.
const EXPORT = JSON.stringify({
  devices: [
    {
      name: 'Baie vitree',
      localip: 'fe80::dcf6:e5ff:fe8f:89cd',
      travel_up: 30,
      travel_down: 26,
      type: 4098,
      pid: 25455,
      addr: 8295,
    },
  ],
});

/** A remote heard `frames` times, on a registry with a fixed clock. */
function heardRemote({ id, source, readings = [], frames = 1, claimed = false } = {}) {
  const heard = new HeardChannels({ now: () => 1_000_000 });
  for (let i = 0; i < frames; i += 1) {
    heard.record({ id, source }, { readings, claimed, timestamp: 1_000_000 });
  }
  return heard;
}

function configOf(devices) {
  return normalizeConfig({ devices });
}

test('an emitter heard is remembered once, with its last frame', () => {
  const heard = new HeardChannels({ now: () => 5000 });
  heard.record({ id: 14177, source: 3359265281 }, { readings: [] });
  heard.record(
    { id: 14177, source: 3359265281, counter: 7 },
    { readings: [{ kind: READINGS.DATA, value: 'a1b2' }] },
  );
  heard.record({ id: 300, source: 42 }, { claimed: true });

  const [last, first] = heard.list();
  // Most recent first: the emitter just pressed is the one to attach.
  assert.equal(last.id, 300);
  assert.equal(first.frames, 2);
  assert.deepEqual(first.readings, [{ kind: READINGS.DATA, value: 'a1b2' }]);
  assert.equal(first.lastSeen, 5000);
});

test('the registry stays bounded, dropping the emitters heard longest ago', () => {
  const heard = new HeardChannels({ limit: 2 });
  heard.record({ id: 1, source: 1 });
  heard.record({ id: 1, source: 2 });
  heard.record({ id: 1, source: 3 });

  assert.deepEqual(
    heard.list().map((entry) => entry.source),
    [3, 2],
  );
});

test('a frame without a protocol is not remembered; one without an address is', () => {
  const heard = new HeardChannels();
  assert.equal(heard.record(null), null);
  assert.equal(heard.list().length, 0);

  // The box picked a protocol up without decoding who emitted on it. There is
  // no address to attach, and that IS the thing to tell the user.
  const partial = heard.record({ id: 300 });
  assert.equal(partial.id, 300);
  assert.equal(partial.source, null);
  assert.equal(heard.list().length, 1);
});

test('the remote is added to the pasted list, which is otherwise left alone', () => {
  const config = configOf(EXPORT);
  const [shutter] = config.devmelDevices;

  const line = attachRemote(EXPORT, shutter, { id: 14177, source: 3359265281 });

  assert.deepEqual(JSON.parse(line), {
    devices: [
      {
        name: 'Baie vitree',
        localip: 'fe80::dcf6:e5ff:fe8f:89cd',
        travel_up: 30,
        travel_down: 26,
        type: 4098,
        pid: 25455,
        addr: 8295,
        remotes: [{ pid: 14177, addr: 3359265281 }],
      },
    ],
  });
  // And it is read back as the remote of that very device.
  const reread = configOf(line).devmelDevices[0];
  assert.deepEqual(reread.remotes, [{ id: 14177, source: 3359265281 }]);
  assert.equal(reread.platformId, shutter.platformId);
});

test('a remote already declared is not added twice, whichever way it was written', () => {
  const source = JSON.stringify({
    devices: {
      'Baie vitree': { type: 4098, channel: { id: 25455, source: 8295 }, remotes: [94311] },
    },
  });
  const config = configOf(source);
  const [shutter] = config.devmelDevices;

  // The short form is read on the protocol of the device itself: same emitter.
  const same = attachRemote(source, shutter, { id: 25455, source: 94311 });
  assert.deepEqual(JSON.parse(same).devices['Baie vitree'].remotes, [94311]);

  const other = attachRemote(source, shutter, { id: 14177, source: 3359265281 });
  assert.deepEqual(JSON.parse(other).devices['Baie vitree'].remotes, [
    94311,
    { pid: 14177, addr: 3359265281 },
  ]);
});

test('a device missing from the pasted list yields no line', () => {
  const [shutter] = configOf(EXPORT).devmelDevices;
  assert.equal(attachRemote('', shutter, { id: 1, source: 2 }), null);
  assert.equal(attachRemote(JSON.stringify({ devices: [] }), shutter, { id: 1, source: 2 }), null);
});

test('the action writes the line for the emitter heard last', () => {
  const config = configOf(EXPORT);
  const heard = heardRemote({
    id: 14177,
    source: 3359265281,
    frames: 3,
    readings: [{ kind: READINGS.LEVEL, value: 100, command: 'up' }],
  });

  const message = attachHeardRemote({
    config,
    device: config.devmelDevices[0],
    heard,
    now: 1_012_000,
  });

  assert.match(message.fr, /pid 14177, addr 3359265281 \(3 trames, dernière il y a 12 s/);
  assert.match(message.fr, /level 100 \(up\)/);
  assert.match(message.fr, /« Baie vitree »/);
  assert.match(message.fr, /"remotes":\[\{"pid":14177,"addr":3359265281\}\]/);
  // Another protocol than the shutter, but the shutter never speaks: once the
  // line is pasted, the deduction listens to the remote, and that is what is
  // said — not a warning about a protocol nobody will listen to.
  assert.match(message.fr, /le boîtier écoute le pid 14177 : cette télécommande sera entendue/);
  assert.doesNotMatch(message.fr, /Attention/);
  assert.match(message.en, /Attached to "Baie vitree"/);
});

test('a listening channel forced elsewhere is named, with the pid to put in it', () => {
  const config = normalizeConfig({ devices: EXPORT, listen_channel: '25455' });
  const heard = heardRemote({ id: 14177, source: 3359265281 });

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });

  assert.match(message.fr, /Attention : une fois enregistré, le boîtier écoute le pid 25455/);
  assert.match(message.fr, /\(le champ Canal d'écoute\)/);
  assert.match(message.fr, /mettez 14177 dans le champ Canal d'écoute/);
});

test('listening turned off is said, rather than promising the remote is heard', () => {
  const config = normalizeConfig({ devices: EXPORT, listen_channel: '0' });
  const heard = heardRemote({ id: 14177, source: 3359265281 });

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });

  assert.match(message.fr, /L'écoute est désactivée/);
});

test('the other emitters heard are summed up, not all listed', () => {
  const config = configOf(EXPORT);
  const heard = new HeardChannels({ now: () => 1_000_000 });
  for (let addr = 6; addr >= 1; addr -= 1) {
    heard.record({ id: 4875, source: addr }, { timestamp: 1_000_000 - addr * 1000 });
  }
  heard.record({ id: 14177, source: 3359265281 }, { timestamp: 1_000_000 });

  const message = attachHeardRemote({
    config,
    device: config.devmelDevices[0],
    heard,
    now: 1_000_000,
  });

  assert.match(
    message.fr,
    /Autres émetteurs entendus, non rattachés : .*addr 1 .*addr 2 .*addr 3 /,
  );
  assert.doesNotMatch(message.fr, /addr 4 /);
  assert.match(message.fr, / ; et 3 autres\.$/);
  assert.match(message.en, /; and 3 more\.$/);
});

test('a remote on the protocol of its device gets no listening warning', () => {
  const config = configOf(EXPORT);
  const heard = heardRemote({ id: 25455, source: 94311, readings: [] });

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });

  assert.match(message.fr, /"remotes":\[\{"pid":25455,"addr":94311\}\]/);
  assert.doesNotMatch(message.fr, /qu'un protocole à la fois/);
  // No decodable note: attaching it names the emitter, it does not make the
  // shutter follow — saying so beats letting the user wait for a state.
  assert.match(message.fr, /aucune note décodable/);
});

test('an emitter already declared is not offered again', () => {
  const line = attachRemote(EXPORT, configOf(EXPORT).devmelDevices[0], {
    id: 14177,
    source: 3359265281,
  });
  const config = configOf(line);
  const heard = heardRemote({ id: 14177, source: 3359265281, claimed: true });

  assert.deepEqual(unclaimedEmitters(config, heard), []);
  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });
  assert.match(message.fr, /déjà déclarés/);
});

test('nothing heard yet says where to look instead of writing a line', () => {
  const config = configOf(EXPORT);
  const message = attachHeardRemote({
    config,
    device: config.devmelDevices[0],
    heard: new HeardChannels(),
  });

  assert.match(message.fr, /Aucune trame radio entendue/);
  assert.match(message.fr, /Tester la connexion/);
});

test('no device picked, no line: the action says what it needs', () => {
  const config = configOf(EXPORT);
  const message = attachHeardRemote({
    config,
    device: undefined,
    heard: heardRemote({ id: 14177, source: 3359265281 }),
  });

  assert.match(message.fr, /Choisissez l’appareil/);
});

test('a frame caught without its address gives way to the same remote, decoded', () => {
  const config = configOf(EXPORT);
  const heard = new HeardChannels({ now: () => 1_000_000 });
  heard.record({ id: 14177, source: 2755547649 }, { timestamp: 990_000 });
  heard.record({ id: 14177 }, { timestamp: 1_000_000 });

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });

  assert.match(message.fr, /"remotes":\[\{"pid":14177,"addr":2755547649\}\]/);
  assert.doesNotMatch(message.fr, /aucune adresse/);
});

test('no address on a protocol the box decodes addresses on: no line, press again', () => {
  // Another remote of the house is declared on 14177 WITH its address: a bare
  // `{pid: 14177}` would make this shutter follow that remote too.
  const config = configOf(
    JSON.stringify({
      devices: [
        {
          name: 'Cuisine',
          type: 4098,
          pid: 25455,
          addr: 229479,
          remotes: [{ pid: 14177, addr: 9 }],
        },
        { name: 'Chambre Kelyan', type: 4098, pid: 25455, addr: 65639 },
      ],
    }),
  );
  const heard = new HeardChannels({ now: () => 1_000_000 });
  heard.record({ id: 14177 }, { timestamp: 1_000_000 });

  const message = attachHeardRemote({ config, device: config.devmelDevices[1], heard });

  assert.match(message.fr, /mais pas son adresse/);
  assert.match(message.fr, /Rien n'a été rattaché/);
  assert.doesNotMatch(message.fr, /"remotes"/);
});

test('attaching a remote keeps the one declared without a list, or as "remote"', () => {
  for (const extra of [{ remote: 42 }, { remotes: 42 }, { remote: { pid: 25455, addr: 42 } }]) {
    const source = JSON.stringify({
      devices: [{ name: 'Baie vitree', type: 4098, pid: 25455, addr: 8295, ...extra }],
    });
    const device = configOf(source).devmelDevices[0];

    const line = attachRemote(source, device, { id: 25455, source: 99 });
    const [entry] = JSON.parse(line).devices;

    // Moved into the list, not left behind as a second declaration.
    assert.equal(entry.remote, undefined, JSON.stringify(extra));
    assert.deepEqual(configOf(line).devmelDevices[0].remotes, [
      { id: 25455, source: 42 },
      { id: 25455, source: 99 },
    ]);

    // And attaching the one already there changes nothing.
    const again = attachRemote(source, device, { id: 25455, source: 42 });
    assert.deepEqual(configOf(again).devmelDevices[0].remotes, [{ id: 25455, source: 42 }]);
  }
});

test('a remote decoded by the generic 433 MHz channel is asked for by name, not as 1', () => {
  // `1` in the Listening channel field means "deduce": advising it brought the
  // same deduction back, and the remote stayed unheard.
  const table = indexChannels([
    { id: 1, name: 'Generic 433MHz' },
    { id: 1368, name: 'Chacon', getDecoder: 1 },
    { id: 25455, name: 'Somfy RTS', getDecoder: 25455 },
  ]);
  const heard = heardRemote({ id: 1368, source: 777 });

  const forced = normalizeConfig({ devices: EXPORT, listen_channel: '25455' });
  const warning = attachHeardRemote({
    config: forced,
    device: forced.devmelDevices[0],
    heard,
    table,
  });
  assert.match(warning.en, /put "generic" in the Listening channel field/);
  assert.match(warning.fr, /mettez « générique » dans le champ Canal d'écoute/);
  assert.doesNotMatch(warning.en, /put 1 /);

  const off = normalizeConfig({ devices: EXPORT, listen_channel: '0' });
  const turnedOff = attachHeardRemote({ config: off, device: off.devmelDevices[0], heard, table });
  assert.match(turnedOff.en, /Put "generic" in that field, or empty it/);
  assert.match(turnedOff.fr, /Mettez « générique » dans ce champ/);

  // And the word advised is the one that does select the remote's decoder.
  const followed = normalizeConfig({ devices: EXPORT, listen_channel: 'generic' });
  assert.equal(planListening(followed, table).channel, 1);
});

test('no address, and the only one on the protocol is its own device: the last-resort line', () => {
  // The device's `addr` is the one the box transmits with, not proof that the
  // box decodes addresses on that protocol: "press again" was answered forever.
  const config = configOf(
    JSON.stringify({
      devices: [{ name: 'Volet Profalux', type: 4098, pid: 14177, addr: 3359265281 }],
    }),
  );
  const heard = new HeardChannels({ now: () => 1_000_000 });
  heard.record({ id: 14177 }, { timestamp: 1_000_000 });

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });

  assert.match(message.fr, /"remotes":\[\{"pid":14177\}\]/);
  assert.match(message.fr, /C'est le dernier recours/);
  assert.doesNotMatch(message.fr, /vos autres télécommandes/);
});

test('a remote heard only in dropped frames is not said to carry no order', () => {
  // A wall remote graded at the edge of the window (71): its frames are
  // dropped unread, and followed once it is attached by its address.
  const config = configOf(EXPORT);
  const heard = new HeardChannels({ now: () => 1_000_000 });
  heard.record(
    { id: 25455, source: 94311 },
    { dropped: 'unreliable, graded 71', timestamp: 1_000_000 },
  );

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });

  assert.match(message.fr, /"remotes":\[\{"pid":25455,"addr":94311\}\]/);
  assert.doesNotMatch(message.fr, /aucune note décodable/);
  assert.doesNotMatch(message.en, /will not follow/);
  assert.match(message.en, /dropped before any device \(unreliable, graded 71\)/);
  assert.match(message.en, /no longer dropped for its grade/);
  assert.match(message.fr, /n'est plus écartée pour sa note/);
});

test('a remote dropped with nothing to decode is not sent to "Accept unreliable frames"', async () => {
  // The docs' own example: graded 0, no address, no note the service could
  // decode. No setting makes usable what was never decoded, and the switch
  // for the whole neighbourhood was the one hint that could never help. What
  // the frames carried is remembered now, through the real routing.
  const config = configOf(
    JSON.stringify({ devices: [{ name: 'Volet', type: 4098, pid: 14177, addr: 3359265281 }] }),
  );
  const heard = new HeardChannels();
  const route = (event) =>
    captureLogs(() => applyEvents(createFakeGladys(), config, [event], heard, new SentOrders()))
      .result;
  await route({ type: 3, reliability: 0, channel: { id: 14177 }, thingnotes: { notes: [] } });

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });
  assert.match(message.en, /"remotes":\[\{"pid":14177\}\]/);
  assert.doesNotMatch(message.en, /Accept unreliable frames/);
  assert.doesNotMatch(message.fr, /Accepter les trames peu fiables/);
  assert.match(message.en, /no note the service could decode.*will not follow/);
  assert.match(message.fr, /aucune note décodable/);

  // A frame dropped for its grade that does carry an order keeps the advice
  // that it will be followed once attached by its address.
  const shutter = configOf(EXPORT);
  const edge = new HeardChannels();
  await captureLogs(() =>
    applyEvents(
      createFakeGladys(),
      shutter,
      [
        {
          type: 3,
          reliability: 71,
          channel: { id: 25455, source: 94311 },
          thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
        },
      ],
      edge,
      new SentOrders(),
    ),
  ).result;
  const kept = attachHeardRemote({
    config: shutter,
    device: shutter.devmelDevices[0],
    heard: edge,
  });
  assert.match(kept.en, /dropped before any device \(unreliable, graded 71\)/);
  assert.match(kept.en, /no longer dropped for its grade/);
  assert.doesNotMatch(kept.en, /will not follow/);
});

test('a remote whose earlier press decoded an order is not told it will not follow', async () => {
  // Only its last press was dropped, graded 0 with no note: the one before it
  // was routed and decoded UP, so the protocol does carry an order and the
  // remote, once attached by its address, is followed.
  const config = configOf(
    JSON.stringify({ devices: [{ name: 'Volet', type: 4098, pid: 25455, addr: 8295 }] }),
  );
  let now = 1_700_000_000_000;
  const heard = new HeardChannels({ now: () => now });
  const channel = { id: 25455, source: 94311 };
  const route = (event) =>
    captureLogs(() => applyEvents(createFakeGladys(), config, [event], heard, new SentOrders()))
      .result;
  await route({
    type: 3,
    reliability: 30,
    timestamp: now,
    channel,
    thingnotes: { notes: [{ type: NOTE_TYPES.STATE, value: STATE_VALUES.UP }] },
  });
  now += 5 * 60_000;
  await route({ type: 3, reliability: 0, timestamp: now, channel, thingnotes: { notes: [] } });

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard, now });
  assert.match(message.en, /"remotes":\[\{"pid":25455,"addr":94311\}\]/);
  assert.doesNotMatch(message.en, /no note the service could decode|will not follow/);
  assert.doesNotMatch(message.fr, /aucune note décodable|ne suivra donc pas/);
  assert.match(message.en, /no longer dropped for its grade/);
  assert.match(message.fr, /n'est plus écartée pour sa note/);
});

test('the AirSend box is refused as the device a remote drives', () => {
  const config = configOf(
    JSON.stringify({
      devices: [
        { name: 'AirSend', type: 0, sensors: true },
        { name: 'Baie vitree', type: 4098, pid: 25455, addr: 8295 },
      ],
    }),
  );
  const heard = heardRemote({ id: 25455, source: 94311 });

  const message = attachHeardRemote({ config, device: config.devmelDevices[0], heard });

  assert.match(message.en, /"AirSend" is the AirSend box itself/);
  assert.match(message.fr, /Choisissez l’appareil que pilote cette télécommande/);
  assert.doesNotMatch(message.en, /"remotes"|Attached/);
});
