// -----------------------------------------------------------------------------
// The "attach a remote" action: writing the configuration line for the user.
//
// Attaching the wall remote of a shutter is a two-line job that nobody gets
// right on the first try: read a pid/addr pair out of a log line, decide
// whether it goes in as a bare address or as a `{pid, addr}` pair (it depends
// on whether the remote speaks the protocol of the device it drives), and edit
// a one-line JSON blob by hand without breaking the rest of it.
//
// None of that requires the user: the integration heard the frame (see
// heard.js), it holds the list they pasted, and it knows which device they
// picked. So it writes the new line itself — the same list, same shape, same
// fields, plus the remote — and the user pastes it back.
// -----------------------------------------------------------------------------

import { channelOfEntry, parseDeviceEntries } from '../config.js';
import { isSameChannel } from './notes.js';
import { describeEmitter } from './heard.js';
import { hearsChannel } from '../devices/index.js';

/**
 * Add an emitter to the `remotes` of one device, inside the very list the user
 * pasted.
 *
 * @param {string|object} source the `devices` field, as typed
 * @param {object} device the normalized device it drives
 * @param {{id: number, source: number}} remote the emitter heard
 * @returns {?string} the new list, on one line, or null when the device could
 *   not be found in the pasted list (it no longer describes what is configured)
 */
export function attachRemote(source, device, remote) {
  const parsed = parseDeviceEntries(source);
  if (!parsed) {
    return null;
  }
  const found = parsed.entries.find(([name, entry]) => {
    const channel = channelOfEntry(entry);
    // The channel is what identifies a device; the name is what identifies it
    // in a list keyed by name, where the entry itself may carry no channel at
    // all (a box) and no `name` field either.
    return channel ? isSameChannel(channel, device.channel) : name === device.name;
  });
  if (!found) {
    return null;
  }

  const entry = found[1];
  const declared = Array.isArray(entry.remotes) ? entry.remotes : [];
  const already = declared.some((known) =>
    isSameChannel(asChannel(known, device), { id: remote.id, source: remote.source }),
  );
  if (!already) {
    // Always the explicit `{pid, addr}` pair, never the bare address: it says
    // what it means whatever protocol the remote speaks, and a bare address
    // read on the wrong protocol is the mistake this action exists to avoid.
    // An emitter the box never gave an address for has only its protocol to be
    // named by — and that is exactly what the line then says.
    entry.remotes = [
      ...declared,
      hasAddress(remote) ? { pid: remote.id, addr: remote.source } : { pid: remote.id },
    ];
  }
  return JSON.stringify(parsed.root);
}

/**
 * A remote already declared, in any of its spellings, as a channel: a bare
 * address is read on the protocol of the device itself, exactly as the
 * configuration reads it (see `normalizeRemotes`).
 */
function asChannel(declared, device) {
  const flat = declared !== null && typeof declared === 'object' ? declared : { addr: declared };
  const address = flat.addr ?? flat.source ?? flat.address;
  return {
    id: Number(flat.pid ?? flat.id ?? flat.channelId ?? flat.channel_id ?? device.channel?.id),
    // Left undefined rather than turned into NaN: a remote declared by its
    // protocol alone must compare equal to the address-less emitter it names.
    source: address === undefined || address === null ? undefined : Number(address),
  };
}

/** Did the box decode an address for this emitter, or only its protocol? */
function hasAddress(remote) {
  return remote?.source !== null && remote?.source !== undefined;
}

/**
 * The emitters heard that no configured device claims: the wall remote just
 * pressed, and whatever else the neighbourhood emits on the same protocol.
 *
 * @returns {Array<object>} entries of the registry, most recently heard first
 */
export function unclaimedEmitters(config, heard) {
  return heard
    .list()
    .filter((entry) => !config.devmelDevices.some((device) => hearsChannel(device, entry)));
}

/**
 * Handler of the `attach_remote` manifest action: attach the emitter heard
 * last to the device the user picked, and hand back the line to paste.
 *
 * It deliberately stops at the line instead of writing the configuration
 * itself: the `devices` field is the user's own text, and an integration that
 * rewrites it behind their back is an integration nobody can trust with it.
 *
 * @param {Map<number, object>} [table] the protocol table, so the emitter is
 *   named by its protocol and not by a bare number
 * @returns {{en: string, fr: string}} what the Configuration screen shows
 */
export function attachHeardRemote({ config, device, heard, now = Date.now(), table = null }) {
  const candidates = unclaimedEmitters(config, heard);

  if (!device) {
    return {
      en: 'Pick the device this remote drives: the shutter it opens, the light it switches.',
      fr: 'Choisissez l’appareil que pilote cette télécommande : le volet qu’elle ouvre, la lampe qu’elle allume.',
    };
  }

  if (candidates.length === 0) {
    return heard.list().length === 0 ? nothingHeard() : everythingClaimed(config);
  }

  const remote = candidates[0];
  const line = attachRemote(config.devices, device, remote);
  if (!line) {
    return {
      en:
        `Heard ${describeEmitter(remote, now, 'en', table)}, but "${device.name}" is not in the device ` +
        'list as it is pasted right now. Save the list again, then run this action.',
      fr:
        `Télécommande entendue : ${describeEmitter(remote, now, 'fr', table)}, mais « ${device.name} » ` +
        "ne figure pas dans la liste d'appareils telle qu'elle est collée. Enregistrez la liste, " +
        'puis relancez cette action.',
    };
  }

  const en = [
    `Heard ${describeEmitter(remote, now, 'en', table)}.`,
    `Attached to "${device.name}". Paste this line into the Devices field, then save:`,
    line,
  ];
  const fr = [
    `Télécommande entendue : ${describeEmitter(remote, now, 'fr', table)}.`,
    `Rattachée à « ${device.name} ». Collez cette ligne dans le champ Appareils, puis enregistrez :`,
    line,
  ];

  // The box has one radio: a remote on another protocol than the device it
  // drives is heard INSTEAD of it, never as well. Said here, where the user is
  // about to create exactly that situation.
  if (Number(remote.id) !== Number(device.channel?.id)) {
    en.push(
      `That remote speaks another protocol (pid ${remote.id}) than "${device.name}" ` +
        `(pid ${device.channel?.id}), and the box listens to one protocol at a time. Run "Test ` +
        'the connection" afterwards: the Listening line says which one is heard.',
    );
    fr.push(
      `Elle émet sur un autre protocole (pid ${remote.id}) que « ${device.name} » ` +
        `(pid ${device.channel?.id}), et le boîtier n'écoute qu'un protocole à la fois. Lancez ` +
        '« Tester la connexion » ensuite : la ligne Écoute dit lequel est entendu.',
    );
  }

  // The box heard the protocol and nothing else. The line above is still worth
  // pasting — it is the only way those frames reach a device — but what it
  // attaches is a protocol, not one remote, and that has to be said before it
  // surprises anyone.
  if (!hasAddress(remote)) {
    en.push(
      `The box decoded no address for it, only protocol ${remote.id}: that line makes ` +
        `"${device.name}" follow EVERY frame of that protocol the box cannot attribute, a ` +
        "neighbour's remote included. It is the last resort — first set the listening channel " +
        `to ${remote.id}, which is how the box is told to decode that protocol properly.`,
    );
    fr.push(
      `Le boîtier n'en a décodé aucune adresse, seulement le protocole ${remote.id} : cette ligne ` +
        `fait suivre à « ${device.name} » TOUTES les trames de ce protocole que le boîtier ` +
        "n'attribue à personne, celles d'un voisin comprises. C'est le dernier recours : " +
        `renseignez d'abord ${remote.id} comme canal d'écoute, c'est ainsi qu'on demande au ` +
        'boîtier de décoder ce protocole correctement.',
    );
  }

  if (remote.claimed === false && remote.understood === false && remote.readings?.length === 0) {
    en.push(
      'Its frames carry no note the service could decode: attaching it makes the emitter known, ' +
        'but a partially decoded protocol carries no order to replay, so the device state will ' +
        'not follow.',
    );
    fr.push(
      'Ses trames ne portent aucune note décodable par le service : le rattachement fait ' +
        "connaître l'émetteur, mais un protocole partiellement décodé ne porte aucun ordre à " +
        "rejouer, l'état de l'appareil ne suivra donc pas.",
    );
  }

  const others = candidates.slice(1);
  if (others.length > 0) {
    const listed = others.map((entry) => describeEmitter(entry, now, 'en', table)).join('; ');
    en.push(`Other emitters heard, left out: ${listed}.`);
    fr.push(
      `Autres émetteurs entendus, non rattachés : ${others
        .map((entry) => describeEmitter(entry, now, 'fr', table))
        .join(' ; ')}.`,
    );
  }

  return { en: en.join('\n'), fr: fr.join('\n') };
}

function nothingHeard() {
  return {
    en:
      'No radio frame heard yet. Press the remote you want to attach, then run this action ' +
      'again. If nothing is ever heard, the box is listening to another protocol: "Test the ' +
      'connection" says which one.',
    fr:
      "Aucune trame radio entendue pour l'instant. Appuyez sur la télécommande à rattacher, puis " +
      "relancez cette action. Si rien n'est jamais entendu, le boîtier écoute un autre " +
      'protocole : « Tester la connexion » dit lequel.',
  };
}

function everythingClaimed(config) {
  const declared = config.devmelDevices.length;
  return {
    en:
      'Every emitter heard is already declared: nothing left to attach. Press the remote you ' +
      `are after and run this action again — ${declared} device(s) are configured.`,
    fr:
      'Tous les émetteurs entendus sont déjà déclarés : il n’y a rien à rattacher. Appuyez sur ' +
      `la télécommande visée puis relancez cette action — ${declared} appareil(s) configuré(s).`,
  };
}
