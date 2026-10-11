// -----------------------------------------------------------------------------
// index.js, the wiring: the real module on the real SDK object, with only the
// HTTP API of Gladys stood in for. The module starts on import, so this file
// holds ONE running integration, shared by its tests in the order they run.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GladysIntegration } from '@gladysassistant/integration-sdk';
import { captureLogs } from './helpers/captureLogs.js';

// Nothing reachable: no service, no box. What is under test is what the
// integration says and asks of Gladys, not the radio.
const BASE_CONFIG = { use_embedded_service: false, service_url: 'http://127.0.0.1:9/' };

/** The HTTP API of Gladys, as the SDK calls it. */
const api = {
  config: BASE_CONFIG,
  failDiscovery: false,
  posts: [],
  postsTo(route) {
    return this.posts.filter((post) => post.route === route).map((post) => post.body);
  },
};

const fakeHttpClient = {
  async get(route) {
    switch (route) {
      case '/config':
        return { config: api.config };
      case '/device':
        return [];
      case '/webhook':
        return { available: false, webhooks: [] };
      default:
        return {};
    }
  },
  async post(route, body) {
    api.posts.push({ route, body });
    if (route === '/discovered_device' && api.failDiscovery) {
      throw new Error('POST /discovered_device timed out');
    }
    return {};
  },
};

let gladys = null;
let shutdown = null;
let dataDir = null;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'devmel-index-'));
  process.env.GLADYS_HOST_API_URL = 'http://127.0.0.1:1';
  process.env.GLADYS_INTEGRATION_TOKEN = 'token';
  process.env.GLADYS_INTEGRATION_SELECTOR = 'devmel';
  process.env.DEVMEL_DATA_DIR = dataDir;
  process.env.DEVMEL_SERVICE_DIR = dataDir;
  GladysIntegration.prototype.connect = async function connect() {
    gladys = this;
    this.httpClient = fakeHttpClient;
  };
  GladysIntegration.prototype.handleShutdown = (cleanup) => {
    shutdown = cleanup;
  };
  await import('../index.js');
});

after(async () => {
  await shutdown?.('test');
  await rm(dataDir, { recursive: true, force: true });
});

/** Run the integration's 'connected' handlers to the end. */
async function connected() {
  await Promise.all(gladys.listeners('connected').map((listener) => listener()));
}

/** A message from Gladys, through the SDK's own dispatch. */
async function fromGladys(type, payload) {
  await gladys._handleMessage(JSON.stringify({ type, payload }));
}

function lastStatus() {
  return api.postsTo('/connection_status').at(-1);
}

test('a configuration save Gladys refuses is logged, shown, and still re-arms listening', async () => {
  await connected();
  assert.notEqual(lastStatus()?.message?.en, 'Initialization failed, check the integration logs.');

  api.failDiscovery = true;
  const logs = captureLogs(() =>
    fromGladys('external-integration.config-updated', {
      config: { ...BASE_CONFIG, listen_channel: 0 },
    }),
  );
  await logs.result;
  api.failDiscovery = false;

  assert.ok(
    logs.of('ERROR').some((line) => line.includes('configuration save failed')),
    logs.of('ERROR').join('\n'),
  );
  assert.equal(lastStatus().connected, false);
  assert.equal(lastStatus().message.en, 'Initialization failed, check the integration logs.');
  // The box hears what the new configuration asks, whatever Gladys answered.
  assert.ok(logs.of('INFO').some((line) => line.includes('Listening disabled')));
});

test('past a hundred devices, the badges go out in slices and the start completes', async () => {
  const devices = {};
  for (let index = 1; index <= 101; index += 1) {
    devices[`Plug ${index}`] = { type: 4097, channel: { id: 200, source: index } };
  }
  api.config = { ...BASE_CONFIG, devices: JSON.stringify({ devices }) };
  api.posts.length = 0;

  const logs = captureLogs(connected);
  await logs.result;
  api.config = BASE_CONFIG;

  assert.deepEqual(logs.of('ERROR'), []);
  assert.deepEqual(
    api.postsTo('/device/transport').map((body) => body.transports.length),
    [100, 1],
  );
  assert.notEqual(lastStatus().message?.en, 'Initialization failed, check the integration logs.');
});

test('the Gladys Plus webhook reads a lone event, like the loopback callback', async () => {
  // The answer to a fire-and-forget transfer is one event, not a list: posted
  // by a service on another machine, it reaches us through the relay.
  await connected();
  const logs = captureLogs(() =>
    fromGladys('external-integration.webhook.received', {
      webhook_key: 'events',
      method: 'POST',
      body: JSON.stringify({
        type: 3,
        reliability: 0x20,
        channel: { id: 777, source: 5 },
        thingnotes: { notes: [{ type: 'STATE', value: 'TOGGLE' }] },
      }),
    }),
  );
  await logs.result;

  assert.ok(
    logs.of('INFO').some((line) => line.includes('no device declares: pid 777, addr 5')),
    logs.of('INFO').join('\n'),
  );
});

test('the save that turns detailed logs on already logs the connection string it parsed', async () => {
  const spurl = 'sp://secret@192.168.1.50?gw=0';
  const save = (debug) =>
    captureLogs(() =>
      fromGladys('external-integration.config-updated', {
        config: { ...BASE_CONFIG, spurl, debug_logs: debug },
      }),
    );

  const on = save(true);
  await on.result;
  // Then off again, with debug lines still captured if any slipped through.
  const off = save(false);
  await off.result;

  const described = (logs) =>
    logs.of('DEBUG').filter((line) => line.includes('Connection string: sp://<6 characters>@'));
  assert.equal(described(on).length, 1, on.of('DEBUG').join('\n'));
  assert.deepEqual(described(off), []);
  assert.ok(on.of('DEBUG').every((line) => !line.includes('secret')));
});
