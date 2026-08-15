// -----------------------------------------------------------------------------
// The debug switch of the Configuration screen.
//
// The module captures `LOG_LEVEL` once, at load: a fresh import per case is how
// a test chooses what the container was started with.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

/**
 * Load `src/logging.js` as if the container had just started with that
 * `LOG_LEVEL`. The query string defeats the ESM module cache, so each case gets
 * its own baseline.
 */
let loads = 0;
async function freshLogging(baseline) {
  const previous = process.env.LOG_LEVEL;
  if (baseline === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = baseline;
  }
  loads += 1;
  const module = await import(`../src/logging.js?load=${loads}`);
  // Restore what the test runner was using; the module has its baseline now.
  if (previous === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = previous;
  }
  return module;
}

function configWith(debug) {
  return normalizeConfig({ debug_logs: debug });
}

test('the switch raises the level to debug, and lowers it back', async () => {
  const { applyLogLevel } = await freshLogging(undefined);

  assert.equal(applyLogLevel(configWith(true)), 'debug');
  assert.equal(process.env.LOG_LEVEL, 'debug');

  // Off again: the variable goes back to unset, not to a hard-coded 'info'.
  assert.equal(applyLogLevel(configWith(false)), 'info');
  assert.equal(process.env.LOG_LEVEL, undefined);
});

test('a level set on the container is the baseline the switch returns to', async () => {
  // Someone already runs the container with LOG_LEVEL=warn. Turning the switch
  // on and off again must give them their warn back, not silently promote them
  // to the logger's default.
  const { applyLogLevel } = await freshLogging('warn');

  assert.equal(applyLogLevel(configWith(true)), 'debug');
  assert.equal(applyLogLevel(configWith(false)), 'warn');
  assert.equal(process.env.LOG_LEVEL, 'warn');

  delete process.env.LOG_LEVEL;
});

test('an untouched switch changes nothing at all', async () => {
  const { applyLogLevel } = await freshLogging('debug');

  // The operator asked for debug on the container; the switch is off because
  // nobody ever opened that screen. Their choice stands.
  assert.equal(applyLogLevel(normalizeConfig()), 'debug');
  assert.equal(process.env.LOG_LEVEL, 'debug');

  delete process.env.LOG_LEVEL;
});

test('the switch reads the shapes a form sends', () => {
  // A boolean field can arrive as a string from a form, and as nothing at all
  // from a configuration saved before the field existed.
  assert.equal(normalizeConfig().debug_logs, false);
  assert.equal(normalizeConfig({ debug_logs: true }).debug_logs, true);
  assert.equal(normalizeConfig({ debug_logs: 'true' }).debug_logs, true);
  assert.equal(normalizeConfig({ debug_logs: 'false' }).debug_logs, false);
  assert.equal(normalizeConfig({ debug_logs: '' }).debug_logs, false);
});
