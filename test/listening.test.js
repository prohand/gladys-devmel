// -----------------------------------------------------------------------------
// Which protocol the box is asked to listen to.
//
// The channel table used here is shaped like the answer of `GET /channels/`:
// an entry per protocol, `getDecoder` naming the channel that decodes it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decoderOf, indexChannels, planListening } from '../src/devmel/listening.js';
import { normalizeConfig } from '../src/config.js';

// A shutter, a light and a sensor, each on its own protocol.
const SHUTTER = { name: 'Baie vitree', type: 4098, pid: 25455, addr: 8295 };
const OTHER_SHUTTER = { name: 'Volet salon', type: 4098, pid: 25455, addr: 94311 };
const LIGHT = { name: 'Lumiere pergola', type: 4100, pid: 26848, addr: 1442421508 };
const CHEAP_SENSOR = { name: 'Capteur exterieur', type: 1, pid: 1368, addr: 542 };

const TABLE = indexChannels([
  { id: 1, name: 'Generic 433MHz' },
  { id: 25455, name: 'Somfy RTS', getDecoder: 25455 },
  { id: 26848, name: 'Pergola', getDecoder: 26848 },
  // Decoded by the generic decoder: listening to 1 is enough for it.
  { id: 1368, name: 'Nexus', getDecoder: 1 },
]);

function configWith(devices, overrides = {}) {
  return normalizeConfig({
    spurl: 'sp://pass@[fe80::1]?gw=0&rhost=192.168.1.50',
    devices: JSON.stringify({ devices }),
    ...overrides,
  });
}

test('a protocol is decoded by itself unless the table names another channel', () => {
  assert.equal(decoderOf(25455, TABLE), 25455);
  // "Included in the generic decoder" is what `getDecoder: 1` says.
  assert.equal(decoderOf(1368, TABLE), 1);
  // Unknown to the service, or no table at all: its own channel is the guess.
  assert.equal(decoderOf(4321, TABLE), 4321);
  assert.equal(decoderOf(4321, new Map()), 4321);
});

test('the channel is deduced from the declared devices, not fixed to generic', () => {
  const plan = planListening(configWith([SHUTTER]), TABLE);

  assert.equal(plan.enabled, true);
  assert.equal(plan.deduced, true);
  assert.equal(plan.channel, 25455);
  assert.equal(plan.name, 'Somfy RTS');
  assert.deepEqual(
    plan.covered.map((device) => device.name),
    ['Baie vitree'],
  );
  assert.deepEqual(plan.uncovered, []);
});

test('a device the generic decoder covers is listened to on channel 1', () => {
  const plan = planListening(configWith([CHEAP_SENSOR]), TABLE);

  assert.equal(plan.channel, 1);
  assert.equal(plan.uncovered.length, 0);
});

test('without the channel table, the protocol of the devices is still the answer', () => {
  const plan = planListening(configWith([SHUTTER]));

  assert.equal(plan.channel, 25455);
  assert.equal(plan.name, null);
  assert.equal(plan.uncovered.length, 0);
});

test('one radio, one protocol: the majority wins and the rest is reported', () => {
  const plan = planListening(configWith([LIGHT, SHUTTER, OTHER_SHUTTER]), TABLE);

  assert.equal(plan.channel, 25455);
  assert.deepEqual(
    plan.covered.map((device) => device.name),
    ['Baie vitree', 'Volet salon'],
  );
  assert.deepEqual(
    plan.uncovered.map((device) => device.name),
    ['Lumiere pergola'],
  );
});

test('a tie is settled the same way on every restart', () => {
  const first = planListening(configWith([LIGHT, SHUTTER]), TABLE);
  const reversed = planListening(configWith([SHUTTER, LIGHT]), TABLE);

  assert.equal(first.channel, 25455);
  assert.equal(reversed.channel, 25455);
});

test('a wall remote declared on a device is heard like the device itself', () => {
  const config = configWith([{ ...LIGHT, remotes: [{ pid: 25455, addr: 94311 }] }]);

  const plan = planListening(config, TABLE);

  // Two channels for one device, and the remote is on the protocol the
  // shutter uses: that is now the one worth listening to.
  assert.equal(plan.channel, 25455);
  assert.deepEqual(
    plan.covered.map((device) => device.name),
    ['Lumiere pergola'],
  );
});

test('a channel typed by the user wins over the deduction', () => {
  const plan = planListening(configWith([SHUTTER], { listen_channel: 4321 }), TABLE);

  assert.equal(plan.deduced, false);
  assert.equal(plan.channel, 4321);
  assert.deepEqual(
    plan.uncovered.map((device) => device.name),
    ['Baie vitree'],
  );
});

test('the box itself never decides what is listened to', () => {
  // A box carries the connection string, not a radio protocol: it answers on
  // channel 1 like every other box, which says nothing about the equipment.
  const box = { name: 'AirSend box', type: 0, sensors: true };

  assert.equal(planListening(configWith([box, SHUTTER]), TABLE).channel, 25455);
  // Nothing declared but the box: generic 433 MHz is all there is to listen to.
  assert.equal(planListening(configWith([box]), TABLE).channel, 1);
});

test('listening is off only when the user turns it off', () => {
  assert.equal(planListening(configWith([SHUTTER], { listen_channel: 0 }), TABLE).enabled, false);
  assert.equal(planListening(configWith([SHUTTER], { listen_channel: '' }), TABLE).enabled, true);
  assert.equal(planListening(normalizeConfig(), TABLE).enabled, true);
});
