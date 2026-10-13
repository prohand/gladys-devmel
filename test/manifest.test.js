// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { REMOTE_ORDERS, SCENE_ACTIONS, SCENE_TRIGGERS } from '../src/capabilities/scenes.js';
import { RADIO_WIDGET } from '../src/capabilities/widget.js';
import { LANGUAGES } from '../src/i18n.js';

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
    ...(manifest.widgets ?? []).flatMap((w) => w.settings ?? []),
    ...(manifest.scene_triggers ?? []).flatMap((t) => t.fields ?? []),
    ...(manifest.scene_actions ?? []).flatMap((a) => a.fields ?? []),
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

test('advice to put a pid in the listening channel names "generic" for pid 1', async () => {
  // Typed as is, 1 reads as "deduce" (above) and changes nothing; the code's
  // own log lines ask for the word generic (`channelToType`). A text telling
  // the user to type the frame's pid without that exception sent whoever had
  // a pid-1 frame to a setting that does nothing.
  const field = manifest.config_schema.find((entry) => entry.key === 'accept_unreliable');
  assert.match(field.description.en, /its pid, or to the word generic for pid 1/);
  assert.match(field.description.fr, /son pid .*, ou le mot générique pour le pid 1/);
  assert.match(field.description.de, /seine pid .*das Wort generisch für pid 1/);
  assert.match(field.description.es, /su pid, .*la palabra genérico para el pid 1/);
  const docs = {
    en: [/put that `pid`/g, /generic/],
    fr: [/mettez ce `pid`|renseignez ce\s+`pid`/g, /générique/],
    de: [/[Tt]rage diese\s+`pid`/g, /generisch/],
    es: [/ponga ese\s+`pid`/g, /genérico/],
  };
  for (const [language, [advice, generic]] of Object.entries(docs)) {
    const text = await readFile(new URL(`../docs/${language}.md`, import.meta.url), 'utf8');
    const found = [...text.matchAll(advice)];
    assert.ok(found.length >= 2, `docs/${language}.md: advice not found`);
    for (const match of found) {
      // The exception sits in the same sentence or table cell, right after.
      const after = text.slice(match.index, match.index + 140);
      assert.match(after, generic, `docs/${language}.md: "${match[0]}" without generic`);
    }
  }
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
});

test('the Gladys floor covers every field the manifest declares', () => {
  // Older cores reject a manifest field they do not know: `categories` needs
  // 4.86, and the widgets and scene declarations need 5.1.
  const [major, minor] = manifest.gladys_version.replace(/^>=/, '').split('.').map(Number);
  assert.ok(major > 5 || (major === 5 && minor >= 1), `got ${manifest.gladys_version}`);
});

test('every widget and scene action is handled in index.js', () => {
  for (const widget of manifest.widgets ?? []) {
    assert.match(indexSource, /onWidgetGet\(RADIO_WIDGET/, `widget "${widget.key}"`);
    assert.equal(widget.key, RADIO_WIDGET);
  }
  const actions = Object.values(SCENE_ACTIONS);
  assert.deepEqual(
    (manifest.scene_actions ?? []).map((action) => action.key).sort(),
    [...actions].sort(),
  );
  for (const key of Object.keys(SCENE_ACTIONS)) {
    assert.match(indexSource, new RegExp(`onSceneAction\\(SCENE_ACTIONS\\.${key}`));
  }
});

test('the scene triggers the code fires are the ones the manifest declares', () => {
  assert.deepEqual(
    (manifest.scene_triggers ?? []).map((trigger) => trigger.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  const orders = manifest.scene_triggers
    .find((trigger) => trigger.key === SCENE_TRIGGERS.REMOTE_PRESSED)
    .fields.find((field) => field.key === 'order')
    .options.map((option) => option.value);
  assert.deepEqual(orders.sort(), Object.values(REMOTE_ORDERS).sort());
});

test('the manifest declares the local transport and a label in every language', () => {
  assert.deepEqual(manifest.transports, ['local']);
  for (const field of [...manifest.config_schema, ...(manifest.actions ?? [])]) {
    for (const language of LANGUAGES) {
      assert.ok(field.label?.[language], `field "${field.key}" needs a ${language} label`);
    }
  }
});

/** Every multi-language object of the manifest, with where it sits. */
function multiLanguageTexts(node, path = 'manifest') {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => multiLanguageTexts(child, `${path}[${index}]`));
  }
  if (node === null || typeof node !== 'object') {
    return [];
  }
  const keys = Object.keys(node);
  if (keys.includes('en') && keys.every((key) => /^[a-z]{2}$/.test(key))) {
    return [{ path, text: node }];
  }
  return keys.flatMap((key) => multiLanguageTexts(node[key], `${path}.${key}`));
}

test('every multi-language text of the manifest carries en, fr, de and es', () => {
  // Gladys shows the reader's language and falls back to English: a text
  // missing one of them shows up in English in the middle of a translated
  // screen. The store accepts any two-letter key, so nothing else catches it.
  const texts = multiLanguageTexts(manifest);
  assert.ok(texts.length > 50, `only ${texts.length} texts found`);
  for (const { path, text } of texts) {
    assert.deepEqual(Object.keys(text).sort(), [...LANGUAGES].sort(), `${path}: languages`);
    for (const language of LANGUAGES) {
      assert.equal(typeof text[language], 'string', `${path}.${language}`);
      assert.ok(text[language].trim().length > 0, `${path}.${language} is empty`);
    }
  }
});

test('the per-language length limits of the store hold in every language', () => {
  const within = (text, min, max, where) => {
    for (const language of LANGUAGES) {
      const { length } = text[language];
      assert.ok(length >= min && length <= max, `${where}.${language}: ${length} characters`);
    }
  };
  within(manifest.description, 10, 100, 'description');
  for (const widget of manifest.widgets ?? []) {
    within(widget.label, 3, 30, `widget ${widget.key} label`);
    within(widget.description, 1, 100, `widget ${widget.key} description`);
  }
  const sections = [
    ...manifest.config_schema,
    ...(manifest.actions ?? []).flatMap((action) => action.fields ?? []),
  ].filter((field) => field.type === 'section');
  for (const section of sections) {
    if (section.description) {
      within(section.description, 1, 1000, `section ${section.key} description`);
    }
  }
});
