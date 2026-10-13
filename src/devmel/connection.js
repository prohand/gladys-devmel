// -----------------------------------------------------------------------------
// Connection state: what the Configuration screen shows.
//
// Two things live here because both answer the same question — "can this
// integration reach the hardware right now?":
//   - the status published after every (re)initialization;
//   - the "Test the connection" manifest action, which says the same thing on
//     demand, in more detail.
// -----------------------------------------------------------------------------

import { describeSpurl, DEVICE_TYPES, hostFromSpurl, otherSpurls } from '../config.js';
import { channelToType, planListening } from './listening.js';
import { describeEmitter } from './heard.js';
import { hearsChannel } from '../devices/index.js';
import { ordersOf } from '../capabilities/scenes.js';
import { localize, pick } from '../i18n.js';

/**
 * The AirSend boxes to talk to when listening for radio frames.
 *
 * A box declared in the device list wins (it may carry its own connection
 * string); when the user only filled the global credentials, the box is
 * implicit and rebuilt here.
 *
 * Rebuilt too when the boxes declared all carry ANOTHER string: that is a
 * second box, and the one behind the global string still carries every order
 * of every device without a string of its own. Left out, it was never listened
 * through nor kept warm, while the second box's subscription made every report
 * say listening worked.
 */
export function boxDevices(config) {
  // Only the boxes something can reach: a box declared before any connection
  // string was pasted (the docs' own example) has nothing to bind with, and
  // counting it made listening, "Test the connection" and the widget report
  // "the box refused the subscription" every ten minutes instead of asking for
  // the string.
  const boxes = config.devmelDevices.filter(
    (device) =>
      device.rtype === DEVICE_TYPES.BOX &&
      Boolean(config.effectiveServiceUrl && (device.spurl || config.spurl)),
  );
  if (boxes.some((box) => isGlobalBox(box, config))) {
    return boxes;
  }
  if (!config.spurl || !config.effectiveServiceUrl) {
    return boxes;
  }
  return [
    ...boxes,
    {
      name: 'AirSend box',
      rtype: DEVICE_TYPES.BOX,
      platformId: 'airsend-box',
      channel: { id: 1 },
      spurl: config.spurl,
    },
  ];
}

/**
 * What to do when `boxDevices` comes back empty, as the user can act on it.
 *
 * Two different things are missing behind the same empty list: the connection
 * string, or the AirSend service that would carry it (the built-in one turned
 * off and no URL typed). Asking for the string when it IS pasted sent the user
 * after the wrong field, where the bind itself used to name the service.
 *
 * @param {object} config normalized configuration
 * @returns {{ en: string, fr: string, de: string, es: string }}
 */
export function noBoxFix(config) {
  if (!config.effectiveServiceUrl) {
    return {
      en:
        'no AirSend Web Service to reach it (the built-in one is turned off and no service URL ' +
        'is filled in)',
      fr:
        'aucun service AirSend pour le joindre (le service intégré est désactivé et aucune URL ' +
        "de service n'est renseignée)",
      de:
        'kein AirSend Web Service, um sie zu erreichen (der integrierte ist ausgeschaltet und ' +
        'keine Dienst-URL ist eingetragen)',
      es:
        'ningún AirSend Web Service para llegar a ella (el integrado está desactivado y no se ha ' +
        'indicado ninguna URL de servicio)',
    };
  }
  return {
    en: 'paste the sp:// connection string first',
    fr: "collez d'abord la chaîne de connexion sp://",
    de: 'fügen Sie zuerst die sp://-Verbindungszeichenfolge ein',
    es: 'pegue primero la cadena de conexión sp://',
  };
}

/** Is this declared box the one behind the global connection string? */
function isGlobalBox(box, config) {
  // No string of its own: it is reached with the global one (client.spurlOf).
  if (!box.spurl || box.spurl === config.spurl) {
    return true;
  }
  const host = hostFromSpurl(box.spurl);
  return Boolean(host) && host === hostFromSpurl(config.spurl);
}

/**
 * Status published through `setConnectionStatus`: connected as soon as the
 * local channel can carry a command, with a message explaining what is missing
 * otherwise.
 */
export async function describeConnection(client, config, service = null) {
  const hasLocal = Boolean(config.effectiveServiceUrl && config.spurl);

  if (!hasLocal) {
    // The service is bundled, so what is missing is almost always the same
    // thing: the connection string that proves the box is yours.
    return {
      connected: false,
      message: config.embeddedService
        ? {
            en: 'Not configured yet: paste the sp:// connection string exported by airsend.cloud.',
            fr: 'Pas encore configuré : collez la chaîne de connexion sp:// exportée depuis airsend.cloud.',
            de: 'Noch nicht konfiguriert: Fügen Sie die von airsend.cloud exportierte sp://-Verbindungszeichenfolge ein.',
            es: 'Aún sin configurar: pegue la cadena de conexión sp:// exportada desde airsend.cloud.',
          }
        : {
            en: 'Not configured yet: fill in the AirSend Web Service URL and its connection string.',
            fr: "Pas encore configuré : renseignez l'URL du service AirSend et sa chaîne de connexion.",
            de: 'Noch nicht konfiguriert: Tragen Sie die URL des AirSend Web Service und seine Verbindungszeichenfolge ein.',
            es: 'Aún sin configurar: indique la URL del AirSend Web Service y su cadena de conexión.',
          },
    };
  }

  // A connection string the box will refuse is worth saying BEFORE the service
  // is probed: the probe passes (it does not use the string), the screen says
  // "connected", and every single order answers 401.
  const [problem] = config.spurlProblems ?? [];
  if (problem) {
    return {
      connected: false,
      message: {
        en: `Connection string: ${problem.en}`,
        fr: `Chaîne de connexion : ${problem.fr}`,
        de: `Verbindungszeichenfolge: ${pick('de', problem)}`,
        es: `Cadena de conexión: ${pick('es', problem)}`,
      },
    };
  }

  // The embedded service failing to start is worth saying out loud: nothing
  // else explains why a perfectly good connection string reaches nothing.
  const serviceError = embeddedServiceError(config, service);
  if (serviceError) {
    return {
      connected: false,
      message: {
        en: `Built-in AirSend service unavailable: ${serviceError}`,
        fr: `Service AirSend intégré indisponible : ${serviceError}`,
        de: `Integrierter AirSend-Dienst nicht verfügbar: ${serviceError}`,
        es: `Servicio AirSend integrado no disponible: ${serviceError}`,
      },
    };
  }

  try {
    await client.pingLocal();
    return { connected: true };
  } catch (err) {
    return {
      connected: false,
      message: {
        en: `AirSend Web Service unreachable: ${err.message}`,
        fr: `Service AirSend injoignable : ${err.message}`,
        de: `AirSend Web Service nicht erreichbar: ${err.message}`,
        es: `AirSend Web Service inaccesible: ${err.message}`,
      },
    };
  }
}

/**
 * Handler of the `test_connection` manifest action: report the local channel,
 * the radio listener and what was understood from the device list, which is the
 * fastest way to spot a mistyped connection string, a device list that did not
 * parse, or a listener that was never armed.
 *
 * @param {object} [listen] state of the last binding attempt, as index.js keeps
 *   it: `{ url, error, plan }` — where the frames are pushed, or why they are
 *   not, and which protocol was subscribed to (see src/devmel/listening.js).
 * @param {object} [heard] the registry of emitters heard (see src/devmel/heard.js)
 * @param {Map<number, object>} [table] the protocol table of the service, so
 *   every pid the report prints is named. "pid 14177" identifies a protocol
 *   without saying which one, and the name is what a user compares to the
 *   brand written on their remote.
 */
export async function testConnection(
  client,
  config,
  service = null,
  listen = null,
  heard = null,
  table = null,
) {
  // One multi-language object per line of the report, joined per language at
  // the end: the lines are the same in every language, only their words move.
  const lines = [];

  const where = config.embeddedService
    ? {
        en: 'built-in service',
        fr: 'service intégré',
        de: 'integrierter AirSend-Dienst',
        es: 'servicio AirSend integrado',
      }
    : { en: 'service', fr: 'service', de: 'AirSend-Dienst', es: 'servicio AirSend' };

  const serviceError = embeddedServiceError(config, service);
  if (serviceError) {
    lines.push({
      en: `Service: the built-in AirSend service is not running (${serviceError}).`,
      fr: `Service : le service AirSend intégré ne tourne pas (${serviceError}).`,
      de: `Dienst: Der integrierte AirSend-Dienst läuft nicht (${serviceError}).`,
      es: `Servicio: el servicio AirSend integrado no está en marcha (${serviceError}).`,
    });
  }

  // The string itself, password removed. It is the one thing a 401 never says
  // and nobody can look up: the field shows dots, and the string is never
  // logged. Printed whether or not anything is wrong with it — half the
  // mistakes it catches are ones no check can name (the address of the other
  // box, a gw=1 nobody asked for).
  if (config.spurl) {
    const shown = describeSpurl(config.spurl);
    lines.push({
      en: `Connection string: ${shown}`,
      fr: `Chaîne de connexion : ${shown}`,
      de: `Verbindungszeichenfolge: ${shown}`,
      es: `Cadena de conexión: ${shown}`,
    });
  }
  for (const { name, spurl } of otherSpurls(config)) {
    const shown = describeSpurl(spurl);
    lines.push({
      en: `Connection string of "${name}": ${shown}`,
      fr: `Chaîne de connexion de « ${name} » : ${shown}`,
      de: `Verbindungszeichenfolge von „${name}“: ${shown}`,
      es: `Cadena de conexión de «${name}»: ${shown}`,
    });
  }
  for (const problem of config.spurlProblems ?? []) {
    lines.push({
      en: `Connection string: ${problem.en}`,
      fr: `Chaîne de connexion : ${problem.fr}`,
      de: `Verbindungszeichenfolge: ${pick('de', problem)}`,
      es: `Cadena de conexión: ${pick('es', problem)}`,
    });
  }

  if (config.effectiveServiceUrl && config.spurl) {
    const url = config.effectiveServiceUrl;
    try {
      await client.pingLocal();
      lines.push({
        en: `Local: AirSend ${where.en} reachable at ${url}.`,
        fr: `Local : ${where.fr} AirSend joignable sur ${url}.`,
        de: `Lokal: ${where.de} erreichbar unter ${url}.`,
        es: `Local: ${where.es} accesible en ${url}.`,
      });
    } catch (err) {
      lines.push({
        en: `Local: unreachable (${err.message}).`,
        fr: `Local : injoignable (${err.message}).`,
        de: `Lokal: nicht erreichbar (${err.message}).`,
        es: `Local: inaccesible (${err.message}).`,
      });
    }
  } else if (!config.effectiveServiceUrl) {
    lines.push({
      en: 'Local: disabled (no AirSend service, built-in one turned off).',
      fr: 'Local : désactivé (aucun service AirSend, service intégré désactivé).',
      de: 'Lokal: deaktiviert (kein AirSend-Dienst, der integrierte ist ausgeschaltet).',
      es: 'Local: desactivado (ningún servicio AirSend, el integrado está desactivado).',
    });
  } else {
    lines.push({
      en: 'Local: no connection string yet (the sp:// URL exported by airsend.cloud).',
      fr: "Local : pas encore de chaîne de connexion (l'URL sp:// exportée depuis airsend.cloud).",
      de: 'Lokal: noch keine Verbindungszeichenfolge (die von airsend.cloud exportierte sp://-URL).',
      es: 'Local: aún no hay cadena de conexión (la URL sp:// exportada desde airsend.cloud).',
    });
  }

  lines.push(
    localize(
      (language) =>
        `${pick(language, REPORT_LABELS.listening)}${describeListening(config, listen, language)}`,
    ),
  );

  // Omitted rather than apologized for when no registry was handed over: the
  // running integration always passes one, and a report line about a missing
  // internal is a line that helps nobody.
  if (typeof heard?.list === 'function') {
    const now = Date.now();
    const entries = heard.list();
    lines.push(
      localize(
        (language) =>
          `${pick(language, REPORT_LABELS.heard)}` +
          describeHeard(config, entries, language, now, heard, table),
      ),
    );
  }

  lines.push(
    localize(
      (language) => `${pick(language, REPORT_LABELS.devices)}${summarize(config, language)}`,
    ),
  );

  return localize((language) => lines.map((line) => pick(language, line)).join('\n'));
}

/** The names of the report lines, colon included (French spaces it). */
const REPORT_LABELS = {
  listening: { en: 'Listening: ', fr: 'Écoute : ', de: 'Empfang: ', es: 'Escucha: ' },
  heard: { en: 'Heard: ', fr: 'Entendu : ', de: 'Gehört: ', es: 'Oído: ' },
  devices: { en: 'Devices: ', fr: 'Appareils : ', de: 'Geräte: ', es: 'Dispositivos: ' },
};

/**
 * What the radio listener is doing. Worth its own line, and the longest one of
 * the report: it is the only part of the integration whose silence looks
 * exactly like a device that never emits.
 */
function describeListening(config, listen, language) {
  // The plan the last binding attempt used. Recomputed when there was none —
  // the action can be run before the integration ever bound anything, and what
  // it would listen to is still the answer to the question being asked.
  const plan = listen?.plan ?? planListening(config);
  if (!plan.enabled) {
    return pick(language, {
      en: 'disabled (listening channel set to 0).',
      fr: "désactivée (canal d'écoute à 0).",
      de: 'deaktiviert (Empfangskanal auf 0).',
      es: 'desactivada (canal de escucha en 0).',
    });
  }

  const channel = describeChannel(plan, language);
  const coverage = describeCoverage(plan, language);

  if (listen?.error) {
    return pick(language, {
      en: `${channel}: the box refused the subscription (${listen.error}).`,
      fr: `${channel} : le boîtier a refusé l'abonnement (${listen.error}).`,
      de: `${channel}: Die Box hat das Abonnement abgelehnt (${listen.error}).`,
      es: `${channel}: la pasarela rechazó la suscripción (${listen.error}).`,
    });
  }
  if (listen?.url) {
    return pick(language, {
      en: `${channel}, frames pushed to ${listen.url}.${coverage}`,
      fr: `${channel}, trames poussées vers ${listen.url}.${coverage}`,
      de: `${channel}, Telegramme werden an ${listen.url} gesendet.${coverage}`,
      es: `${channel}, tramas enviadas a ${listen.url}.${coverage}`,
    });
  }
  // No box to bind through: the route is not what is missing, the connection
  // string (or the service) is — and sending the user after Gladys Plus would
  // be the wrong half.
  if (boxDevices(config).length === 0) {
    const fix = pick(language, noBoxFix(config));
    return pick(language, {
      en: `${channel}: no AirSend box to listen through — ${fix}.`,
      fr: `${channel} : aucun boîtier à qui demander l'écoute — ${fix}.`,
      de: `${channel}: keine AirSend-Box, über die empfangen werden kann — ${fix}.`,
      es: `${channel}: ninguna pasarela AirSend a la que pedir la escucha — ${fix}.`,
    });
  }
  // No route at all. With the bundled service that never happens (the loopback
  // callback is always there); with a service of the user's own it does, and
  // the relay is then the only way back in.
  return pick(language, {
    en:
      `${channel}: no route for the frames. An AirSend service you run ` +
      'elsewhere cannot reach this integration directly: link Gladys Plus to ' +
      'receive them.',
    fr:
      `${channel} : aucune route pour les trames. Un service AirSend que vous ` +
      'faites tourner ailleurs ne peut pas joindre cette intégration directement : ' +
      'liez Gladys Plus pour recevoir les trames.',
    de:
      `${channel}: kein Weg für die Telegramme. Ein AirSend-Dienst, den Sie ` +
      'anderswo betreiben, kann diese Integration nicht direkt erreichen: Verknüpfen ' +
      'Sie Gladys Plus, um sie zu empfangen.',
    es:
      `${channel}: ninguna ruta para las tramas. Un servicio AirSend que ejecuta ` +
      'en otro lugar no puede llegar directamente a esta integración: vincule Gladys ' +
      'Plus para recibirlas.',
  });
}

/** The protocol being listened to, named when the service knows its name. */
function describeChannel(plan, language) {
  const name = plan.name ? ` "${plan.name}"` : '';
  // Where the channel comes from, but only when the device list had a say: a
  // deduction made without a single device is just the generic decoder.
  const deduced = plan.deduced && plan.covered.length + plan.uncovered.length > 0;
  const how = deduced
    ? pick(language, {
        en: ' (deduced from your devices)',
        fr: ' (déduit de vos appareils)',
        de: ' (aus Ihren Geräten abgeleitet)',
        es: ' (deducido de sus dispositivos)',
      })
    : '';
  return pick(language, {
    en: `channel ${plan.channel}${name}${how}`,
    fr: `canal ${plan.channel}${name}${how}`,
    de: `Kanal ${plan.channel}${name}${how}`,
    es: `canal ${plan.channel}${name}${how}`,
  });
}

/**
 * Which devices that protocol covers. A box has one radio and listens to one
 * protocol at a time, so devices left out are left out for good — saying which
 * ones is the difference between "listening works" and "listening works for
 * the shutter but not for the gate".
 */
function describeCoverage(plan, language) {
  if (plan.covered.length + plan.uncovered.length === 0) {
    if (!plan.fallback) {
      return '';
    }
    // Nothing declared: the generic 433 MHz decoder is what is left, and
    // saying so is the whole point — it hears nothing at all of an 868 MHz
    // protocol, which is the shape of "my remote never shows up".
    return pick(language, {
      en:
        ' No radio device declared: this is the default generic 433 MHz listening, ' +
        'deaf to 868 MHz protocols (Profalux, Somfy io). Declare a device on that ' +
        'protocol, or fill in its pid as the listening channel.',
      fr:
        " Aucun appareil radio déclaré : c'est l'écoute générique 433 MHz par défaut, " +
        'sourde aux protocoles 868 MHz (Profalux, Somfy io). Déclarez un appareil sur ' +
        "ce protocole, ou renseignez son pid dans le canal d'écoute.",
      de:
        ' Kein Funkgerät angegeben: Das ist der standardmäßige generische 433-MHz-Empfang, ' +
        'taub für 868-MHz-Protokolle (Profalux, Somfy io). Geben Sie ein Gerät mit diesem ' +
        'Protokoll an oder tragen Sie seine pid als Empfangskanal ein.',
      es:
        ' Ningún dispositivo de radio declarado: es la escucha genérica de 433 MHz por ' +
        'defecto, sorda a los protocolos de 868 MHz (Profalux, Somfy io). Declare un ' +
        'dispositivo con ese protocolo o indique su pid como canal de escucha.',
    });
  }
  const heard = names(plan.covered);
  const extra = `${describeEchoOnly(plan, language)}${describeUnheardRemotes(plan, language)}`;
  if (plan.uncovered.length === 0) {
    return pick(language, {
      en: ` Devices heard: ${heard}.${extra}`,
      fr: ` Appareils entendus : ${heard}.${extra}`,
      de: ` Gehörte Geräte: ${heard}.${extra}`,
      es: ` Dispositivos oídos: ${heard}.${extra}`,
    });
  }
  const deaf = names(plan.uncovered);
  if (plan.covered.length === 0) {
    return pick(language, {
      en:
        ` No declared device speaks this protocol: ${deaf} will not be heard. ` +
        'Clear the listening channel to deduce it from your devices.',
      fr:
        ` Aucun appareil déclaré n'émet sur ce protocole : ${deaf} ne ` +
        "seront pas entendus. Videz le canal d'écoute pour le déduire de vos appareils.",
      de:
        ` Kein angegebenes Gerät sendet mit diesem Protokoll: ${deaf} werden nicht ` +
        'gehört. Leeren Sie den Empfangskanal, um ihn aus Ihren Geräten abzuleiten.',
      es:
        ` Ningún dispositivo declarado emite con este protocolo: ${deaf} no se ` +
        'oirán. Vacíe el canal de escucha para deducirlo de sus dispositivos.',
    });
  }
  return pick(language, {
    en:
      ` Devices heard: ${heard}. The box listens to one protocol at a time: ` +
      `${deaf} will not be heard.${extra}`,
    fr:
      ` Appareils entendus : ${heard}. Le boîtier n'écoute qu'un protocole à la ` +
      `fois : ${deaf} ne seront pas entendus.${extra}`,
    de:
      ` Gehörte Geräte: ${heard}. Die Box empfängt nur ein Protokoll auf einmal: ` +
      `${deaf} werden nicht gehört.${extra}`,
    es:
      ` Dispositivos oídos: ${heard}. La pasarela solo escucha un protocolo a la vez: ` +
      `${deaf} no se oirán.${extra}`,
  });
}

/**
 * "Devices heard" is a promise this line has to qualify.
 *
 * A shutter is heard the way a letterbox is heard: it is on the protocol being
 * listened to, and it never says anything. Nothing but the echo of Gladys' own
 * orders will ever come back on such a channel, and a report that stops at
 * "Devices heard: Baie vitree" reads as "everything is fine" to someone whose
 * wall remote has never once shown up.
 */
function describeEchoOnly(plan, language) {
  if (!plan.echoOnly) {
    return '';
  }
  return pick(language, {
    en:
      ' None of them emits by itself: shutters, switches and lamps are talked to, they do not ' +
      'talk. On this channel the box will only ever hear the echo of Gladys own orders. A wall ' +
      'remote has its own protocol and its own address: press it, then run this action again — ' +
      'if nothing shows up under "Heard", the box is not listening to ITS protocol.',
    fr:
      " Aucun de ces appareils n'émet de lui-même : volets, interrupteurs et lampes reçoivent " +
      'les ordres, ils ne parlent pas. Sur ce canal le boîtier n’entendra que l’écho des ordres ' +
      'de Gladys. Une télécommande murale, elle, a son propre protocole et sa propre adresse : ' +
      'appuyez dessus, puis relancez cette action — si rien n’apparaît dans « Entendu », c’est ' +
      "que le boîtier n'écoute pas SON protocole.",
    de:
      ' Keines davon sendet von selbst: Rollläden, Schalter und Lampen empfangen Befehle, sie ' +
      'sprechen nicht. Auf diesem Kanal hört die Box nur das Echo der Befehle von Gladys. Ein ' +
      'Wandsender hat sein eigenes Protokoll und seine eigene Adresse: Drücken Sie ihn und ' +
      'führen Sie diese Aktion erneut aus — erscheint unter „Gehört“ nichts, empfängt die Box ' +
      'nicht SEIN Protokoll.',
    es:
      ' Ninguno emite por sí mismo: persianas, interruptores y lámparas reciben órdenes, no ' +
      'hablan. En este canal la pasarela solo oirá el eco de las órdenes de Gladys. Un mando de ' +
      'pared tiene su propio protocolo y su propia dirección: púlselo y vuelva a ejecutar esta ' +
      'acción — si no aparece nada en «Oído», la pasarela no escucha SU protocolo.',
  });
}

/**
 * Remotes declared on another protocol than the one being listened to. Their
 * device is heard, so nothing above mentions them — and pressing them does
 * nothing, which is exactly what the user came to this screen to understand.
 */
function describeUnheardRemotes(plan, language) {
  const unheard = plan.unheardRemotes ?? [];
  if (unheard.length === 0) {
    return '';
  }
  const listed = unheard
    .slice(0, 5)
    .map(({ device, remote }) => `${device.name} (${describeRemote(remote)})`)
    .join(', ');
  const more = unheard.length > 5 ? ` (+${unheard.length - 5})` : '';
  // The value to type, spelled out: "their pid" is 1 for a remote of the
  // generic decoder, and the field reads 1 as "deduce".
  const typed = [...new Set(unheard.map(({ remote }) => channelToType(remote.id, language)))].join(
    pick(language, { en: ' or ', fr: ' ou ', de: ' oder ', es: ' o ' }),
  );
  return pick(language, {
    en:
      ` Remotes declared on another protocol, so never heard: ${listed}${more}. Fill in ` +
      `${typed} as the listening channel to listen to theirs instead.`,
    fr:
      ` Télécommandes déclarées sur un autre protocole, donc jamais entendues : ${listed}${more}. ` +
      `Renseignez ${typed} dans le canal d'écoute pour écouter le leur à la place.`,
    de:
      ` Fernbedienungen mit einem anderen Protokoll, daher nie gehört: ${listed}${more}. ` +
      `Tragen Sie ${typed} als Empfangskanal ein, um stattdessen ihres zu empfangen.`,
    es:
      ` Mandos declarados con otro protocolo, por lo que nunca se oyen: ${listed}${more}. ` +
      `Indique ${typed} como canal de escucha para escuchar el suyo en su lugar.`,
  });
}

/**
 * A remote of a `remotes` list: pid and address, or the pid alone for a remote
 * declared by its protocol only (`{ "pid": 14177 }`, the documented last
 * resort), which has no address to print.
 */
function describeRemote(remote) {
  if (remote.source === null || remote.source === undefined) {
    return `pid ${remote.id}`;
  }
  return `pid ${remote.id}, addr ${remote.source}`;
}

function names(devices) {
  const listed = devices
    .slice(0, 5)
    .map((device) => device.name)
    .join(', ');
  return devices.length > 5 ? `${listed} (+${devices.length - 5})` : listed;
}

/** How many emitters the report spells out before it counts the rest. */
const HEARD_SHOWN = 5;

/**
 * What the box has actually heard on the air, and what became of it.
 *
 * Everything above answers "can the frames get in?"; this answers "did they,
 * and did anything move?" — which is the question a user asks after attaching a
 * wall remote and watching nothing happen. Three answers, three different
 * problems, and until this line they were told apart by reading debug logs:
 *
 *   nothing heard          the box hears nothing on the protocol it listens to
 *   heard, undeclared      the emitter is real, it just belongs to no device
 *   heard, declared, mute  it reaches its device and carries no order to replay
 *
 * The registry is emptied by a restart, so a count of zero right after one
 * means "nothing since then", not "never" — hence the invitation to press the
 * remote and run the action again.
 *
 * @param {object} [tally] what reached the integration at all: `{ seen, own,
 *   dropped, lastDrop }` (see src/devmel/heard.js). Without it, an empty
 *   registry has only one thing to say, and it is the wrong thing half the
 *   time: "nothing heard" also covers the box that hears everything and has
 *   every frame thrown away on the way in.
 */
function describeHeard(config, entries, language, now = Date.now(), tally = null, table = null) {
  if (entries.length === 0) {
    return describeSilence(tally, language);
  }

  const listed = entries
    .slice(0, HEARD_SHOWN)
    .map((entry) => describeHeardEmitter(config, entry, now, language, table))
    .join(language === 'fr' ? ' ; ' : '; ');
  const more = entries.length > HEARD_SHOWN ? ` (+${entries.length - HEARD_SHOWN})` : '';
  const count = entries.length;
  const plural = count > 1;
  const tail = `${listed}${more}.${echoes(tally, language)}`;
  return pick(language, {
    en: `${count} emitter${plural ? 's' : ''} heard: ${tail}`,
    fr: `${count} émetteur${plural ? 's' : ''} entendu${plural ? 's' : ''} : ${tail}`,
    de: `${count} Sender gehört: ${tail}`,
    es: `${count} emisor${plural ? 'es' : ''} oído${plural ? 's' : ''}: ${tail}`,
  });
}

/**
 * The echoes of our own orders, counted apart from the emitters above.
 *
 * They are not emitters — Gladys is not a remote — but they are the proof that
 * the frames have a route back into the integration, and that proof used to be
 * printed only when the list was empty. Someone reading "1 emitter heard" needs
 * it just as much: it is what tells "my remote is unheard" from "nothing gets
 * in at all".
 */
function echoes(tally, language) {
  const own = Number(tally?.own) || 0;
  if (own === 0) {
    return '';
  }
  const plural = own > 1;
  return pick(language, {
    en:
      ` Plus ${own} echo${plural ? 'es' : ''} of your own orders: the route the frames take ` +
      'works.',
    fr:
      ` Plus ${own} écho${plural ? 's' : ''} de vos propres ordres : la route des trames ` +
      'fonctionne.',
    de:
      ` Dazu ${own} Echo${plural ? 's' : ''} Ihrer eigenen Befehle: Der Weg der Telegramme ` +
      'funktioniert.',
    es:
      ` Además, ${own} eco${plural ? 's' : ''} de sus propias órdenes: la ruta de las tramas ` +
      'funciona.',
  });
}

/**
 * An empty registry, and what it is worth knowing about it.
 *
 * "Nothing heard" is three different problems wearing the same face, and the
 * difference is upstream of the emitters: did anything arrive at all?
 *
 *   nothing arrived, not even our own echoes  no frame gets in — the box
 *                                             listens to the wrong protocol,
 *                                             or the subscription never took
 *   only our own echoes arrived               the route back works. The box
 *                                             simply hears nothing else on the
 *                                             protocol it is listening to
 *   frames arrived and were all dropped       the radio is alive and something
 *                                             threw the frames away (graded
 *                                             unreliable, error events)
 */
function describeSilence(tally, language) {
  const seen = Number(tally?.seen) || 0;
  const own = Number(tally?.own) || 0;
  const dropped = Number(tally?.dropped) || 0;

  if (dropped > 0) {
    const plural = dropped > 1 ? 's' : '';
    const last = tally.lastDrop;
    return pick(language, {
      en:
        `${dropped} frame${plural} arrived and ${dropped > 1 ? 'were' : 'was'} dropped before ` +
        `any device (last reason: ${last}). The radio works: it is the frames ` +
        'themselves that were not usable.',
      fr:
        `${dropped} trame${plural} reçue${plural} et écartée${plural} avant tout appareil ` +
        `(dernier motif : ${last}). La radio fonctionne : ce sont les trames ` +
        "elles-mêmes qui n'étaient pas exploitables.",
      de:
        `${dropped} Telegramm${dropped > 1 ? 'e' : ''} empfangen und vor jedem Gerät ` +
        `verworfen (letzter Grund: ${last}). Der Funk funktioniert: Die Telegramme selbst ` +
        'waren nicht verwertbar.',
      es:
        `${dropped} trama${plural} recibida${plural} y descartada${plural} antes de llegar a ` +
        `ningún dispositivo (último motivo: ${last}). La radio funciona: son las propias ` +
        'tramas las que no eran utilizables.',
    });
  }
  if (own > 0) {
    const plural = own > 1;
    return pick(language, {
      en:
        `no frame from any other emitter, but ${own} echo${plural ? 'es' : ''} of our own ` +
        'orders did come back: the route works, and the box hears nothing else on the protocol ' +
        'it listens to. Check the Listening line above: it must be the protocol of your remote.',
      fr:
        `aucune trame d'un autre émetteur, mais ${own} écho${plural ? 's' : ''} de vos propres ` +
        'ordres est bien revenu : la route des trames fonctionne, et le boîtier n’entend rien ' +
        "d'autre sur le protocole écouté. Vérifiez la ligne Écoute ci-dessus : c'est le " +
        'protocole de votre télécommande qu’il doit écouter.',
      de:
        `kein Telegramm eines anderen Senders, aber ${own} Echo${plural ? 's' : ''} Ihrer ` +
        'eigenen Befehle kam zurück: Der Weg funktioniert, und die Box hört auf dem ' +
        'empfangenen Protokoll nichts anderes. Prüfen Sie die Zeile Empfang oben: Es muss das ' +
        'Protokoll Ihrer Fernbedienung sein.',
      es:
        `ninguna trama de otro emisor, pero ${own} eco${plural ? 's' : ''} de sus propias ` +
        `órdenes sí ha${plural ? 'n' : ''} vuelto: la ruta funciona, y la pasarela no oye nada ` +
        'más en el protocolo que escucha. Compruebe la línea Escucha de arriba: debe ser el ' +
        'protocolo de su mando.',
    });
  }
  if (seen > 0) {
    return pick(language, {
      en: `${seen} frame(s) arrived, none of them usable.`,
      fr: `${seen} trame(s) reçue(s), aucune exploitable.`,
      de: `${seen} Telegramm(e) empfangen, keines verwertbar.`,
      es: `${seen} trama(s) recibida(s), ninguna utilizable.`,
    });
  }
  return pick(language, {
    en:
      'no radio frame since the integration started. Press the remote, then run this action ' +
      'again. If nothing shows up, drive a device from Gladys: the echo of that order should ' +
      'come back — if it does not either, the problem is the route the frames take, not the ' +
      'remote (see the Listening line above).',
    fr:
      'aucune trame radio depuis le démarrage de l’intégration. Appuyez sur la télécommande, ' +
      'puis relancez cette action. Si rien n’apparaît, actionnez un appareil depuis Gladys : ' +
      "l'écho de cet ordre doit, lui, revenir — s'il ne revient pas non plus, c'est la route " +
      'des trames qui est en cause, pas la télécommande (voir la ligne Écoute ci-dessus).',
    de:
      'kein Funktelegramm seit dem Start der Integration. Drücken Sie die Fernbedienung und ' +
      'führen Sie diese Aktion erneut aus. Erscheint nichts, steuern Sie ein Gerät aus Gladys: ' +
      'Das Echo dieses Befehls sollte zurückkommen — kommt auch das nicht, liegt das Problem ' +
      'beim Weg der Telegramme, nicht bei der Fernbedienung (siehe die Zeile Empfang oben).',
    es:
      'ninguna trama de radio desde que se inició la integración. Pulse el mando y vuelva a ' +
      'ejecutar esta acción. Si no aparece nada, accione un dispositivo desde Gladys: el eco de ' +
      'esa orden debería volver — si tampoco vuelve, el problema es la ruta de las tramas, no ' +
      'el mando (vea la línea Escucha de arriba).',
  });
}

/** Why its last frame went nowhere, when something did throw it away. */
function dropped(entry, language) {
  if (!entry.dropped) {
    return '';
  }
  return pick(language, {
    en: `, frame dropped: ${entry.dropped}`,
    fr: `, trame écartée : ${entry.dropped}`,
    de: `, Telegramm verworfen: ${entry.dropped}`,
    es: `, trama descartada: ${entry.dropped}`,
  });
}

/** One emitter of the registry, and what the devices made of its frames. */
function describeHeardEmitter(config, entry, now, language, table) {
  return (
    `${describeEmitter(entry, now, language, table)} — ` +
    `${describeFate(config, entry, language)}`
  );
}

/**
 * What happened to that emitter's frames: nobody claims them, a device follows
 * them, or a device claims them and can do nothing with them. The last case is
 * the one worth a whole line of its own — it is an attached remote that moves
 * nothing, and it looks exactly like a remote that was never attached.
 */
export function describeFate(config, entry, language) {
  const claimants = config.devmelDevices.filter((device) => hearsChannel(device, entry));
  // No address at all: the box picked the protocol up without decoding it, so
  // there is nothing to attach and nothing to publish. The fix is upstream —
  // listen to that protocol's own decoder — and it is the only advice that
  // works here, so it comes before everything else.
  //
  // Unless a device declares that protocol alone (`remotes: [{ "pid": X }]`,
  // the documented last resort once X is listened to): the frames are then
  // followed like any other, and advising the channel already set was wrong.
  if ((entry.source === null || entry.source === undefined) && claimants.length === 0) {
    const why = dropped(entry, language);
    const typed = channelToType(entry.id, language);
    return pick(language, {
      en:
        `the box did not decode this protocol (no address)${why}: set the ` +
        `listening channel to ${typed} so it listens on that protocol's own decoder`,
      fr:
        `le boîtier n'a pas décodé ce protocole (aucune adresse)${why} : ` +
        `renseignez ${typed} comme canal d'écoute pour qu'il l'écoute sur son propre décodeur`,
      de:
        `die Box hat dieses Protokoll nicht dekodiert (keine Adresse)${why}: Tragen Sie ` +
        `${typed} als Empfangskanal ein, damit sie es mit seinem eigenen Decoder empfängt`,
      es:
        `la pasarela no decodificó este protocolo (sin dirección)${why}: indique ${typed} ` +
        'como canal de escucha para que lo escuche con su propio decodificador',
    });
  }
  // What its frames did was established under the previous configuration (see
  // HeardChannels.forgetVerdicts): a remote heard before it was attached was
  // routed to nobody, and reading that as "carries no order" told the user
  // who had just attached it that it could not work. A drop too: attached by
  // its address, a remote is no longer dropped for its grade, and advising
  // "Accept unreliable frames" contradicted the attach answer just followed.
  if (entry.stale && claimants.length > 0) {
    const claimed = names(claimants);
    return pick(language, {
      en:
        `declared on ${claimed}, not heard since the configuration changed: press it to see ` +
        'whether it is followed',
      fr:
        `déclaré sur ${claimed}, pas entendu depuis le changement de configuration : ` +
        "appuyez dessus pour voir s'il est suivi",
      de:
        `angegeben bei ${claimed}, seit der Konfigurationsänderung nicht gehört: Drücken Sie ` +
        'ihn, um zu sehen, ob er befolgt wird',
      es:
        `declarado en ${claimed}, no oído desde el cambio de configuración: púlselo para ver ` +
        'si se sigue',
    });
  }
  // Dropped on the way in: no device ever saw it, so nothing below applies.
  // Worth naming — an emitter the box hears loud and clear and grades badly is
  // a radio problem (distance, interference), not a configuration one.
  if (entry.dropped) {
    return pick(language, {
      en:
        `its last frame was dropped before any device (${entry.dropped}): "Accept unreliable ` +
        'frames" lets them through',
      fr:
        `sa dernière trame a été écartée avant tout appareil (${entry.dropped}) : « Accepter ` +
        'les trames peu fiables » les laisse passer',
      de:
        `sein letztes Telegramm wurde vor jedem Gerät verworfen (${entry.dropped}): ` +
        '„Unzuverlässige Telegramme akzeptieren“ lässt sie durch',
      es:
        `su última trama se descartó antes de llegar a ningún dispositivo (${entry.dropped}): ` +
        '«Aceptar tramas poco fiables» las deja pasar',
    });
  }
  if (claimants.length === 0) {
    return pick(language, {
      en: 'no device declares it: "Attach a remote" writes the line for you',
      fr: 'aucun appareil ne le déclare : « Rattacher une télécommande » écrit la ligne',
      de: 'kein Gerät gibt ihn an: „Fernbedienung zuordnen“ schreibt die Zeile für Sie',
      es: 'ningún dispositivo lo declara: «Asociar un mando» le escribe la línea',
    });
  }
  const claimed = names(claimants);
  if (entry.understood) {
    const oneNote = describeOneNote(entry, claimants, language);
    return pick(language, {
      en: `followed by ${claimed}${oneNote}`,
      fr: `suivi par ${claimed}${oneNote}`,
      de: `befolgt von ${claimed}${oneNote}`,
      es: `seguido por ${claimed}${oneNote}`,
    });
  }
  // Decoded fine, into readings the device does not declare (a weather sensor
  // pasted from the airsend.cloud export, which carries no `features`).
  if (entry.undeclared?.length > 0) {
    const features = entry.undeclared.map((feature) => `"${feature}"`).join(', ');
    return pick(language, {
      en:
        `declared on ${claimed}, which does not declare what it decoded: add ${features} to ` +
        'its "features"',
      fr:
        `déclaré sur ${claimed}, qui ne déclare pas ce qu'il a décodé : ajoutez ${features} ` +
        'à ses « features »',
      de:
        `angegeben bei ${claimed}, das nicht angibt, was dekodiert wurde: Fügen Sie ${features} ` +
        'zu seinen „features“ hinzu',
      es:
        `declarado en ${claimed}, que no declara lo que se decodificó: añada ${features} a ` +
        'sus «features»',
    });
  }
  // Decoded to an order all the same (a TOGGLE heard by a switch): the
  // protocol is fine, the device type or the remote attached is not, and
  // pointing at partial decoding sent the user after the wrong fix.
  if (ordersOf(entry.readings).length > 0) {
    return pick(language, {
      en:
        `declared on ${claimed}, which does nothing with the order decoded: check the type ` +
        'declared on airsend.cloud (a remote sending TOGGLE drives a Button, type 4096), or ' +
        'that the right remote is attached',
      fr:
        `déclaré sur ${claimed}, qui ne fait rien de l'ordre décodé : vérifiez le type ` +
        'déclaré sur airsend.cloud (une télécommande qui envoie TOGGLE commande un Bouton, ' +
        'type 4096), ou que la bonne télécommande est rattachée',
      de:
        `angegeben bei ${claimed}, das mit dem dekodierten Befehl nichts anfängt: Prüfen Sie ` +
        'den auf airsend.cloud angegebenen Typ (eine Fernbedienung, die TOGGLE sendet, steuert ' +
        'einen Taster, Typ 4096) oder ob die richtige Fernbedienung zugeordnet ist',
      es:
        `declarado en ${claimed}, que no hace nada con la orden decodificada: compruebe el ` +
        'tipo declarado en airsend.cloud (un mando que envía TOGGLE controla un Botón, tipo ' +
        '4096) o que el mando asociado sea el correcto',
    });
  }
  return pick(language, {
    en:
      `declared on ${claimed}, but its frames carry no order to replay (a protocol the service ` +
      'only partially decodes): the position cannot follow',
    fr:
      `déclaré sur ${claimed}, mais ses trames ne portent aucun ordre rejouable (protocole ` +
      'seulement partiellement décodé) : la position ne peut pas suivre',
    de:
      `angegeben bei ${claimed}, aber seine Telegramme tragen keinen wiederholbaren Befehl ` +
      '(ein Protokoll, das der Dienst nur teilweise dekodiert): Die Position kann nicht folgen',
    es:
      `declarado en ${claimed}, pero sus tramas no llevan ninguna orden reproducible (un ` +
      'protocolo que el servicio solo decodifica en parte): la posición no puede seguir',
  });
}

/**
 * Several frames, one and the same order.
 *
 * "Followed by Baie vitrée" reads as a success, and it is one — the frame
 * arrives, the device acts on it. But a remote whose every press decodes to the
 * same note moves nothing anybody can see: a STOP replayed on a shutter that is
 * not moving changes a state and not one percent of position. That is a decoder
 * that only half understands the remote, and from the sofa it is
 * indistinguishable from a remote that was never attached.
 *
 * Said as the check to run rather than as a verdict: a user who has only ever
 * pressed one button has one note too, and the answer is the same either way.
 */
function describeOneNote(entry, claimants, language) {
  if (entry.frames < 3 || entry.notes?.size !== 1) {
    return '';
  }
  // A Button only ever hears one order (a spare remote sending TOGGLE), and
  // that is all a scene trigger needs: nothing here is half understood.
  if (claimants.every((device) => device.rtype === DEVICE_TYPES.BUTTON)) {
    return '';
  }
  const note = [...entry.notes][0];
  return pick(language, {
    en:
      `, but every one of its frames carries the same order (${note}): press Open, then Close, ` +
      'and run this action again. If the note does not change, the AirSend service does not ' +
      'decode the buttons of that remote — the position cannot follow',
    fr:
      `, mais toutes ses trames portent le même ordre (${note}) : appuyez sur Ouvrir, puis sur ` +
      'Fermer, et relancez cette action. Si la note ne change pas, le service AirSend ne ' +
      'décode pas les boutons de cette télécommande — la position ne pourra pas suivre',
    de:
      `, aber jedes seiner Telegramme trägt denselben Befehl (${note}): Drücken Sie Öffnen, ` +
      'dann Schließen, und führen Sie diese Aktion erneut aus. Ändert sich die Note nicht, ' +
      'dekodiert der AirSend-Dienst die Tasten dieser Fernbedienung nicht — die Position kann ' +
      'nicht folgen',
    es:
      `, pero todas sus tramas llevan la misma orden (${note}): pulse Abrir, luego Cerrar, y ` +
      'vuelva a ejecutar esta acción. Si la nota no cambia, el servicio AirSend no decodifica ' +
      'los botones de ese mando — la posición no podrá seguir',
  });
}

/**
 * Why the bundled service is not serving the local channel, or null when it is
 * (or when the user chose a service of their own, which is none of our
 * business).
 */
function embeddedServiceError(config, service) {
  if (!config.embeddedService || !service) {
    return null;
  }
  const status = service.status();
  if (status.running) {
    return null;
  }
  return status.error ?? 'not started';
}

function summarize(config, language) {
  const devices = config.devmelDevices;
  if (devices.length === 0) {
    return pick(language, {
      en: 'no device parsed (check the pasted list).',
      fr: 'aucun appareil lu (vérifiez la liste collée).',
      de: 'kein Gerät gelesen (prüfen Sie die eingefügte Liste).',
      es: 'ningún dispositivo leído (compruebe la lista pegada).',
    });
  }
  const names = devices
    .slice(0, 5)
    .map((device) => device.name)
    .join(', ');
  const more = devices.length > 5 ? ` (+${devices.length - 5})` : '';
  const count = devices.length;
  return pick(language, {
    en: `${count} parsed: ${names}${more}.`,
    fr: `${count} lu(s) : ${names}${more}.`,
    de: `${count} gelesen: ${names}${more}.`,
    es: `${count} leído(s): ${names}${more}.`,
  });
}
