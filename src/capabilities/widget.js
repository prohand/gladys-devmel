// -----------------------------------------------------------------------------
// Dashboard widget (Gladys 5.1+): the radio, at a glance.
//
// Everything this integration can say about itself lived in two places a user
// only opens when something is already wrong — the "Test the connection" report
// and the logs. The `radio` widget puts the short version of both on the
// dashboard: is the service up, which protocol the box listens to, when a frame
// last came in, and which emitters were heard and what became of them. The one
// thing it can DO is what the report cannot: re-arm the listening subscription,
// the fix for a box that rebooted and forgot it.
//
// The content is declarative (the core renders it, no HTML): see the "Dashboard
// widgets" section of the SDK README for the vocabulary and the budget — at most
// 1 status list, 6 tiles, 1 focal component and 4 buttons.
// -----------------------------------------------------------------------------

import { DEVICE_TYPES } from '../config.js';
import { boxDevices, describeFate } from '../devmel/connection.js';
import { describeAgo, describeEmitter } from '../devmel/heard.js';
import { hearsChannel, positionedShutters } from '../devices/index.js';
import { idsFor } from '../devices/helpers.js';
import { localize, pick } from '../i18n.js';

/** Key of the manifest widget. Never renamed: dashboards store it. */
export const RADIO_WIDGET = 'radio';

/**
 * The widget actions: re-arm the listening subscription, and set the known
 * position of a shutter (a form behind the tap, Gladys 5.2+ widget fields).
 * Never renamed: they are relayed back by key.
 */
export const WIDGET_ACTIONS = { REARM: 'rearm', SET_KNOWN_POSITION: 'set_known_position' };

/** Choices of the shutter select of the recalibration form: a form, not a catalog. */
const MAX_SHUTTER_OPTIONS = 50;

/** The content budget of the core: 8 components at most. */
const MAX_COMPONENTS = 8;

/** Option labels of a widget form hold 40 characters. */
const OPTION_LABEL_LENGTH = 40;

/** How many emitters the list shows when the instance says nothing. */
export const DEFAULT_EMITTERS = 5;

/** The widget list component holds 8 rows at most. */
const MAX_EMITTERS = 8;

const DOCS_URL = 'https://github.com/prohand/gladys-devmel/blob/main/docs/en.md';

/**
 * The content of the `radio` widget.
 *
 * @param {object} state
 * @param {object} state.gladys the SDK instance (for the external ids)
 * @param {object} state.config normalized configuration
 * @param {object} [state.service] the bundled AirSend service
 * @param {object} [state.listen] `{ url, error, plan }`, as index.js keeps it
 * @param {object} [state.heard] the registry of emitters heard
 * @param {Map<number, object>} [state.table] the protocol table of the service
 * @param {object} [state.settings] the instance settings of the widget
 * @param {number} [state.now] clock
 */
export function buildRadioWidget({
  gladys,
  config,
  service = null,
  listen = null,
  heard = null,
  table = null,
  settings = {},
  now = Date.now(),
}) {
  const components = [];
  const entries = typeof heard?.list === 'function' ? heard.list() : [];

  const notice = setupNotice(config);
  if (notice) {
    components.push({ type: 'text', variant: 'caption', text: notice });
  }

  components.push({
    type: 'status',
    items: [
      serviceItem(config, service),
      listeningItem(config, listen, table),
      lastFrameItem(entries, now),
      {
        label: {
          en: 'Echoes of Gladys orders',
          fr: 'Échos des ordres Gladys',
          de: 'Echos der Gladys-Befehle',
          es: 'Ecos de órdenes de Gladys',
        },
        value: Number(heard?.own) || 0,
        color: 'info',
      },
      {
        label: {
          en: 'Frames dropped',
          fr: 'Trames écartées',
          de: 'Verworfene Telegramme',
          es: 'Tramas descartadas',
        },
        value: Number(heard?.dropped) || 0,
        color: Number(heard?.dropped) > 0 ? 'warning' : 'neutral',
      },
    ],
  });

  // The box's own sensors, live: bound to the features, they follow the
  // published states with no refresh of the widget.
  const box = config.devmelDevices.find(
    (device) => device.rtype === DEVICE_TYPES.BOX && device.sensors,
  );
  if (box) {
    const ids = idsFor(gladys, 'gateway', box);
    components.push(
      {
        type: 'value',
        device_feature: ids.feature('temperature'),
        label: {
          en: 'Box temperature',
          fr: 'Température boîtier',
          de: 'Temperatur der Box',
          es: 'Temperatura pasarela',
        },
        icon: 'thermometer',
      },
      {
        type: 'value',
        device_feature: ids.feature('illuminance'),
        label: {
          en: 'Box light',
          fr: 'Luminosité boîtier',
          de: 'Helligkeit der Box',
          es: 'Luminosidad pasarela',
        },
        icon: 'sun',
      },
    );
  }
  components.push({
    type: 'value',
    value: entries.length,
    label: {
      en: 'Emitters heard',
      fr: 'Émetteurs entendus',
      de: 'Gehörte Sender',
      es: 'Emisores oídos',
    },
    icon: 'radio',
  });

  const shown = emittersShown(settings);
  if (shown > 0 && entries.length > 0) {
    components.push({
      type: 'card-list',
      display: 'list',
      items: entries.slice(0, shown).map((entry) => emitterItem(config, entry, now, table)),
    });
  }

  components.push(
    {
      type: 'button',
      label: {
        en: 'Re-arm listening',
        fr: "Réarmer l'écoute",
        de: 'Empfang neu aktivieren',
        es: 'Rearmar la escucha',
      },
      icon: 'refresh-cw',
      style: 'primary',
      action: { key: WIDGET_ACTIONS.REARM },
    },
    {
      type: 'button',
      label: {
        en: 'Documentation',
        fr: 'Documentation',
        de: 'Dokumentation',
        es: 'Documentación',
      },
      icon: 'book-open',
      style: 'secondary',
      link: { url: DOCS_URL },
    },
  );

  // Last, and only within the 8 components of the budget: the core would drop
  // an overflowing component in content order, and the setup notice, the
  // status and the re-arm button matter more on a box that is not set up yet.
  const recalibrate = recalibrateButton(gladys, config);
  if (recalibrate && components.length < MAX_COMPONENTS) components.push(recalibrate);

  return { ttl_seconds: 60, components };
}

/**
 * "Recalibrate a shutter": the `set_known_position` scene action, on the
 * dashboard. The tap opens a form (which shutter, where it really is) that the
 * core validates before relaying it. Absent when no shutter has a position.
 */
function recalibrateButton(gladys, config) {
  const shutters = positionedShutters(gladys, config).slice(0, MAX_SHUTTER_OPTIONS);
  if (shutters.length === 0) return null;
  return {
    type: 'button',
    label: {
      en: 'Recalibrate a shutter',
      fr: 'Recaler un volet',
      de: 'Rollladen neu setzen',
      es: 'Recalibrar persiana',
    },
    icon: 'sliders',
    style: 'secondary',
    action: {
      key: WIDGET_ACTIONS.SET_KNOWN_POSITION,
      fields: [
        {
          key: 'device',
          type: 'select',
          label: { en: 'Shutter', fr: 'Volet', de: 'Rollladen', es: 'Persiana' },
          required: true,
          default: shutters[0].externalId,
          options: shutters.map(({ externalId, name }) => {
            const text = name.length > OPTION_LABEL_LENGTH ? `${name.slice(0, 39)}…` : name;
            return { value: externalId, label: { en: text, fr: text, de: text, es: text } };
          }),
        },
        {
          key: 'position',
          type: 'number',
          label: {
            en: 'Real position (%)',
            fr: 'Position réelle (%)',
            de: 'Tatsächliche Position (%)',
            es: 'Posición real (%)',
          },
          description: {
            en: '0 = closed, 100 = open. The shutter does not move.',
            fr: '0 = fermé, 100 = ouvert. Le volet ne bouge pas.',
            de: '0 = geschlossen, 100 = offen. Der Rollladen bewegt sich nicht.',
            es: '0 = cerrada, 100 = abierta. La persiana no se mueve.',
          },
          required: true,
          min: 0,
          max: 100,
          default: 100,
        },
      ],
    },
  };
}

/** What is missing before anything can work, or null when nothing is. */
function setupNotice(config) {
  if (!config.effectiveServiceUrl) {
    return {
      en: 'No AirSend service: turn the built-in one on.',
      fr: 'Aucun service AirSend : activez le service intégré.',
      de: 'Kein AirSend-Dienst: Schalte den integrierten ein.',
      es: 'Ningún servicio AirSend: active el integrado.',
    };
  }
  if (!config.spurl) {
    return {
      en: 'Paste the sp:// connection string in the configuration.',
      fr: 'Collez la chaîne de connexion sp:// dans la configuration.',
      de: 'Füge die sp://-Verbindungszeichenfolge in der Konfiguration ein.',
      es: 'Pegue la cadena de conexión sp:// en la configuración.',
    };
  }
  if ((config.spurlProblems ?? []).length > 0) {
    return {
      en: 'The sp:// connection string looks wrong: run "Test the connection".',
      fr: 'La chaîne sp:// semble incorrecte : lancez « Tester la connexion ».',
      de: 'Die sp://-Verbindungszeichenfolge scheint falsch: Führe „Verbindung testen“ aus.',
      es: 'La cadena de conexión sp:// parece incorrecta: ejecute «Probar la conexión».',
    };
  }
  return null;
}

function serviceItem(config, service) {
  const label = {
    en: 'AirSend service',
    fr: 'Service AirSend',
    de: 'AirSend-Dienst',
    es: 'Servicio AirSend',
  };
  if (!config.effectiveServiceUrl) {
    return {
      label,
      value: { en: 'none', fr: 'aucun', de: 'keiner', es: 'ninguno' },
      color: 'warning',
    };
  }
  if (!config.embeddedService) {
    return {
      label,
      value: { en: 'external', fr: 'externe', de: 'extern', es: 'externo' },
      color: 'info',
    };
  }
  const status = service?.status?.();
  if (status?.running) {
    return {
      label,
      value: { en: 'running', fr: 'en marche', de: 'läuft', es: 'en marcha' },
      color: 'success',
    };
  }
  return {
    label,
    value: { en: 'stopped', fr: 'arrêté', de: 'gestoppt', es: 'detenido' },
    color: 'danger',
  };
}

function listeningItem(config, listen, table) {
  const label = { en: 'Listening', fr: 'Écoute', de: 'Empfang', es: 'Escucha' };
  const plan = listen?.plan;
  if (config.listen_channel === 0 || plan?.enabled === false) {
    return {
      label,
      value: { en: 'off', fr: 'désactivée', de: 'aus', es: 'desactivada' },
      color: 'warning',
    };
  }
  if (!plan) {
    return {
      label,
      value: {
        en: 'not armed yet',
        fr: 'pas encore armée',
        de: 'noch nicht aktiv',
        es: 'aún sin armar',
      },
      color: 'neutral',
    };
  }
  if (listen?.error) {
    return {
      label,
      value: {
        en: 'refused by the box',
        fr: 'refusée par le boîtier',
        de: 'von der Box abgelehnt',
        es: 'rechazada por la pasarela',
      },
      color: 'danger',
    };
  }
  if (!listen?.url) {
    // No box at all is not a missing route: it is a missing connection string,
    // or a missing service when the string is there (see `noBoxFix`).
    if (boxDevices(config).length === 0) {
      return config.effectiveServiceUrl
        ? {
            label,
            value: { en: 'no box', fr: 'aucun boîtier', de: 'keine Box', es: 'sin pasarela' },
            color: 'warning',
          }
        : {
            label,
            value: { en: 'no service', fr: 'aucun service', de: 'kein Dienst', es: 'sin servicio' },
            color: 'warning',
          };
    }
    return {
      label,
      value: { en: 'no route', fr: 'aucune route', de: 'kein Weg', es: 'sin ruta' },
      color: 'warning',
    };
  }
  const name = plan.name ?? table?.get?.(Number(plan.channel))?.name;
  return {
    label,
    value: clip(name ? `pid ${plan.channel} ${name}` : `pid ${plan.channel}`, 40),
    color: 'success',
  };
}

function lastFrameItem(entries, now) {
  const label = {
    en: 'Last frame heard',
    fr: 'Dernière trame',
    de: 'Letztes Telegramm',
    es: 'Última trama',
  };
  const last = entries[0];
  if (!last) {
    return {
      label,
      value: { en: 'none yet', fr: 'aucune', de: 'noch keines', es: 'ninguna aún' },
      color: 'neutral',
    };
  }
  return {
    label,
    value: localize((language) => describeAgo(now - last.lastSeen, language)),
    color: 'success',
  };
}

/** One emitter heard, as a row of the list. */
function emitterItem(config, entry, now, table) {
  const name = table?.get?.(Number(entry.id))?.name;
  const address =
    entry.source === null || entry.source === undefined ? null : `addr ${entry.source}`;
  return {
    title: clip(name ? `pid ${entry.id} ${name}` : `pid ${entry.id}`, 60),
    subtitle: localize((language) => {
      const many = entry.frames > 1;
      return [
        address ??
          pick(language, {
            en: 'no address',
            fr: 'sans adresse',
            de: 'ohne Adresse',
            es: 'sin dirección',
          }),
        pick(language, {
          en: `${entry.frames} frame${many ? 's' : ''}`,
          fr: `${entry.frames} trame${many ? 's' : ''}`,
          de: `${entry.frames} Telegramm${many ? 'e' : ''}`,
          es: `${entry.frames} trama${many ? 's' : ''}`,
        }),
      ].join(' · ');
    }),
    date: toIso(entry.lastSeen),
    badge: badgeOf(config, entry),
    description: localize((language) =>
      clip(
        `${describeEmitter(entry, now, language, table)} — ` +
          `${describeFate(config, entry, language)}.`,
        2000,
      ),
    ),
  };
}

/** What became of an emitter's frames, as a short colored badge. */
function badgeOf(config, entry) {
  // In the order describeFate tells it, so the badge never contradicts the
  // line under it: a protocol-only remote claims the address-less frames.
  const claimed = config.devmelDevices.some((device) => hearsChannel(device, entry));
  if ((entry.source === null || entry.source === undefined) && !claimed) {
    return {
      text: {
        en: 'not decoded',
        fr: 'non décodé',
        de: 'nicht dekodiert',
        es: 'no decodificado',
      },
      color: 'neutral',
    };
  }
  if (entry.stale && claimed) {
    return {
      text: {
        en: 'press again',
        fr: 'à réessayer',
        de: 'erneut drücken',
        es: 'pulse de nuevo',
      },
      color: 'neutral',
    };
  }
  if (entry.dropped) {
    return {
      text: { en: 'dropped', fr: 'écarté', de: 'verworfen', es: 'descartado' },
      color: 'danger',
    };
  }
  if (!claimed) {
    return {
      text: { en: 'unknown', fr: 'inconnu', de: 'unbekannt', es: 'desconocido' },
      color: 'warning',
    };
  }
  return entry.understood
    ? { text: { en: 'followed', fr: 'suivi', de: 'befolgt', es: 'seguido' }, color: 'success' }
    : { text: { en: 'mute', fr: 'muet', de: 'stumm', es: 'mudo' }, color: 'neutral' };
}

function emittersShown(settings) {
  const raw = settings?.emitters;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_EMITTERS;
  }
  const number = Math.trunc(Number(raw));
  return Number.isFinite(number) ? Math.max(0, Math.min(MAX_EMITTERS, number)) : DEFAULT_EMITTERS;
}

function toIso(timestamp) {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function clip(text, length) {
  const value = String(text);
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
