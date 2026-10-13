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

import { DEVICE_TYPES, GENERIC_433_CHANNEL } from '../config.js';
import { localize, pick } from '../i18n.js';

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
 * @returns {{en: string, fr: string, de: string, es: string}}
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
      de:
        'Der AirSend-Dienst hat seine Protokollliste nicht geliefert. Führe zuerst ' +
        '„Verbindung testen“ aus: Solange der Dienst nicht erreichbar ist, kann nichts gesucht ' +
        'werden.',
      es:
        'El servicio AirSend no ha devuelto su lista de protocolos. Ejecute primero «Probar la ' +
        'conexión»: no se puede buscar nada mientras el servicio sea inaccesible.',
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
      de:
        `Keines der ${channels.length} Protokolle, die der Dienst kennt, passt zu „${typed}“. ` +
        'Suche nach Marke (somfy, nice, faac, bubendorff) oder nach der pid, die die ' +
        'AirSend-App anzeigt.',
      es:
        `Ninguno de los ${channels.length} protocolos que conoce el servicio coincide con ` +
        `«${typed}». Busque por marca (somfy, nice, faac, bubendorff) o por el pid que muestra ` +
        'la app AirSend.',
    };
  }

  const listed = matches.slice(0, SHOWN);
  const more = matches.length - listed.length;
  return localize((language) =>
    [
      heading(matches.length, channels.length, typed, language),
      ...listed.map((channel) => describeProtocol(channel, config, plan, language)),
      ...(more > 0
        ? [
            pick(language, {
              en: `(+${more} more — narrow the search down.)`,
              fr: `(+${more} autres — affinez la recherche.)`,
              de: `(+${more} weitere — grenze die Suche ein.)`,
              es: `(+${more} más — afine la búsqueda.)`,
            }),
          ]
        : []),
      footer(language),
    ].join('\n'),
  );
}

function heading(found, known, typed, language) {
  if (!typed) {
    return pick(language, {
      en:
        `${known} protocols known by the AirSend service. Type a brand or a pid to search; ` +
        'here are the first ones:',
      fr:
        `${known} protocoles connus du service AirSend. Tapez une marque ou un pid pour ` +
        'chercher ; en voici les premiers :',
      de:
        `Der AirSend-Dienst kennt ${known} Protokolle. Gib eine Marke oder eine pid ` +
        'ein, um zu suchen; hier die ersten:',
      es:
        `${known} protocolos conocidos por el servicio AirSend. Escriba una marca o un pid ` +
        'para buscar; estos son los primeros:',
    });
  }
  const plural = found > 1;
  return pick(language, {
    en: `${found} protocol${plural ? 's' : ''} for "${typed}":`,
    fr: `${found} protocole${plural ? 's' : ''} pour « ${typed} » :`,
    de: `${found} Protokoll${plural ? 'e' : ''} für „${typed}“:`,
    es: `${found} protocolo${plural ? 's' : ''} para «${typed}»:`,
  });
}

/** One protocol: its pid, its name, how it is decoded, and who already uses it. */
function describeProtocol(channel, config, plan, language) {
  const id = Number(channel.id);
  const name = channel.name
    ? `${channel.name}`
    : pick(language, { en: 'unnamed', fr: 'sans nom', de: 'ohne Namen', es: 'sin nombre' });
  const parts = [decoding(channel, language)];

  if (plan?.enabled && Number(plan.channel) === id) {
    parts.push(
      pick(language, {
        en: 'listened to right now',
        fr: 'écouté actuellement',
        de: 'wird gerade empfangen',
        es: 'escuchado ahora mismo',
      }),
    );
  }
  const users = devicesOn(config, id);
  if (users.length > 0) {
    const listed = users.join(', ');
    parts.push(
      pick(language, {
        en: `declared on ${listed}`,
        fr: `déclaré sur ${listed}`,
        de: `angegeben bei ${listed}`,
        es: `declarado en ${listed}`,
      }),
    );
  }
  // The one protocol whose pid does not select it: `1` in that field has always
  // meant "deduce it", so the generic decoder is asked for by name instead.
  if (id === GENERIC_433_CHANNEL) {
    parts.push(
      pick(language, {
        en: 'ask for it by typing "generic", not 1',
        fr: 'à demander en tapant « générique », pas 1',
        de: 'durch Eingabe von „generisch“ anzufordern, nicht 1',
        es: 'se pide escribiendo «genérico», no 1',
      }),
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
    return pick(language, {
      en: 'decoded by channel 1, generic 433 MHz',
      fr: 'décodé par le canal 1, générique 433 MHz',
      de: 'dekodiert von Kanal 1, generisch 433 MHz',
      es: 'decodificado por el canal 1, genérico 433 MHz',
    });
  }
  if (!Number.isFinite(decoder) || decoder <= 0) {
    return pick(language, {
      en: 'only partially decoded: its frames arrive, with no order to replay',
      fr: 'seulement partiellement décodé : ses trames arrivent, sans ordre rejouable',
      de: 'nur teilweise dekodiert: Seine Telegramme kommen an, ohne wiederholbaren Befehl',
      es: 'solo decodificado en parte: sus tramas llegan, sin orden reproducible',
    });
  }
  if (decoder !== id) {
    return pick(language, {
      en: `decoded by channel ${decoder}`,
      fr: `décodé par le canal ${decoder}`,
      de: `dekodiert von Kanal ${decoder}`,
      es: `decodificado por el canal ${decoder}`,
    });
  }
  return pick(language, {
    en: 'decodes itself',
    fr: 'décodé par lui-même',
    de: 'dekodiert sich selbst',
    es: 'se decodifica a sí mismo',
  });
}

/** The declared devices that speak a protocol, by their own channel or a remote. */
function devicesOn(config, id) {
  const names = [];
  for (const device of config.devmelDevices ?? []) {
    // A box is not a radio device: its channel is the placeholder {id: 1} (see
    // config.js), which read as "declared on" the generic 433 MHz protocol for
    // every export, the box itself being in it.
    if (device.rtype === DEVICE_TYPES.BOX) {
      continue;
    }
    const channels = [device.channel, ...(device.remotes ?? [])];
    if (channels.some((channel) => Number(channel?.id) === id)) {
      names.push(`"${device.name}"`);
    }
  }
  return names;
}

function footer(language) {
  return pick(language, {
    en:
      'Put the pid you want in the Listening channel field to listen to that protocol — the box ' +
      'listens to one at a time. Empty the field to go back to deducing it from your devices.',
    fr:
      'Mettez le pid voulu dans le champ Canal d’écoute pour écouter ce protocole — le boîtier ' +
      "n'en écoute qu'un à la fois. Videz le champ pour revenir à la déduction à partir de vos " +
      'appareils.',
    de:
      'Trage die gewünschte pid in das Feld Empfangskanal ein, um dieses Protokoll zu ' +
      'empfangen — die Box empfängt nur eines auf einmal. Leere das Feld, um wieder aus ' +
      'deinen Geräten abzuleiten.',
    es:
      'Ponga el pid que desee en el campo Canal de escucha para escuchar ese protocolo — la ' +
      'pasarela solo escucha uno a la vez. Vacíe el campo para volver a deducirlo de sus ' +
      'dispositivos.',
  });
}

/** Lowercase, accent-free, trimmed: how a search is compared. */
function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}
