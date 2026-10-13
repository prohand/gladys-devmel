// -----------------------------------------------------------------------------
// The languages every user-facing text is written in.
//
// Gladys renders a multi-language object in the reader's own language and
// falls back to English for any other one. Every message this integration
// returns — action answers, connection status, widget texts — is such an
// object, with one key per language below. The reports are long sentences
// built from parts that each depend on the language, so they are written once
// per language through `localize`, and the parts choose their wording with
// `pick`.
// -----------------------------------------------------------------------------

/** The languages of the Gladys interface, English first: it is the fallback. */
export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * The text of one language, English when the object has none for it.
 *
 * @param {string} language a key of {@link LANGUAGES}, or anything else
 * @param {Record<string, string>} texts one text per language, `en` included
 * @returns {string}
 */
export function pick(language, texts) {
  return texts[language] ?? texts.en;
}

/**
 * One multi-language object, built by calling `build` once per language.
 *
 * @param {(language: string) => string} build the text in one language
 * @returns {Record<string, string>} `{ en, fr, de, es }`
 */
export function localize(build) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, build(language)]));
}
