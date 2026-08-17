// -----------------------------------------------------------------------------
// The protocols the AirSend Web Service knows, as a user can read them.
//
// "Listen to 868 MHz" is not a thing a box can be asked: it listens to a
// PROTOCOL, and a protocol happens to live on a band. So the only way to hear
// an 868 MHz remote is to name its protocol — its `pid` — and until now the
// only place a pid could be read was the airsend.cloud export of a device
// already paired, or a log line about a frame that was already coming through.
// For everything else the field was a number to guess.
//
// The service knows them all: `GET /channels/` answers a couple of hundred
// entries, each with its name and the channel that decodes it. That is the list
// Devmel's own plugins turn into their "permanent listening" menu, and this
// module turns it into an answer to "which pid do I put in that field?".
//
// It also says how each one is decoded, because that is what decides whether
// listening to it is worth anything (see listening.js):
//
//   getDecoder === id    it decodes itself       -> listen to it
//   getDecoder === 1     part of generic 433 MHz -> listening to 1 covers it
//   getDecoder === 0     only partially decoded  -> frames arrive, orders do not
// -----------------------------------------------------------------------------

import { GENERIC_433_CHANNEL } from '../config.js';

/** How many protocols a search spells out before it counts the rest. */
export const SHOWN = 12;

/**
 * The protocols matching what the user typed: a name, a fragment of one, or a
 * pid. Accents and case are ignored — nobody types "Télécommande" the same way
 * twice, and a protocol list is not a place to be strict about it.
 *
 * @param {Iterable<object>} channels entries of `GET /channels/`
 * @param {string} search what the user typed, empty for everything
 * @returns {Array<object>} matches, by pid
 */
export function matchProtocols(channels, search) {
  const wanted = normalize(search);
  const matches = [];
  for (const channel of channels ?? []) {
    const id = Number(channel?.id);
    if (!Number.isFinite(id)) {
      continue;
    }
    if (!wanted || String(id) === wanted || normalize(channel?.name).includes(wanted)) {
      matches.push(channel);
    }
  }
  return matches.sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Handler of the `find_protocol` manifest action.
 *
 * @param {object} options
 * @param {Map<number, object>} options.table the channel table, as index.js
 *   caches it — empty when the service could not be asked
 * @param {object} options.config normalized configuration
 * @param {?object} [options.plan] what listening decided (see listening.js)
 * @param {string} [options.search] the field the user filled
 * @returns {{en: string, fr: string}}
 */
export function findProtocol({ table, config, plan = null, search = '' }) {
  const channels = [...(table?.values?.() ?? [])];
  if (channels.length === 0) {
    return {
      en:
        'The AirSend service did not answer with its protocol list. Run "Test the connection" ' +
        'first: nothing can be looked up while the service is unreachable.',
      fr:
        "Le service AirSend n'a pas répondu la liste de ses protocoles. Lancez d'abord " +
        '« Tester la connexion » : rien ne peut être cherché tant que le service est injoignable.',
    };
  }

  const matches = matchProtocols(channels, search);
  const typed = String(search ?? '').trim();
  if (matches.length === 0) {
    return {
      en:
        `No protocol of the ${channels.length} the service knows matches "${typed}". Search by ` +
        'brand (somfy, nice, faac, bubendorff), or by the pid printed in the AirSend app.',
      fr:
        `Aucun des ${channels.length} protocoles connus du service ne correspond à « ${typed} ». ` +
        "Cherchez par marque (somfy, nice, faac, bubendorff), ou par le pid affiché dans l'appli " +
        'AirSend.',
    };
  }

  const listed = matches.slice(0, SHOWN);
  const more = matches.length - listed.length;
  return {
    en: [
      heading(matches.length, channels.length, typed, 'en'),
      ...listed.map((channel) => describeProtocol(channel, config, plan, 'en')),
      ...(more > 0 ? [`(+${more} more — narrow the search down.)`] : []),
      footer('en'),
    ].join('\n'),
    fr: [
      heading(matches.length, channels.length, typed, 'fr'),
      ...listed.map((channel) => describeProtocol(channel, config, plan, 'fr')),
      ...(more > 0 ? [`(+${more} autres — affinez la recherche.)`] : []),
      footer('fr'),
    ].join('\n'),
  };
}

function heading(found, known, typed, language) {
  if (!typed) {
    return language === 'fr'
      ? `${known} protocoles connus du service AirSend. Tapez une marque ou un pid pour ` +
          'chercher ; en voici les premiers :'
      : `${known} protocols known by the AirSend service. Type a brand or a pid to search; ` +
          'here are the first ones:';
  }
  const plural = found > 1;
  return language === 'fr'
    ? `${found} protocole${plural ? 's' : ''} pour « ${typed} » :`
    : `${found} protocol${plural ? 's' : ''} for "${typed}":`;
}

/** One protocol: its pid, its name, how it is decoded, and who already uses it. */
function describeProtocol(channel, config, plan, language) {
  const id = Number(channel.id);
  const name = channel.name ? `${channel.name}` : language === 'fr' ? 'sans nom' : 'unnamed';
  const parts = [decoding(channel, language)];

  if (plan?.enabled && Number(plan.channel) === id) {
    parts.push(language === 'fr' ? 'écouté actuellement' : 'listened to right now');
  }
  const users = devicesOn(config, id);
  if (users.length > 0) {
    parts.push(
      language === 'fr' ? `déclaré sur ${users.join(', ')}` : `declared on ${users.join(', ')}`,
    );
  }
  return `- pid ${id} — ${name} (${parts.join(', ')})`;
}

/**
 * How the service decodes a protocol — the part that decides whether listening
 * to it brings anything back.
 */
function decoding(channel, language) {
  const id = Number(channel.id);
  const decoder = Number(channel.getDecoder);

  if (decoder === GENERIC_433_CHANNEL && id !== GENERIC_433_CHANNEL) {
    return language === 'fr'
      ? 'décodé par le canal 1, générique 433 MHz'
      : 'decoded by channel 1, generic 433 MHz';
  }
  if (!Number.isFinite(decoder) || decoder <= 0) {
    return language === 'fr'
      ? 'seulement partiellement décodé : ses trames arrivent, sans ordre rejouable'
      : 'only partially decoded: its frames arrive, with no order to replay';
  }
  if (decoder !== id) {
    return language === 'fr' ? `décodé par le canal ${decoder}` : `decoded by channel ${decoder}`;
  }
  return language === 'fr' ? 'décodé par lui-même' : 'decodes itself';
}

/** The declared devices that speak a protocol, by their own channel or a remote. */
function devicesOn(config, id) {
  const names = [];
  for (const device of config.devmelDevices ?? []) {
    const channels = [device.channel, ...(device.remotes ?? [])];
    if (channels.some((channel) => Number(channel?.id) === id)) {
      names.push(`"${device.name}"`);
    }
  }
  return names;
}

function footer(language) {
  return language === 'fr'
    ? 'Mettez le pid voulu dans le champ Canal d’écoute pour écouter ce protocole — le boîtier ' +
        "n'en écoute qu'un à la fois. Videz le champ pour revenir à la déduction à partir de vos " +
        'appareils.'
    : 'Put the pid you want in the Listening channel field to listen to that protocol — the box ' +
        'listens to one at a time. Empty the field to go back to deducing it from your devices.';
}

/** Lowercase, accent-free, trimmed: how a search is compared. */
function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}
