// -----------------------------------------------------------------------------
// The AirSend Web Service, embedded.
//
// The local channel needs Devmel's own HTTP server: it is the piece that speaks
// the box's protocol over the LAN. Until now the user had to run it themselves
// (the Home Assistant add-on, the Jeedom daemon, a container of their own) and
// tell Gladys where it lives.
//
// The image ships that binary, and this module supervises it inside the
// integration's own container, on the loopback address:
//
//     http://127.0.0.1:33863
//
// So a fresh install has one thing left to fill in: the `sp://` connection
// string of the box. The user keeps the option of pointing at a service running
// somewhere else — filling the URL field wins over the embedded one.
//
// Two things about the binary drive the code below:
//   - it DAEMONIZES. The process we spawn forks and returns immediately; the
//     real server is a grandchild whose pid it leaves in `AirSendWebService.lock`
//     in the working directory. There is no child handle to watch, so liveness
//     is `kill(pid, 0)` plus an HTTP probe.
//   - it writes that lock file where it runs, and the Gladys sandbox mounts the
//     rootfs read-only. It therefore runs with /data as its working directory.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'airsend-service' });

/** Where the embedded service answers. Also the default `service_url`. */
export const SERVICE_PORT = 33863;
export const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;

// The binary takes a single argument. Devmel's add-on passes `99399` to serve
// port 33863 directly, and the bare port number when nginx fronts it on the
// loopback — `99399` is `65536 + 33863`, so the argument is built the same way.
const PORT_ARGUMENT = 65536 + SERVICE_PORT;

// The pid file the binary drops in its working directory once it has forked.
const LOCK_FILE = 'AirSendWebService.lock';

// Devmel ships one binary per architecture, under `bin/unix/<arch>/`. Node's
// `process.arch` does not distinguish armv6 from armv7, so `arm` tries both
// names the tarball uses and keeps the first that exists.
const ARCHITECTURES = {
  x64: ['x86_64'],
  arm64: ['arm64'],
  arm: ['arm', 'armhf'],
  ia32: ['x86'],
};

const START_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 2000;
const PROBE_INTERVAL_MS = 250;
const WATCHDOG_INTERVAL_MS = 30000;
const STOP_GRACE_MS = 5000;

/**
 * Supervises the bundled AirSend Web Service: starts it, watches it, restarts
 * it when it dies, and reports in a shape the Configuration screen can show.
 */
export class AirSendService {
  constructor({
    serviceDir = process.env.DEVMEL_SERVICE_DIR || '/opt/airsend',
    dataDir = process.env.DEVMEL_DATA_DIR || '/data',
    url = SERVICE_URL,
    argument = PORT_ARGUMENT,
  } = {}) {
    this.serviceDir = serviceDir;
    this.dataDir = dataDir;
    this.url = url;
    this.argument = argument;

    /** True once the configuration asks for the embedded service. */
    this.wanted = false;
    /** True once the service answers on its port. */
    this.running = false;
    /** Why it is not running, when it is not. */
    this.error = null;
    /** Pid of the daemon, read from the lock file. */
    this.pid = null;
    /** Where the daemon runs, hence where its lock file is. */
    this.workDir = null;
    /** Set while a start is in flight, so concurrent callers share it. */
    this.starting = null;
    this.watchdog = null;
  }

  /**
   * What the Configuration screen needs to explain the local channel.
   * @returns {{ wanted: boolean, running: boolean, url: string, error: ?string }}
   */
  status() {
    return {
      wanted: this.wanted,
      running: this.running,
      url: this.url,
      error: this.error,
    };
  }

  /**
   * Start or stop the service to match a configuration. Never throws: a service
   * that will not start is reported in the connection status, and the user may
   * still point the configuration at a service of their own.
   */
  async apply(config) {
    this.wanted = config?.embeddedService === true;
    if (!this.wanted) {
      await this.stop();
      return false;
    }
    try {
      return await this.start();
    } catch (err) {
      this.error = err.message;
      logger.warn(`Could not start the embedded AirSend service: ${err.message}`);
      return false;
    }
  }

  async start() {
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async doStart() {
    this.error = null;

    // Already answering: a restarted integration finds the daemon of its
    // previous life still running (the container outlives our process on a
    // simple reconnection). Adopt it instead of starting a second one.
    if (await this.probe()) {
      this.pid = await this.readPid();
      this.running = true;
      logger.info(`AirSend Web Service already running on ${this.url}`);
      this.armWatchdog();
      return true;
    }

    const binary = await this.findBinary();
    if (!binary) {
      this.running = false;
      this.error = `No AirSend Web Service binary for this architecture (${process.arch}) in ${this.serviceDir}`;
      logger.warn(`${this.error}; fill in the URL of a service you run yourself by hand`);
      return false;
    }

    const workDir = await this.prepareWorkDir();
    await rm(join(workDir, LOCK_FILE), { force: true }).catch(() => {});
    await this.launch(binary, workDir);

    if (!(await this.waitUntilReady())) {
      this.running = false;
      this.error = `The AirSend Web Service did not answer on ${this.url}`;
      logger.error(this.error);
      return false;
    }

    this.pid = await this.readPid();
    this.running = true;
    logger.info(`AirSend Web Service started on ${this.url} (pid ${this.pid ?? 'unknown'})`);
    this.armWatchdog();
    return true;
  }

  /**
   * Run the launcher and wait for it to hand over. It forks the real server and
   * exits straight away, so this resolves in milliseconds — a launcher that
   * exits non-zero never forked anything.
   *
   * Two details follow from that fork:
   *   - the daemon inherits our stdout/stderr, which is exactly where its logs
   *     belong: the container output Gladys shows as the integration logs;
   *   - we wait for `exit`, not `close`. The daemon keeps the inherited streams
   *     open for as long as it lives, and `close` would never fire.
   */
  launch(binary, workDir) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [String(this.argument)], {
        cwd: workDir,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('error', (err) => reject(new Error(`Could not run ${binary}: ${err.message}`)));
      child.on('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${binary} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
      });
    });
  }

  async stop() {
    this.disarmWatchdog();
    const pid = this.pid ?? (await this.readPid());
    this.running = false;
    this.pid = null;
    if (!pid || !isAlive(pid)) {
      return;
    }
    logger.info(`Stopping the AirSend Web Service (pid ${pid})`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    // Released port or dead process, whichever comes first: the pid can linger
    // as a zombie until the container's init reaps it, and that is not our
    // business — having let go of 33863 is.
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && isAlive(pid) && (await this.probe())) {
      await sleep(PROBE_INTERVAL_MS);
    }
    if (isAlive(pid) && (await this.probe())) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  /** The binary shipped for the architecture we run on, or null. */
  async findBinary() {
    for (const arch of ARCHITECTURES[process.arch] ?? []) {
      const binary = join(this.serviceDir, 'bin', 'unix', arch, 'AirSendWebService');
      if (await canExecute(binary)) {
        return binary;
      }
    }
    return null;
  }

  /**
   * A writable working directory: the daemon drops its pid file where it runs,
   * and the sandbox only mounts /data read-write. A test environment (or a
   * container run without the volume) falls back to a temporary directory.
   */
  async prepareWorkDir() {
    for (const candidate of this.workDirCandidates()) {
      try {
        await mkdir(candidate, { recursive: true });
        await access(candidate, constants.W_OK);
        this.workDir = candidate;
        return candidate;
      } catch {
        logger.debug(`${candidate} is not writable, trying the next one`);
      }
    }
    throw new Error('No writable directory for the AirSend Web Service');
  }

  workDirCandidates() {
    // The one already chosen first, so that adopting a daemon started by a
    // previous run of the integration finds its lock file where it left it.
    const candidates = [this.dataDir, join(tmpdir(), 'gladys-devmel')];
    return this.workDir ? [this.workDir, ...candidates] : candidates;
  }

  async readPid() {
    for (const dir of this.workDirCandidates()) {
      try {
        const pid = Number(String(await readFile(join(dir, LOCK_FILE), 'utf8')).trim());
        if (Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      } catch {
        /* no lock file there */
      }
    }
    return null;
  }

  async waitUntilReady() {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.probe()) {
        return true;
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    return false;
  }

  /** Does something answer HTTP on our port? The service replies 401 on `/`. */
  async probe() {
    try {
      await fetch(this.url, {
        method: 'GET',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Devmel's own add-on watches the daemon and gives up when it dies; here the
   * integration outlives it, so a dead daemon is simply started again.
   */
  armWatchdog() {
    this.disarmWatchdog();
    this.watchdog = setInterval(() => {
      this.check().catch((err) => logger.error('AirSend service watchdog failed', err));
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  disarmWatchdog() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  async check() {
    if (!this.wanted || this.starting) {
      return;
    }
    if (await this.probe()) {
      this.running = true;
      this.error = null;
      return;
    }
    logger.warn('The AirSend Web Service stopped answering, restarting it');
    this.running = false;
    this.pid = null;
    await this.start().catch((err) => {
      this.error = err.message;
      logger.error(`Could not restart the AirSend Web Service: ${err.message}`);
    });
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it just is not ours to signal.
    return err.code === 'EPERM';
  }
}

async function canExecute(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
