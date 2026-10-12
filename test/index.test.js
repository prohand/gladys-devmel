// -----------------------------------------------------------------------------
// index.js, the wiring: the real module on the real SDK object, with only the
// HTTP API of Gladys stood in for. The module starts on import, so this file
// holds ONE running integration, shared by its tests in the order they run.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GladysIntegration } from '@gladysassistant/integration-sdk';
import { captureLogs } from './helpers/captureLogs.js';
import { heardChannels } from '../src/devmel/heard.js';

// Nothing reachable: no service, no box. What is under test is what the
// integration says and asks of Gladys, not the radio.
const BASE_CONFIG = { use_embedded_service: false, service_url: 'http://127.0.0.1:9/' };

/** The HTTP API of Gladys, as the SDK calls it. */
const api = {
  config: BASE_CONFIG,
  /** What GET /webhook answers: Gladys Plus, linked or not. */
  webhooks: { available: false, webhooks: [] },
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
        return api.webhooks;
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

/**
 * An AirSend Web Service on the loopback: every bind waits `bindDelayMs`, then
 * answers the next status of `bindAnswers` (200 once they run out).
 */
async function startFakeService() {
  const service = { bindAnswers: [], bindDelayMs: 0, binds: 0 };
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const answer = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.url.startsWith('/channels')) {
        answer(200, []);
      } else if (request.url.startsWith('/airsend/bind')) {
        service.binds += 1;
        service.onBind?.();
        const status = service.bindAnswers.shift() ?? 200;
        setTimeout(() => answer(status, {}), service.bindDelayMs);
      } else {
        answer(200, {});
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  service.url = `http://127.0.0.1:${server.address().port}`;
  service.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return service;
}

/** A shutter with its wall remote, on a service of the user's own, Gladys Plus linked. */
function radioConfig(service, overrides = {}) {
  return {
    use_embedded_service: false,
    service_url: service.url,
    spurl: 'sp://secret@192.168.1.50',
    devices: JSON.stringify({
      devices: [{ name: 'Volet', type: 4098, pid: 25455, addr: 8295, remotes: [94311] }],
    }),
    ...overrides,
  };
}

async function saveConfig(config) {
  api.config = config;
  await captureLogs(() => fromGladys('external-integration.config-updated', { config })).result;
}

test('each re-arm of index.js answers from its own attempt, a disconnection included', async (t) => {
  // A double click on the widget button: the second request is queued behind
  // the first one's bind. Each must answer what ITS bind did — the first one
  // took, the second was refused — and not whatever the shared state holds
  // by the time it reads it.
  const service = await startFakeService();
  api.webhooks = {
    available: true,
    webhooks: [{ key: 'events', url: 'https://plus.example/webhook/events' }],
  };
  t.after(async () => {
    api.webhooks = { available: false, webhooks: [] };
    await saveConfig(BASE_CONFIG);
    await service.close();
  });
  await saveConfig(radioConfig(service));

  const rearm = () => gladys.handlers['widgetAction:radio']('rearm');
  service.bindDelayMs = 50;
  service.bindAnswers = [200, 401];
  const both = captureLogs(() => Promise.allSettled([rearm(), rearm()]));
  const [first, second] = await both.result;

  assert.equal(first.status, 'fulfilled', String(first.reason));
  assert.equal(first.value.en, 'Listening re-armed on channel 25455.');
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /refused the subscription: Invalid connection string/);

  // Gladys disconnects while the first binds: the queued one is cancelled and
  // says so, the one binding still answers from its own bind.
  service.bindAnswers = [];
  const cut = captureLogs(async () => {
    const binding = new Promise((resolve) => {
      service.onBind = resolve;
    });
    const running = Promise.allSettled([rearm(), rearm()]);
    await binding;
    for (const listener of gladys.listeners('disconnected')) {
      listener();
    }
    return running;
  });
  const [binding, queued] = await cut.result;
  assert.equal(binding.status, 'fulfilled', String(binding.reason));
  assert.equal(binding.value.en, 'Listening re-armed on channel 25455.');
  assert.equal(queued.status, 'rejected');
  assert.match(queued.reason.message, /stopped before it could be armed/);
});

test('a reconnection to Gladys keeps what the remotes did; a configuration change forgets it', async (t) => {
  // The SDK emits 'connected' after every re-authentication: a Gladys restart,
  // a network blip. The configuration read back is the one already applied,
  // and a remote being followed did not become "not heard since the
  // configuration changed".
  const service = await startFakeService();
  t.after(async () => {
    await saveConfig(BASE_CONFIG);
    await service.close();
  });
  const config = radioConfig(service);
  await saveConfig(config);
  const entry = heardChannels.record(
    { id: 25455, source: 94311 },
    { readings: [{ kind: 'level', value: 100, command: 'up' }], claimed: true, understood: true },
  );

  await captureLogs(connected).result;
  assert.equal(entry.stale, false);
  assert.equal(entry.understood, true);

  // A real change: the verdict belonged to the previous configuration.
  await saveConfig({ ...config, listen_channel: '25455' });
  assert.equal(entry.stale, true);
  assert.equal(entry.understood, false);
});
