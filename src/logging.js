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
//
// The clock of those lines is the other half. The SDK logger stamps every line
// with `toISOString()`, i.e. UTC, while the dashboard widget shows the time of
// the user's browser: two hours apart in a French summer, and "the frame at
// 14:02 on the widget" nowhere to be found at 14:02 in the logs. So the lines
// are written here, by a logger with the same interface, the same levels and
// the same `[time] [LEVEL] [name]` prefix, stamped in the time zone the
// Configuration screen names — the SDK's own connection logs included, through
// the `logger` option of `GladysIntegration`.
// -----------------------------------------------------------------------------

/** The SDK's levels, which it does not export. */
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };

/** The time zone of the log lines when the configuration names none. */
export const DEFAULT_TIME_ZONE = 'Europe/Paris';

let timeZone = DEFAULT_TIME_ZONE;
const formatters = new Map();

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

/**
 * Apply the time zone a configuration asks for. An empty field means the
 * container's own `TZ`, and UTC without it; a name the runtime does not know is
 * said once and replaced by UTC, rather than stamping lines with a zone that
 * silently is not the one asked for.
 *
 * @param {object} config normalized configuration
 * @returns {string} the time zone in force afterwards
 */
export function applyLogTimeZone(config) {
  const wanted = String(config?.log_timezone ?? '').trim() || process.env.TZ || 'UTC';
  const previous = timeZone;
  if (formatterFor(wanted)) {
    timeZone = wanted;
  } else {
    timeZone = 'UTC';
    logger.warn(`Unknown time zone "${wanted}" for the logs: UTC is used instead`);
  }
  if (previous !== timeZone) {
    logger.info(`Log times are now in ${timeZone}`);
  }
  return timeZone;
}

/**
 * A timestamp in the given zone, ISO 8601 with its offset:
 * `2026-09-28T14:02:05.123+02:00` — the hour the widget shows, and still one
 * that says unambiguously which instant it is.
 *
 * @param {Date|number} date
 * @param {string} [zone]
 * @returns {string}
 */
export function formatLogTime(date = new Date(), zone = timeZone) {
  const moment = date instanceof Date ? date : new Date(date);
  const formatter = formatterFor(zone);
  if (!formatter || Number.isNaN(moment.getTime())) {
    return moment.toISOString?.() ?? String(date);
  }
  const part = Object.fromEntries(formatter.formatToParts(moment).map((p) => [p.type, p.value]));
  // `longOffset` spells UTC itself as a bare "GMT".
  const offset = part.timeZoneName.replace(/^GMT/, '') || '+00:00';
  return (
    `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}` +
    `.${part.fractionalSecond}${offset}`
  );
}

function formatterFor(zone) {
  if (!formatters.has(zone)) {
    let formatter = null;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hourCycle: 'h23',
        timeZoneName: 'longOffset',
      });
    } catch {
      // RangeError: a zone the runtime does not know.
    }
    formatters.set(zone, formatter);
  }
  return formatters.get(zone);
}

/**
 * The SDK logger, stamped in local time. Same interface (debug/info/warn/error/
 * child), same streams (debug/info on stdout, warn/error on stderr), and the
 * level re-read from `LOG_LEVEL` on every line, which is what lets
 * `applyLogLevel` work without rebuilding anything.
 *
 * @param {object} [options]
 * @param {string} [options.name] prefix added to every line
 */
export function createLogger(options = {}) {
  const { name } = options;
  const threshold = () =>
    LOG_LEVELS[String(process.env.LOG_LEVEL ?? '').toLowerCase()] || LOG_LEVELS.info;
  const line = (level, args) => {
    if (LOG_LEVELS[level] < threshold()) {
      return;
    }
    const prefix = `[${formatLogTime()}] [${level.toUpperCase()}]${name ? ` [${name}]` : ''}`;
    const stream = level === 'warn' || level === 'error' ? console.error : console.log;
    stream(prefix, ...args);
  };
  return {
    debug: (...args) => line('debug', args),
    info: (...args) => line('info', args),
    warn: (...args) => line('warn', args),
    error: (...args) => line('error', args),
    child: (childName) =>
      createLogger({ ...options, name: name ? `${name}:${childName}` : childName }),
  };
}
