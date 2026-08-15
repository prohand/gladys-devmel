// -----------------------------------------------------------------------------
// What the Configuration screen says: the status published after every
// initialization, and the "Test the connection" action.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxDevices, describeConnection, testConnection } from '../src/devmel/connection.js';
import { indexChannels, planListening } from '../src/devmel/listening.js';
import { normalizeConfig } from '../src/config.js';

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

test('the implicit box follows the service that actually serves the local channel', () => {
  // No box in the device list: one is rebuilt from the global credentials, and
  // the bundled service is enough for it to exist.
  assert.equal(boxDevices(normalizeConfig({ spurl: SPURL })).length, 1);
  assert.equal(
    boxDevices(normalizeConfig({ spurl: SPURL, use_embedded_service: false })).length,
    0,
  );
});
