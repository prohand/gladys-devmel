// -----------------------------------------------------------------------------
// Connection state: what the Configuration screen shows.
//
// Two things live here because both answer the same question — "can this
// integration reach the hardware right now?":
//   - the status published after every (re)initialization;
//   - the "Test the connection" manifest action, which says the same thing on
//     demand, in more detail.
// -----------------------------------------------------------------------------

import { DEVICE_TYPES } from '../config.js';
import { planListening } from './listening.js';
import { describeEmitter } from './heard.js';
import { hearsChannel } from '../devices/index.js';

/**
 * The AirSend boxes to talk to when listening for radio frames.
 *
 * A box declared in the device list wins (it may carry its own connection
 * string); when the user only filled the global credentials, the box is
 * implicit and rebuilt here.
 */
export function boxDevices(config) {
  const boxes = config.devmelDevices.filter((device) => device.rtype === DEVICE_TYPES.BOX);
  if (boxes.length > 0) {
    return boxes;
  }
  if (!config.spurl || !config.effectiveServiceUrl) {
    return [];
  }
  return [
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
          }
        : {
            en: 'Not configured yet: fill in the AirSend Web Service URL and its connection string.',
            fr: "Pas encore configuré : renseignez l'URL du service AirSend et sa chaîne de connexion.",
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
 */
export async function testConnection(client, config, service = null, listen = null, heard = null) {
  const en = [];
  const fr = [];

  const where = config.embeddedService
    ? { en: 'built-in service', fr: 'service intégré' }
    : { en: 'service', fr: 'service' };

  const serviceError = embeddedServiceError(config, service);
  if (serviceError) {
    en.push(`Service: the built-in AirSend service is not running (${serviceError}).`);
    fr.push(`Service : le service AirSend intégré ne tourne pas (${serviceError}).`);
  }

  if (config.effectiveServiceUrl && config.spurl) {
    try {
      await client.pingLocal();
      en.push(`Local: AirSend ${where.en} reachable at ${config.effectiveServiceUrl}.`);
      fr.push(`Local : ${where.fr} AirSend joignable sur ${config.effectiveServiceUrl}.`);
    } catch (err) {
      en.push(`Local: unreachable (${err.message}).`);
      fr.push(`Local : injoignable (${err.message}).`);
    }
  } else if (!config.effectiveServiceUrl) {
    en.push('Local: disabled (no AirSend service, built-in one turned off).');
    fr.push('Local : désactivé (aucun service AirSend, service intégré désactivé).');
  } else {
    en.push('Local: no connection string yet (the sp:// URL exported by airsend.cloud).');
    fr.push(
      "Local : pas encore de chaîne de connexion (l'URL sp:// exportée depuis airsend.cloud).",
    );
  }

  en.push(`Listening: ${describeListening(config, listen, 'en')}`);
  fr.push(`Écoute : ${describeListening(config, listen, 'fr')}`);

  // Omitted rather than apologized for when no registry was handed over: the
  // running integration always passes one, and a report line about a missing
  // internal is a line that helps nobody.
  if (typeof heard?.list === 'function') {
    const now = Date.now();
    en.push(`Heard: ${describeHeard(config, heard.list(), 'en', now, heard)}`);
    fr.push(`Entendu : ${describeHeard(config, heard.list(), 'fr', now, heard)}`);
  }

  en.push(`Devices: ${summarize(config, 'en')}`);
  fr.push(`Appareils : ${summarize(config, 'fr')}`);

  return { en: en.join('\n'), fr: fr.join('\n') };
}

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
    return language === 'fr'
      ? "désactivée (canal d'écoute à 0)."
      : 'disabled (listening channel set to 0).';
  }

  const channel = describeChannel(plan, language);
  const coverage = describeCoverage(plan, language);

  if (listen?.error) {
    return language === 'fr'
      ? `${channel} : le boîtier a refusé l'abonnement (${listen.error}).`
      : `${channel}: the box refused the subscription (${listen.error}).`;
  }
  if (listen?.url) {
    return language === 'fr'
      ? `${channel}, trames poussées vers ${listen.url}.${coverage}`
      : `${channel}, frames pushed to ${listen.url}.${coverage}`;
  }
  // No route at all. With the bundled service that never happens (the loopback
  // callback is always there); with a service of the user's own it does, and
  // the relay is then the only way back in.
  return language === 'fr'
    ? `${channel} : aucune route pour les trames. Un service AirSend que vous ` +
        'faites tourner ailleurs ne peut pas joindre cette intégration directement : ' +
        'liez Gladys Plus pour recevoir les trames.'
    : `${channel}: no route for the frames. An AirSend service you run ` +
        'elsewhere cannot reach this integration directly: link Gladys Plus to ' +
        'receive them.';
}

/** The protocol being listened to, named when the service knows its name. */
function describeChannel(plan, language) {
  const name = plan.name ? ` "${plan.name}"` : '';
  // Where the channel comes from, but only when the device list had a say: a
  // deduction made without a single device is just the generic decoder.
  const deduced = plan.deduced && plan.covered.length + plan.uncovered.length > 0;
  const how = deduced
    ? language === 'fr'
      ? ' (déduit de vos appareils)'
      : ' (deduced from your devices)'
    : '';
  return language === 'fr'
    ? `canal ${plan.channel}${name}${how}`
    : `channel ${plan.channel}${name}${how}`;
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
    return language === 'fr'
      ? " Aucun appareil radio déclaré : c'est l'écoute générique 433 MHz par défaut, " +
          'sourde aux protocoles 868 MHz (Profalux, Somfy io). Déclarez un appareil sur ' +
          "ce protocole, ou renseignez son pid dans le canal d'écoute."
      : ' No radio device declared: this is the default generic 433 MHz listening, ' +
          'deaf to 868 MHz protocols (Profalux, Somfy io). Declare a device on that ' +
          'protocol, or fill in its pid as the listening channel.';
  }
  const heard = names(plan.covered);
  const extra = `${describeEchoOnly(plan, language)}${describeUnheardRemotes(plan, language)}`;
  if (plan.uncovered.length === 0) {
    return language === 'fr'
      ? ` Appareils entendus : ${heard}.${extra}`
      : ` Devices heard: ${heard}.${extra}`;
  }
  const deaf = names(plan.uncovered);
  if (plan.covered.length === 0) {
    return language === 'fr'
      ? ` Aucun appareil déclaré n'émet sur ce protocole : ${deaf} ne ` +
          "seront pas entendus. Videz le canal d'écoute pour le déduire de vos appareils."
      : ` No declared device speaks this protocol: ${deaf} will not be heard. ` +
          'Clear the listening channel to deduce it from your devices.';
  }
  return language === 'fr'
    ? ` Appareils entendus : ${heard}. Le boîtier n'écoute qu'un protocole à la ` +
        `fois : ${deaf} ne seront pas entendus.${extra}`
    : ` Devices heard: ${heard}. The box listens to one protocol at a time: ` +
        `${deaf} will not be heard.${extra}`;
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
  return language === 'fr'
    ? " Aucun de ces appareils n'émet de lui-même : volets, interrupteurs et lampes reçoivent " +
        'les ordres, ils ne parlent pas. Sur ce canal le boîtier n’entendra que l’écho des ordres ' +
        'de Gladys. Une télécommande murale, elle, a son propre protocole et sa propre adresse : ' +
        'appuyez dessus, puis relancez cette action — si rien n’apparaît dans « Entendu », c’est ' +
        "que le boîtier n'écoute pas SON protocole."
    : ' None of them emits by itself: shutters, switches and lamps are talked to, they do not ' +
        'talk. On this channel the box will only ever hear the echo of Gladys own orders. A wall ' +
        'remote has its own protocol and its own address: press it, then run this action again — ' +
        'if nothing shows up under "Heard", the box is not listening to ITS protocol.';
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
    .map(({ device, remote }) => `${device.name} (pid ${remote.id}, addr ${remote.source})`)
    .join(', ');
  const more = unheard.length > 5 ? ` (+${unheard.length - 5})` : '';
  return language === 'fr'
    ? ` Télécommandes déclarées sur un autre protocole, donc jamais entendues : ${listed}${more}. ` +
        "Renseignez leur pid dans le canal d'écoute pour écouter le leur à la place."
    : ` Remotes declared on another protocol, so never heard: ${listed}${more}. Fill in their ` +
        'pid as the listening channel to listen to theirs instead.';
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
function describeHeard(config, entries, language, now = Date.now(), tally = null) {
  if (entries.length === 0) {
    return describeSilence(tally, language);
  }

  const listed = entries
    .slice(0, HEARD_SHOWN)
    .map((entry) => describeHeardEmitter(config, entry, now, language))
    .join(language === 'fr' ? ' ; ' : '; ');
  const more = entries.length > HEARD_SHOWN ? ` (+${entries.length - HEARD_SHOWN})` : '';
  const plural = entries.length > 1 ? 's' : '';
  return language === 'fr'
    ? `${entries.length} émetteur${plural} entendu${plural} : ${listed}${more}.${echoes(tally, language)}`
    : `${entries.length} emitter${plural} heard: ${listed}${more}.${echoes(tally, language)}`;
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
  return language === 'fr'
    ? ` Plus ${own} écho${own > 1 ? 's' : ''} de vos propres ordres : la route des trames ` +
        'fonctionne.'
    : ` Plus ${own} echo${own > 1 ? 'es' : ''} of your own orders: the route the frames take ` +
        'works.';
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
    return language === 'fr'
      ? `${dropped} trame${plural} reçue${plural} et écartée${plural} avant tout appareil ` +
          `(dernier motif : ${tally.lastDrop}). La radio fonctionne : ce sont les trames ` +
          "elles-mêmes qui n'étaient pas exploitables."
      : `${dropped} frame${plural} arrived and ${dropped > 1 ? 'were' : 'was'} dropped before ` +
          `any device (last reason: ${tally.lastDrop}). The radio works: it is the frames ` +
          'themselves that were not usable.';
  }
  if (own > 0) {
    return language === 'fr'
      ? `aucune trame d'un autre émetteur, mais ${own} écho${own > 1 ? 's' : ''} de vos propres ` +
          'ordres est bien revenu : la route des trames fonctionne, et le boîtier n’entend rien ' +
          "d'autre sur le protocole écouté. Vérifiez la ligne Écoute ci-dessus : c'est le " +
          'protocole de votre télécommande qu’il doit écouter.'
      : `no frame from any other emitter, but ${own} echo${own > 1 ? 'es' : ''} of our own ` +
          'orders did come back: the route works, and the box hears nothing else on the protocol ' +
          'it listens to. Check the Listening line above: it must be the protocol of your remote.';
  }
  if (seen > 0) {
    return language === 'fr'
      ? `${seen} trame(s) reçue(s), aucune exploitable.`
      : `${seen} frame(s) arrived, none of them usable.`;
  }
  return language === 'fr'
    ? 'aucune trame radio depuis le démarrage de l’intégration. Appuyez sur la télécommande, ' +
        'puis relancez cette action. Si rien n’apparaît, actionnez un appareil depuis Gladys : ' +
        "l'écho de cet ordre doit, lui, revenir — s'il ne revient pas non plus, c'est la route " +
        'des trames qui est en cause, pas la télécommande (voir la ligne Écoute ci-dessus).'
    : 'no radio frame since the integration started. Press the remote, then run this action ' +
        'again. If nothing shows up, drive a device from Gladys: the echo of that order should ' +
        'come back — if it does not either, the problem is the route the frames take, not the ' +
        'remote (see the Listening line above).';
}

/** Why its last frame went nowhere, when something did throw it away. */
function dropped(entry, language) {
  if (!entry.dropped) {
    return '';
  }
  return language === 'fr'
    ? `, trame écartée : ${entry.dropped}`
    : `, frame dropped: ${entry.dropped}`;
}

/** One emitter of the registry, and what the devices made of its frames. */
function describeHeardEmitter(config, entry, now, language) {
  return `${describeEmitter(entry, now, language)} — ${describeFate(config, entry, language)}`;
}

/**
 * What happened to that emitter's frames: nobody claims them, a device follows
 * them, or a device claims them and can do nothing with them. The last case is
 * the one worth a whole line of its own — it is an attached remote that moves
 * nothing, and it looks exactly like a remote that was never attached.
 */
function describeFate(config, entry, language) {
  // No address at all: the box picked the protocol up without decoding it, so
  // there is nothing to attach and nothing to publish. The fix is upstream —
  // listen to that protocol's own decoder — and it is the only advice that
  // works here, so it comes before everything else.
  if (entry.source === null || entry.source === undefined) {
    return language === 'fr'
      ? `le boîtier n'a pas décodé ce protocole (aucune adresse)${dropped(entry, language)} : ` +
          `renseignez ${entry.id} comme canal d'écoute pour qu'il l'écoute sur son propre décodeur`
      : `the box did not decode this protocol (no address)${dropped(entry, language)}: set the ` +
          `listening channel to ${entry.id} so it listens on that protocol's own decoder`;
  }
  // Dropped on the way in: no device ever saw it, so nothing below applies.
  // Worth naming — an emitter the box hears loud and clear and grades badly is
  // a radio problem (distance, interference), not a configuration one.
  if (entry.dropped) {
    return language === 'fr'
      ? `sa dernière trame a été écartée avant tout appareil (${entry.dropped}) : « Accepter ` +
          'les trames peu fiables » les laisse passer'
      : `its last frame was dropped before any device (${entry.dropped}): "Accept unreliable ` +
          'frames" lets them through';
  }
  const claimants = config.devmelDevices.filter((device) => hearsChannel(device, entry));
  if (claimants.length === 0) {
    return language === 'fr'
      ? 'aucun appareil ne le déclare : « Rattacher une télécommande » écrit la ligne'
      : 'no device declares it: "Attach a remote" writes the line for you';
  }
  const claimed = names(claimants);
  if (entry.understood) {
    return language === 'fr'
      ? `suivi par ${claimed}${describeOneNote(entry, language)}`
      : `followed by ${claimed}${describeOneNote(entry, language)}`;
  }
  return language === 'fr'
    ? `déclaré sur ${claimed}, mais ses trames ne portent aucun ordre rejouable (protocole ` +
        'seulement partiellement décodé) : la position ne peut pas suivre'
    : `declared on ${claimed}, but its frames carry no order to replay (a protocol the service ` +
        'only partially decodes): the position cannot follow';
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
function describeOneNote(entry, language) {
  if (entry.frames < 3 || entry.notes?.size !== 1) {
    return '';
  }
  const note = [...entry.notes][0];
  return language === 'fr'
    ? `, mais toutes ses trames portent le même ordre (${note}) : appuyez sur Ouvrir, puis sur ` +
        'Fermer, et relancez cette action. Si la note ne change pas, le service AirSend ne ' +
        'décode pas les boutons de cette télécommande — la position ne pourra pas suivre'
    : `, but every one of its frames carries the same order (${note}): press Open, then Close, ` +
        'and run this action again. If the note does not change, the AirSend service does not ' +
        'decode the buttons of that remote — the position cannot follow';
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
    return language === 'fr'
      ? 'aucun appareil lu (vérifiez la liste collée).'
      : 'no device parsed (check the pasted list).';
  }
  const names = devices
    .slice(0, 5)
    .map((device) => device.name)
    .join(', ');
  const more = devices.length > 5 ? ` (+${devices.length - 5})` : '';
  return language === 'fr'
    ? `${devices.length} lu(s) : ${names}${more}.`
    : `${devices.length} parsed: ${names}${more}.`;
}
