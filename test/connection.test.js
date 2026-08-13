// -----------------------------------------------------------------------------
// What the Configuration screen says: the status published after every
// initialization, and the "Test the connection" action.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxDevices, describeConnection, testConnection } from '../src/devmel/connection.js';
import { normalizeConfig } from '../src/config.js';

const SPURL = 'sp://pass@[fe80::1]?gw=0&rhost=192.168.1.50';

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

test('a bundled service that would not start still leaves airsend.cloud', async () => {
  const service = fakeService({ wanted: true, running: false, error: 'binary missing' });
  const config = normalizeConfig({ spurl: SPURL, api_key: 'cloud-key' });

  const status = await describeConnection(fakeClient(), config, service);

  assert.equal(status.connected, true);
  assert.match(status.message.fr, /les commandes passent par airsend.cloud/);
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
  // The cloud key is optional, and the report says as much.
  assert.match(report.en, /Cloud: no API key — optional/);
});

test('test_connection reports a local channel switched off entirely', async () => {
  const config = normalizeConfig({ use_embedded_service: false });

  const report = await testConnection(fakeClient(), config, null);

  assert.match(report.en, /Local: disabled/);
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
