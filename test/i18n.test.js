// -----------------------------------------------------------------------------
// The language helpers every user-facing message goes through.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, localize, pick } from '../src/i18n.js';

test('the languages are the ones of the Gladys interface, English first', () => {
  assert.deepEqual(LANGUAGES, ['en', 'fr', 'de', 'es']);
});

test('pick falls back to English for a language it has no text for', () => {
  const texts = { en: 'Stop', fr: 'Stop', de: 'Stopp', es: 'Parar' };
  assert.equal(pick('de', texts), 'Stopp');
  assert.equal(pick('es', texts), 'Parar');
  assert.equal(pick('it', texts), 'Stop');
  assert.equal(pick(undefined, { en: 'only English' }), 'only English');
});

test('localize builds one text per language', () => {
  assert.deepEqual(
    localize((language) => `[${language}]`),
    { en: '[en]', fr: '[fr]', de: '[de]', es: '[es]' },
  );
});
