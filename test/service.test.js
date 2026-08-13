// -----------------------------------------------------------------------------
// The supervisor of the bundled AirSend Web Service.
//
// The real binary is not in the repository (the image downloads it from Devmel
// at build time), so these tests stand a script in its place that behaves the
// way it does: fork an HTTP server, write its pid in `AirSendWebService.lock`,
// and exit immediately.
// -----------------------------------------------------------------------------

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirSendService, SERVICE_URL } from '../src/devmel/service.js';

const started = [];

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()();
  }
});

test('the bundled service answers on the loopback address', () => {
  assert.equal(SERVICE_URL, 'http://127.0.0.1:33863');
});

test('a configuration that wants no embedded service starts nothing', async () => {
  const service = new AirSendService({ serviceDir: '/nonexistent', dataDir: '/nonexistent' });

  assert.equal(await service.apply({ embeddedService: false }), false);
  assert.deepEqual(service.status(), {
    wanted: false,
    running: false,
    url: SERVICE_URL,
    error: null,
  });
});

test('a missing binary is reported, not thrown: the integration keeps running', async () => {
  const service = new AirSendService({
    serviceDir: await mkdtemp(join(tmpdir(), 'devmel-empty-')),
    dataDir: await mkdtemp(join(tmpdir(), 'devmel-data-')),
    url: `http://127.0.0.1:${await freePort()}`,
  });

  assert.equal(await service.apply({ embeddedService: true }), false);
  const status = service.status();
  assert.equal(status.wanted, true);
  assert.equal(status.running, false);
  assert.match(status.error, /No AirSend Web Service binary/);
});

test('it starts the daemon, reads its pid and stops it', async () => {
  const port = await freePort();
  const { service, workDir } = await serviceWithFakeBinary(port);

  assert.equal(await service.apply({ embeddedService: true }), true);
  assert.equal(service.status().running, true);
  assert.equal(service.status().error, null);

  // The pid comes from the lock file the daemon leaves behind: the process we
  // spawned has already exited by then.
  const lock = Number(await readFile(join(workDir, 'AirSendWebService.lock'), 'utf8'));
  assert.equal(service.pid, lock);
  assert.equal(await service.probe(), true);

  await service.stop();
  assert.equal(service.status().running, false);
  assert.equal(await service.probe(), false);
});

test('a service already answering is adopted, not started a second time', async () => {
  const port = await freePort();
  const { service } = await serviceWithFakeBinary(port);
  await listenOn(port);

  assert.equal(await service.start(), true);
  // Nothing was spawned, so no lock file was written.
  assert.equal(service.pid, null);
  assert.equal(service.status().running, true);
});

test('a daemon that died is started again by the watchdog', async () => {
  const port = await freePort();
  const { service } = await serviceWithFakeBinary(port);

  await service.apply({ embeddedService: true });
  const firstPid = service.pid;
  await service.stop();
  // stop() disarms the watchdog; check() is what it would have run.
  service.wanted = true;

  await service.check();

  assert.equal(service.status().running, true);
  assert.notEqual(service.pid, firstPid);
  await service.stop();
});

/** A port nothing listens on yet. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Hold a port with a real HTTP server, closed at the end of the test. */
async function listenOn(port) {
  const server = createServer((_request, response) => {
    response.statusCode = 401;
    response.end();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  started.push(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

/**
 * An AirSendService whose binary is a stand-in for the real one: it forks an
 * HTTP server on the port it is given, writes its pid where the real daemon
 * does, and returns straight away.
 */
async function serviceWithFakeBinary(port) {
  const serviceDir = await mkdtemp(join(tmpdir(), 'devmel-service-'));
  const workDir = await mkdtemp(join(tmpdir(), 'devmel-data-'));

  const daemon = [
    'const http = require("node:http");',
    'const fs = require("node:fs");',
    'const server = http.createServer((q, r) => { r.statusCode = 401; r.end(); });',
    'server.listen(Number(process.argv[1]), "127.0.0.1", () => {',
    '  fs.writeFileSync("AirSendWebService.lock", String(process.pid));',
    '});',
  ].join('');
  const script = `#!/bin/sh\nnode -e '${daemon}' "$1" &\nexit 0\n`;

  // process.arch decides which directory is looked up; write them all.
  for (const arch of ['x86_64', 'arm64', 'arm', 'armhf', 'x86']) {
    const dir = join(serviceDir, 'bin', 'unix', arch);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AirSendWebService'), script);
    await chmod(join(dir, 'AirSendWebService'), 0o755);
  }

  const service = new AirSendService({
    serviceDir,
    dataDir: workDir,
    url: `http://127.0.0.1:${port}`,
    // The real binary takes `65536 + port`; the stand-in takes the port.
    argument: port,
  });
  started.push(() => service.stop());
  return { service, workDir };
}
