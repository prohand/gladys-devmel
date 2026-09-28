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
import { describeFate } from '../devmel/connection.js';
import { describeAge, describeEmitter } from '../devmel/heard.js';
import { hearsChannel } from '../devices/index.js';
import { idsFor } from '../devices/helpers.js';

/** Key of the manifest widget. Never renamed: dashboards store it. */
export const RADIO_WIDGET = 'radio';

/** The one widget action: re-arm the listening subscription. */
export const WIDGET_ACTIONS = { REARM: 'rearm' };

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
        label: { en: 'Echoes of Gladys orders', fr: 'Échos des ordres Gladys' },
        value: Number(heard?.own) || 0,
        color: 'info',
      },
      {
        label: { en: 'Frames dropped', fr: 'Trames écartées' },
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
        label: { en: 'Box temperature', fr: 'Température boîtier' },
        icon: 'thermometer',
      },
      {
        type: 'value',
        device_feature: ids.feature('illuminance'),
        label: { en: 'Box light', fr: 'Luminosité boîtier' },
        icon: 'sun',
      },
    );
  }
  components.push({
    type: 'value',
    value: entries.length,
    label: { en: 'Emitters heard', fr: 'Émetteurs entendus' },
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
      label: { en: 'Re-arm listening', fr: "Réarmer l'écoute" },
      icon: 'refresh-cw',
      style: 'primary',
      action: { key: WIDGET_ACTIONS.REARM },
    },
    {
      type: 'button',
      label: { en: 'Documentation', fr: 'Documentation' },
      icon: 'book-open',
      style: 'secondary',
      link: { url: DOCS_URL },
    },
  );

  return { ttl_seconds: 60, components };
}

/** What is missing before anything can work, or null when nothing is. */
function setupNotice(config) {
  if (!config.effectiveServiceUrl) {
    return {
      en: 'No AirSend service: turn the built-in one on.',
      fr: 'Aucun service AirSend : activez le service intégré.',
    };
  }
  if (!config.spurl) {
    return {
      en: 'Paste the sp:// connection string in the configuration.',
      fr: 'Collez la chaîne de connexion sp:// dans la configuration.',
    };
  }
  if ((config.spurlProblems ?? []).length > 0) {
    return {
      en: 'The sp:// connection string looks wrong: run "Test the connection".',
      fr: 'La chaîne sp:// semble incorrecte : lancez « Tester la connexion ».',
    };
  }
  return null;
}

function serviceItem(config, service) {
  const label = { en: 'AirSend service', fr: 'Service AirSend' };
  if (!config.effectiveServiceUrl) {
    return { label, value: { en: 'none', fr: 'aucun' }, color: 'warning' };
  }
  if (!config.embeddedService) {
    return { label, value: { en: 'external', fr: 'externe' }, color: 'info' };
  }
  const status = service?.status?.();
  if (status?.running) {
    return { label, value: { en: 'running', fr: 'en marche' }, color: 'success' };
  }
  return { label, value: { en: 'stopped', fr: 'arrêté' }, color: 'danger' };
}

function listeningItem(config, listen, table) {
  const label = { en: 'Listening', fr: 'Écoute' };
  const plan = listen?.plan;
  if (config.listen_channel === 0 || plan?.enabled === false) {
    return { label, value: { en: 'off', fr: 'désactivée' }, color: 'warning' };
  }
  if (!plan) {
    return { label, value: { en: 'not armed yet', fr: 'pas encore armée' }, color: 'neutral' };
  }
  if (listen?.error) {
    return {
      label,
      value: { en: 'refused by the box', fr: 'refusée par le boîtier' },
      color: 'danger',
    };
  }
  if (!listen?.url) {
    return { label, value: { en: 'no route', fr: 'aucune route' }, color: 'warning' };
  }
  const name = plan.name ?? table?.get?.(Number(plan.channel))?.name;
  return {
    label,
    value: clip(name ? `pid ${plan.channel} ${name}` : `pid ${plan.channel}`, 40),
    color: 'success',
  };
}

function lastFrameItem(entries, now) {
  const label = { en: 'Last frame heard', fr: 'Dernière trame' };
  const last = entries[0];
  if (!last) {
    return { label, value: { en: 'none yet', fr: 'aucune' }, color: 'neutral' };
  }
  return {
    label,
    value: {
      en: describeAge(now - last.lastSeen, 'en').replace(/^last one /, ''),
      fr: describeAge(now - last.lastSeen, 'fr').replace(/^dernière /, ''),
    },
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
    subtitle: {
      en: [address ?? 'no address', `${entry.frames} frame${entry.frames > 1 ? 's' : ''}`].join(
        ' · ',
      ),
      fr: [address ?? 'sans adresse', `${entry.frames} trame${entry.frames > 1 ? 's' : ''}`].join(
        ' · ',
      ),
    },
    date: toIso(entry.lastSeen),
    badge: badgeOf(config, entry),
    description: {
      en: clip(
        `${describeEmitter(entry, now, 'en', table)} — ${describeFate(config, entry, 'en')}.`,
        2000,
      ),
      fr: clip(
        `${describeEmitter(entry, now, 'fr', table)} — ${describeFate(config, entry, 'fr')}.`,
        2000,
      ),
    },
  };
}

/** What became of an emitter's frames, as a short colored badge. */
function badgeOf(config, entry) {
  if (entry.source === null || entry.source === undefined) {
    return { text: { en: 'not decoded', fr: 'non décodé' }, color: 'neutral' };
  }
  if (entry.dropped) {
    return { text: { en: 'dropped', fr: 'écarté' }, color: 'danger' };
  }
  if (!config.devmelDevices.some((device) => hearsChannel(device, entry))) {
    return { text: { en: 'unknown', fr: 'inconnu' }, color: 'warning' };
  }
  return entry.understood
    ? { text: { en: 'followed', fr: 'suivi' }, color: 'success' }
    : { text: { en: 'mute', fr: 'muet' }, color: 'neutral' };
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
