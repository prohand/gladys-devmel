// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action is registered in index.js', () => {
  for (const action of manifest.actions ?? []) {
    assert.match(
      indexSource,
      new RegExp(`onAction\\('${action.key}'`),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('every manifest webhook is handled in index.js', () => {
  for (const webhook of manifest.webhooks ?? []) {
    assert.match(
      indexSource,
      new RegExp(`onWebhook\\('${webhook.key}'`),
      `manifest webhook "${webhook.key}" has no handler`,
    );
  }
});

// The store schema is the admission authority: a field type outside this list,
// or a placeholder that is not a multi-language object, gets the integration
// rejected by the indexer.
const FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'select',
  'multi_select',
  'secret',
  'oauth2',
  'section',
];

test('every field uses a type the store accepts', () => {
  const allFields = [
    ...manifest.config_schema,
    ...(manifest.actions ?? []).flatMap((a) => a.fields ?? []),
  ];
  for (const field of allFields) {
    assert.ok(
      FIELD_TYPES.includes(field.type),
      `field "${field.key}": unknown type "${field.type}"`,
    );
    assert.match(field.key, /^[a-z0-9_]+$/, `field key "${field.key}" must be snake_case`);
    if (field.placeholder !== undefined) {
      // Placeholders are multi-language objects, and only string/number/secret
      // fields may carry one.
      assert.equal(typeof field.placeholder, 'object', `field "${field.key}": placeholder object`);
      assert.ok(field.placeholder.en, `field "${field.key}": placeholder needs English`);
      assert.ok(
        ['string', 'number', 'secret'].includes(field.type),
        `field "${field.key}": a ${field.type} field cannot have a placeholder`,
      );
    }
    if (field.min !== undefined || field.max !== undefined) {
      assert.equal(field.type, 'number', `field "${field.key}": min/max are number-only`);
    }
  }
});

test('the listening channel can actually be left empty', () => {
  // A number field in the Gladys form cannot be cleared: it makes the user type
  // something, and whatever they type then reads as a choice they never made —
  // "1", typically, which the description used to call generic 433 MHz
  // listening while the code read it as "deduce it". A text field can be empty,
  // and empty is exactly what "deduce it from my devices" is.
  const field = manifest.config_schema.find((entry) => entry.key === 'listen_channel');

  assert.equal(field.type, 'string');
  assert.equal(field.required, false);
  assert.equal(field.min, undefined);
  assert.equal(normalizeConfig({ listen_channel: '' }).listen_channel, null);
  assert.equal(normalizeConfig({ listen_channel: '1' }).listen_channel, null);
  assert.equal(normalizeConfig({ listen_channel: '14177' }).listen_channel, 14177);
  assert.equal(normalizeConfig({ listen_channel: '0' }).listen_channel, 0);
});

test('the description fits what the store allows', () => {
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language} must be 10-100 characters, got ${text.length}`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every stored config key is known by the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config key "${field.key}" is missing in DEFAULT_CONFIG`,
    );
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const allFields = [
    ...manifest.config_schema,
    ...(manifest.actions ?? []).flatMap((a) => a.fields ?? []),
  ];
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0, 'the identify action targets a device');
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices', 'the only core-defined source in V1 is "devices"');
    assert.equal(
      field.options,
      undefined,
      `field "${field.key}": declaring source and options together rejects the manifest`,
    );
  }
});

// The vocabulary the store accepts. An unknown one is not an error the
// indexer raises: it is dropped, and the integration quietly stops appearing
// under the category it meant to be in.
const CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
];

test('the categories stay inside the vocabulary the store indexes', () => {
  const { categories } = manifest;
  assert.ok(Array.isArray(categories), 'categories must be a list');
  assert.ok(
    categories.length >= 1 && categories.length <= 3,
    `1 to 3 categories, got ${categories.length}`,
  );
  assert.equal(new Set(categories).size, categories.length, 'categories must be unique');
  for (const category of categories) {
    assert.ok(CATEGORIES.includes(category), `unknown category "${category}"`);
  }
  // Older cores reject a manifest field they do not know: declaring
  // `categories` is what makes 4.86 the floor.
  assert.match(manifest.gladys_version, /^>=4\.(8[6-9]|9\d|\d{3,})/);
});

test('the manifest declares the local transport and a label in both languages', () => {
  assert.deepEqual(manifest.transports, ['local']);
  for (const field of [...manifest.config_schema, ...(manifest.actions ?? [])]) {
    assert.ok(field.label?.en && field.label?.fr, `field "${field.key}" needs en/fr labels`);
  }
});
