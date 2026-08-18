// -----------------------------------------------------------------------------
// AirSend "notes" protocol.
//
// Everything an AirSend box exchanges over the air is a list of *notes*, each
// one a `{ method, type, value }` triplet. This module is the single place that
// knows how those triplets are spelled, so the device modules can stay readable
// (`STATE_VALUES.UP` instead of `35`).
//
// The protocol is the one implemented by the AirSend Web Service and used by
// the official Home Assistant component and Jeedom plugin:
//   - a command is a note with `method: 1` (SET);
//   - a read is a note with `method: 'QUERY'` and a symbolic type;
//   - what comes back (inline when `wait: true`, or pushed to the bind
//     callback) is a list of notes to decode.
// -----------------------------------------------------------------------------

/** `method` field of a note. */
export const NOTE_METHODS = {
  /** Write: send the value over the air. */
  SET: 1,
  /** Read: ask the device (or the box itself) for a value. */
  QUERY: 'QUERY',
};

/** `type` field of a note. */
export const NOTE_TYPES = {
  STATE: 0,
  DATA: 1,
  TEMPERATURE: 2,
  ILLUMINANCE: 3,
  R_HUMIDITY: 4,
  LEVEL: 9,
};

/** Symbolic `type` accepted by a QUERY note. */
export const QUERY_TYPES = {
  STATE: 'STATE',
  TEMPERATURE: 'TEMPERATURE',
  ILLUMINANCE: 'ILLUMINANCE',
};

/**
 * Values of a STATE note. The AirSend Web Service accepts both the label and
 * the number; incoming notes may use either, hence the two-way table below.
 */
export const STATE_VALUES = {
  PING: 1,
  PROG: 2,
  UNPROG: 3,
  RESET: 4,
  STOP: 17,
  TOGGLE: 18,
  OFF: 19,
  ON: 20,
  CLOSE: 21,
  OPEN: 22,
  MIDDLE: 33,
  DOWN: 34,
  UP: 35,
  LEFT: 36,
  RIGHT: 37,
  USERPOSITION: 38,
};

const STATE_LABELS = Object.fromEntries(
  Object.entries(STATE_VALUES).map(([label, value]) => [value, label]),
);

/** Decoded note kinds returned by {@link decodeNotes}. */
export const READINGS = {
  STATE: 'state',
  TOGGLE: 'toggle',
  LEVEL: 'level',
  TEMPERATURE: 'temperature',
  ILLUMINANCE: 'illuminance',
  HUMIDITY: 'humidity',
  DATA: 'data',
};

/**
 * Movement orders, carried by the `command` field of a decoded reading.
 *
 * The distinction matters for anything that moves over time: a shutter that
 * hears UP is *starting to open*, it is not at 100 %. The level such an order
 * decodes to is where the device will end up, not where it is — only a reading
 * with no `command` is a position the hardware actually reported.
 */
export const COMMANDS = {
  UP: 'up',
  DOWN: 'down',
  STOP: 'stop',
  /** The position the device was programmed with (Somfy "my", MIDDLE, USERPOSITION). */
  FAVORITE: 'favorite',
};

/** Build a `{ method: SET, type: STATE, value }` note. */
export function stateNote(value) {
  return { method: NOTE_METHODS.SET, type: NOTE_TYPES.STATE, value };
}

/** Build a `{ method: SET, type: LEVEL, value }` note (0-100 %). */
export function levelNote(level) {
  return { method: NOTE_METHODS.SET, type: NOTE_TYPES.LEVEL, value: clampLevel(level) };
}

/**
 * States that mean the same thing however often they are heard.
 *
 * This is the whole difference between an order that may be repeated on the air
 * and one that may not. "Go up" heard twice is still "go up"; TOGGLE heard
 * twice is back where it started, and PROG heard twice is a pairing undone. A
 * lossy one-way radio is a good reason to say things twice, never a good enough
 * one to say them wrong.
 */
const REPEATABLE_STATES = new Set([
  STATE_VALUES.STOP,
  STATE_VALUES.OFF,
  STATE_VALUES.ON,
  STATE_VALUES.CLOSE,
  STATE_VALUES.OPEN,
  STATE_VALUES.MIDDLE,
  STATE_VALUES.DOWN,
  STATE_VALUES.UP,
  STATE_VALUES.LEFT,
  STATE_VALUES.RIGHT,
  STATE_VALUES.USERPOSITION,
]);

/** Can this whole order be sent again without meaning something else? */
export function isRepeatable(notes) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return false;
  }
  return notes.every(isRepeatableNote);
}

function isRepeatableNote(note) {
  if (!note || typeof note !== 'object' || note.method !== NOTE_METHODS.SET) {
    return false;
  }
  const type = typeof note.type === 'string' ? NOTE_TYPES[note.type.toUpperCase()] : note.type;
  if (type === NOTE_TYPES.LEVEL) {
    // A percentage is where to go, not how far to move: saying it again is
    // saying the same thing.
    return true;
  }
  if (type !== NOTE_TYPES.STATE) {
    return false;
  }
  const value =
    typeof note.value === 'string' ? STATE_VALUES[note.value.toUpperCase()] : Number(note.value);
  return REPEATABLE_STATES.has(value);
}

/** Build a `{ method: QUERY, type }` note. */
export function queryNote(type) {
  return { method: NOTE_METHODS.QUERY, type };
}

/** Clamp a percentage to the 0-100 range the radio protocol expects. */
export function clampLevel(level) {
  return Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
}

/**
 * Decode the notes carried by an AirSend event into plain readings.
 *
 * Mirrors the conversion the official Home Assistant add-on does, notably:
 *   - ON/OFF and UP/DOWN are reported as a 0/100 level, because that is where
 *     the hardware ends up;
 *   - temperatures come in Kelvin and are converted to Celsius.
 *
 * A movement order additionally carries `command` (see {@link COMMANDS}): the
 * level of an UP is a destination, and a reader that cares about the journey —
 * a shutter — must not mistake it for a measured position.
 *
 * @param {Array<{type: number|string, value: unknown}>} notes
 * @returns {Array<{ kind: string, value: number|string, command?: string }>}
 */
export function decodeNotes(notes) {
  if (!Array.isArray(notes)) {
    return [];
  }
  const readings = [];
  for (const note of notes) {
    const reading = decodeNote(note);
    if (reading) {
      readings.push(reading);
    }
  }
  return readings;
}

function decodeNote(note) {
  if (!note || typeof note !== 'object') {
    return null;
  }
  const type = typeof note.type === 'string' ? NOTE_TYPES[note.type.toUpperCase()] : note.type;
  const raw = note.value;

  switch (type) {
    case NOTE_TYPES.STATE:
      return decodeStateNote(raw);
    case NOTE_TYPES.DATA:
      return { kind: READINGS.DATA, value: String(raw) };
    case NOTE_TYPES.TEMPERATURE:
      // The radio reports Kelvin, tenth of a degree precision.
      return {
        kind: READINGS.TEMPERATURE,
        value: Math.round((Number(raw) - 273.15) * 10) / 10,
      };
    case NOTE_TYPES.ILLUMINANCE:
      return { kind: READINGS.ILLUMINANCE, value: Math.round(Number(raw)) };
    case NOTE_TYPES.R_HUMIDITY:
      return { kind: READINGS.HUMIDITY, value: Math.round(Number(raw)) };
    case NOTE_TYPES.LEVEL:
      return { kind: READINGS.LEVEL, value: clampLevel(raw) };
    default:
      return null;
  }
}

function decodeStateNote(raw) {
  const value = typeof raw === 'string' ? STATE_VALUES[raw.toUpperCase()] : Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  switch (value) {
    case STATE_VALUES.TOGGLE:
      return { kind: READINGS.TOGGLE, value: STATE_LABELS[value] };
    case STATE_VALUES.OFF:
      return { kind: READINGS.LEVEL, value: 0 };
    case STATE_VALUES.ON:
      return { kind: READINGS.LEVEL, value: 100 };
    case STATE_VALUES.DOWN:
    case STATE_VALUES.CLOSE:
      return { kind: READINGS.LEVEL, value: 0, command: COMMANDS.DOWN };
    case STATE_VALUES.UP:
    case STATE_VALUES.OPEN:
      return { kind: READINGS.LEVEL, value: 100, command: COMMANDS.UP };
    case STATE_VALUES.STOP:
      return { kind: READINGS.STATE, value: 'stop', command: COMMANDS.STOP };
    case STATE_VALUES.MIDDLE:
    case STATE_VALUES.USERPOSITION:
      return { kind: READINGS.STATE, value: 'user', command: COMMANDS.FAVORITE };
    default:
      return { kind: READINGS.STATE, value: STATE_LABELS[value] ?? String(value) };
  }
}

/**
 * Spell out what a frame said, for a human reading a log line or the answer of
 * a manifest action: `level 100 (up), state stop`.
 *
 * Worth a function of its own because it is shown exactly where the user is
 * stuck — a remote heard but understood by nobody. What it decoded to is the
 * difference between "the wrong device is declared" and "this protocol carries
 * no order Gladys can replay".
 */
export function describeReadings(readings) {
  if (!Array.isArray(readings) || readings.length === 0) {
    return '';
  }
  return readings
    .map((reading) => {
      const value = `${reading.kind} ${reading.value}`;
      return reading.command ? `${value} (${reading.command})` : value;
    })
    .join(', ');
}

/**
 * Two AirSend channels designate the same physical remote when their id AND
 * source match — the other fields (mac, seed, counter) vary from frame to
 * frame. Used to route an incoming radio event to the right Gladys device.
 */
export function isSameChannel(a, b) {
  if (!a || !b) {
    return false;
  }
  return String(a.id) === String(b.id) && String(a.source ?? '') === String(b.source ?? '');
}
