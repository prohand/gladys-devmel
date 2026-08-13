import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  EMBEDDED_SERVICE_URL,
  hostFromSpurl,
  normalizeConfig,
  parseDevices,
} from '../src/config.js';

test('normalizeConfig falls back to the defaults', () => {
  const config = normalizeConfig();
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
  assert.equal(config.listen_channel, DEFAULT_CONFIG.listen_channel);
  assert.equal(config.GLADYS_PREFER_LOCAL, true);
  assert.deepEqual(config.devmelDevices, []);
});

test('normalizeConfig coerces the values coming from the form', () => {
  const config = normalizeConfig({
    service_url: '  http://192.168.1.50:33863/  ',
    poll_frequency: '600',
    listen_channel: '3',
    GLADYS_PREFER_LOCAL: false,
  });
  assert.equal(config.service_url, 'http://192.168.1.50:33863/');
  assert.equal(config.poll_frequency, 600);
  assert.equal(config.listen_channel, 3);
  assert.equal(config.GLADYS_PREFER_LOCAL, false);
});

test('parseDevices reads the YAML exported by airsend.cloud', () => {
  const devices = parseDevices(
    `devices:
  AirSend box:
    type: 0
    spurl: !secret spurl
    sensors: true
    refresh: 120
  Living room shutter:
    id: 12345
    type: 4098
    invert: true
    apiKey: !secret apiKey
    channel:
      id: 25455
      source: 94311`,
    { spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50', api_key: 'cloud-key' },
  );

  assert.equal(devices.length, 2);

  const [box, shutter] = devices;
  assert.equal(box.rtype, 0);
  assert.equal(box.sensors, true);
  assert.equal(box.refresh, 120);
  assert.deepEqual(box.channel, { id: 1 });
  // `!secret spurl` resolves against the credentials of the configuration form.
  assert.equal(box.spurl, 'sp://pass@[fe80::1]?rhost=192.168.1.50');
  assert.equal(box.platformId, '192-168-1-50');

  assert.equal(shutter.rtype, 4098);
  assert.equal(shutter.invert, true);
  assert.equal(shutter.apiKey, 'cloud-key');
  assert.deepEqual(shutter.channel, { id: 25455, source: 94311 });
  assert.equal(shutter.platformId, '12345');
});

test('parseDevices accepts JSON, with or without the devices wrapper', () => {
  const withWrapper = parseDevices('{"devices":{"Plug":{"type":4097,"channel":{"id":7}}}}');
  const withoutWrapper = parseDevices('{"Plug":{"type":4097,"channel":{"id":7}}}');
  const asList = parseDevices('[{"name":"Plug","type":4097,"channel":{"id":7}}]');

  for (const devices of [withWrapper, withoutWrapper, asList]) {
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'Plug');
    assert.equal(devices[0].rtype, 4097);
    assert.equal(devices[0].platformId, '7');
  }
});

test('parseDevices reads the JSON exported by airsend.cloud (pid/addr)', () => {
  // Verbatim shape of the "Export JSON" of airsend.cloud: a list, the channel
  // flattened into `pid` (channel id) and `addr` (channel source).
  const devices = parseDevices(
    '{"devices":[{"name":"Baie vitree","localip":"fe80::dcf6:e5ff:fe8f:89cd","type":4098,"pid":25455,"addr":8295}]}',
  );

  assert.equal(devices.length, 1);
  const [shutter] = devices;
  assert.equal(shutter.name, 'Baie vitree');
  assert.equal(shutter.rtype, 4098);
  assert.deepEqual(shutter.channel, { id: 25455, source: 8295 });
  assert.equal(shutter.localIp, 'fe80::dcf6:e5ff:fe8f:89cd');
  assert.equal(shutter.id, null);
  assert.equal(shutter.platformId, '25455-8295');
});

test('the cloud id is never mistaken for a channel id', () => {
  const [cloudOnly, both] = parseDevices(`
    Cloud only:
      id: 12345
      type: 4097
    Both:
      id: 54321
      type: 4098
      pid: 25455
      addr: 8295
  `);
  // A device known by its cloud id alone has no radio channel at all...
  assert.equal(cloudOnly.channel, null);
  assert.equal(cloudOnly.platformId, '12345');
  // ...and when both are there, each keeps its own meaning.
  assert.equal(both.id, '54321');
  assert.deepEqual(both.channel, { id: 25455, source: 8295 });
});

test('a nested channel wins over the flat fields of the JSON export', () => {
  const [device] = parseDevices(
    '[{"name":"Plug","type":4097,"pid":1,"channel":{"id":7,"source":2}}]',
  );
  assert.deepEqual(device.channel, { id: 7, source: 2 });
});

test('parseDevices drops what it cannot use', () => {
  const devices = parseDevices(`
    Unknown type:
      type: 9999
      channel: { id: 1 }
    No channel nor id:
      type: 4097
    Valid:
      type: 4097
      channel: { id: 1, source: 2 }
    Duplicate:
      type: 4097
      channel: { id: 1, source: 2 }
  `);
  assert.deepEqual(
    devices.map((device) => device.name),
    ['Valid'],
  );
});

test('parseDevices survives a broken paste', () => {
  assert.deepEqual(parseDevices('this is: not: valid: yaml'), []);
  assert.deepEqual(parseDevices('   '), []);
  assert.deepEqual(parseDevices(undefined), []);
});

test('a sensor declares the readings it emits, and clicks by default', () => {
  const [withFeatures, bare] = parseDevices(`
    Outdoor sensor:
      type: 1
      features: [temperature, humidity, nonsense]
      channel: { id: 1368, source: 542 }
    Original remote:
      type: 1
      channel: { id: 13920, source: 568745 }
  `);
  assert.deepEqual(withFeatures.features, ['temperature', 'humidity']);
  assert.deepEqual(bare.features, ['click']);
});

test('hostFromSpurl extracts the box address', () => {
  assert.equal(hostFromSpurl('sp://pass@[fe80::1234]?gw=0&rhost=192.168.1.50'), '192.168.1.50');
  assert.equal(hostFromSpurl('sp://pass@[fe80::1234]?gw=0'), 'fe80::1234');
  assert.equal(hostFromSpurl(''), null);
});

test('the bundled service serves the local channel out of the box', () => {
  const config = normalizeConfig({ spurl: 'sp://pass@[fe80::1]?rhost=192.168.1.50' });
  assert.equal(config.use_embedded_service, true);
  assert.equal(config.embeddedService, true);
  assert.equal(config.effectiveServiceUrl, EMBEDDED_SERVICE_URL);
  assert.equal(config.effectiveServiceUrl, 'http://127.0.0.1:33863');
});

test('a service URL typed by the user wins over the bundled one', () => {
  const config = normalizeConfig({ service_url: 'http://192.168.1.50:33863/' });
  // Nothing to start in our own container: the user runs the service already.
  assert.equal(config.embeddedService, false);
  assert.equal(config.effectiveServiceUrl, 'http://192.168.1.50:33863/');
});

test('turning the bundled service off leaves no local channel at all', () => {
  const config = normalizeConfig({ use_embedded_service: false });
  assert.equal(config.embeddedService, false);
  assert.equal(config.effectiveServiceUrl, '');
});
