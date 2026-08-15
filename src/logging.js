// -----------------------------------------------------------------------------
// The log level, switchable from the Configuration screen.
//
// Radio is the one part of this integration nobody can watch: a remote that
// never shows up in Gladys is either unheard, dropped as unreliable, or heard
// and undecodable, and only the debug channel tells those three apart. Until
// now reaching it meant setting `LOG_LEVEL=debug` on the container — an
// environment variable, i.e. a redeploy, i.e. exactly the thing a user
// diagnosing their installation cannot do from the Gladys UI.
//
// The SDK logger re-reads `process.env.LOG_LEVEL` on EVERY line (see its
// `createLogger`), so writing that variable is enough: it takes effect at once,
// for every logger already created, the SDK's own connection logs included. No
// restart, no logger to rebuild.
//
// The one thing to get right is the operator who already set `LOG_LEVEL` on the
// container. Their value is the baseline, captured once at startup: the switch
// raises the level to debug while it is on, and puts their value back — not
// `info` — when it goes off. A switch nobody touched changes nothing.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'logging' });

/**
 * `LOG_LEVEL` as the container was started with, read once. `undefined` means
 * the operator set nothing, and the logger's own default (info) applies.
 */
const BASELINE = process.env.LOG_LEVEL;

/**
 * Apply the log level a configuration asks for.
 *
 * @param {object} config normalized configuration (see src/config.js)
 * @returns {string} the level in force afterwards, for the caller to log or test
 */
export function applyLogLevel(config) {
  const wanted = config?.debug_logs ? 'debug' : BASELINE;
  const current = process.env.LOG_LEVEL;

  if (wanted === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = wanted;
  }

  // Said at info, so it is readable in both directions: the line that announces
  // debug has to survive the level it announces, and the line that ends it has
  // to be printed after the level dropped back.
  if (current !== process.env.LOG_LEVEL) {
    logger.info(
      config?.debug_logs
        ? 'Detailed logs turned on: every radio frame the box hears is logged'
        : `Detailed logs turned off (level: ${process.env.LOG_LEVEL ?? 'info'})`,
    );
  }
  return process.env.LOG_LEVEL ?? 'info';
}
