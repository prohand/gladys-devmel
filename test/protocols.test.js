// -----------------------------------------------------------------------------
// Finding the pid of a protocol — the answer to "how do I listen to 868 MHz?",
// which is not a band the box can be pointed at but a protocol to name.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProtocol, matchProtocols, SHOWN } from '../src/devmel/protocols.js';
import { indexChannels, planListening } from '../src/devmel/listening.js';
import { normalizeConfig } from '../src/config.js';

const TABLE = indexChannels([
  { id: 1, name: 'Generic 433MHz' },
  { id: 1368, name: 'Nexus', getDecoder: 1 },
  { id: 14177, name: 'Profalux', getDecoder: 0 },
  { id: 25455, name: 'Somfy RTS', getDecoder: 25455 },
  { id: 26848, name: 'Somfy io', getDecoder: 26848 },
]);

const DEVICES =
  '{"devices":[{"name":"Baie vitree","type":4098,"pid":25455,"addr":8295,' +
  '"remotes":[{"pid":14177,"addr":3359265281}]}]}';

function configWith(overrides = {}) {
  return normalizeConfig({
    spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50',
    devices: DEVICES,
    ...overrides,
  });
}

test('a protocol is found by its name, whatever the case and the accents', () => {
  const channels = [...TABLE.values()];

  assert.deepEqual(
    matchProtocols(channels, 'SOMFY').map((channel) => channel.id),
    [25455, 26848],
  );
  assert.deepEqual(
    matchProtocols(channels, '  profalux ').map((channel) => channel.id),
    [14177],
  );
  // And by its pid, which is what a log line and the AirSend app both print.
  assert.deepEqual(
    matchProtocols(channels, '14177').map((channel) => channel.id),
    [14177],
  );
  // An empty search is everything, in a stable order.
  assert.equal(matchProtocols(channels, '').length, 5);
  assert.deepEqual(matchProtocols(channels, 'nothing here'), []);
});

test('the answer says how each protocol is decoded', () => {
  const config = configWith();
  const plan = planListening(config, TABLE);

  const report = findProtocol({ table: TABLE, config, plan, search: 'somfy' });

  assert.match(report.en, /2 protocols for "somfy":/);
  assert.match(report.en, /- pid 25455 — Somfy RTS \(decodes itself, declared on "Baie vitree"\)/);
  assert.match(report.fr, /- pid 26848 — Somfy io \(décodé par lui-même\)/);
  // What to do with what was found.
  assert.match(report.fr, /Canal d’écoute/);
});

test('the protocol being listened to is pointed out where it is read', () => {
  const config = configWith();
  const plan = planListening(config, TABLE);

  // The remote won the deduction: this is the 868 MHz protocol of the house.
  assert.equal(plan.channel, 14177);
  const report = findProtocol({ table: TABLE, config, plan, search: 'profalux' });

  assert.match(report.en, /pid 14177 — Profalux \(only partially decoded.*listened to right now/);
  assert.match(report.fr, /écouté actuellement/);
});

test('a protocol carried by the generic 433 MHz decoder says so', () => {
  const report = findProtocol({ table: TABLE, config: configWith(), search: 'nexus' });

  assert.match(report.en, /pid 1368 — Nexus \(decoded by channel 1, generic 433 MHz\)/);
  assert.match(report.fr, /décodé par le canal 1, générique 433 MHz/);
});

test('a search with nothing to show says what to search by', () => {
  const report = findProtocol({ table: TABLE, config: configWith(), search: 'zigbee' });

  assert.match(report.en, /No protocol of the 5 the service knows matches "zigbee"/);
  assert.match(report.fr, /Aucun des 5 protocoles connus/);
});

test('an empty search shows the beginning of the list, and counts the rest', () => {
  const many = indexChannels(
    Array.from({ length: SHOWN + 3 }, (unused, index) => ({ id: index + 1, name: `P${index}` })),
  );

  const report = findProtocol({ table: many, config: configWith(), search: '' });

  assert.match(report.en, new RegExp(`${SHOWN + 3} protocols known by the AirSend service`));
  assert.match(report.en, /\(\+3 more — narrow the search down\.\)/);
  assert.match(report.fr, /\(\+3 autres — affinez la recherche\.\)/);
});

test('an unreachable service is said as such, not as an empty list', () => {
  const report = findProtocol({ table: new Map(), config: configWith(), search: 'somfy' });

  assert.match(report.en, /did not answer with its protocol list.*Test the connection/s);
  assert.match(report.fr, /Tester la connexion/);
});
