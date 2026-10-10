import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { HeardChannels } from '../src/devmel/heard.js';
import { attachHeardRemote, attachRemote, unclaimedEmitters } from '../src/devmel/remotes.js';
import { READINGS } from '../src/devmel/notes.js';

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
