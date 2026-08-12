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
  if (!config.spurl || !config.service_url) {
    return [];
  }
  return [
    {
      name: 'AirSend box',
      rtype: DEVICE_TYPES.BOX,
      platformId: 'airsend-box',
      channel: { id: 1 },
      spurl: config.spurl,
      apiKey: null,
      id: null,
    },
  ];
}

/**
 * Status published through `setConnectionStatus`: connected as soon as one of
 * the two channels can carry a command, with a message explaining what is
 * missing otherwise.
 */
export async function describeConnection(client, config) {
  const hasLocal = Boolean(config.service_url && config.spurl);
  const hasCloud = Boolean(config.api_key);

  if (!hasLocal && !hasCloud) {
    return {
      connected: false,
      message: {
        en: 'Not configured yet: fill in the AirSend Web Service URL and its connection string, or an airsend.cloud API key.',
        fr: "Pas encore configuré : renseignez l'URL du service AirSend et sa chaîne de connexion, ou une clé d'API airsend.cloud.",
      },
    };
  }

  if (hasLocal) {
    try {
      await client.pingLocal();
      return { connected: true };
    } catch (err) {
      if (hasCloud) {
        return {
          connected: true,
          message: {
            en: `Local box unreachable (${err.message}); commands go through airsend.cloud.`,
            fr: `Boîtier local injoignable (${err.message}) ; les commandes passent par airsend.cloud.`,
          },
        };
      }
      return {
        connected: false,
        message: {
          en: `AirSend Web Service unreachable: ${err.message}`,
          fr: `Service AirSend injoignable : ${err.message}`,
        },
      };
    }
  }

  return { connected: true };
}

/**
 * Handler of the `test_connection` manifest action: report both channels and
 * what was understood from the device list, which is the fastest way to spot a
 * mistyped connection string or a device list that did not parse.
 */
export async function testConnection(client, config) {
  const en = [];
  const fr = [];

  if (config.service_url && config.spurl) {
    try {
      await client.pingLocal();
      en.push(`Local: AirSend Web Service reachable at ${config.service_url}.`);
      fr.push(`Local : service AirSend joignable sur ${config.service_url}.`);
    } catch (err) {
      en.push(`Local: unreachable (${err.message}).`);
      fr.push(`Local : injoignable (${err.message}).`);
    }
  } else {
    en.push('Local: not configured (URL and connection string required).');
    fr.push('Local : non configuré (URL et chaîne de connexion requises).');
  }

  if (config.api_key) {
    const withId = config.devmelDevices.filter((device) => device.id).length;
    en.push(`Cloud: API key set, ${withId} device(s) with an airsend.cloud id.`);
    fr.push(
      `Cloud : clé d'API renseignée, ${withId} appareil(s) avec un identifiant airsend.cloud.`,
    );
  } else {
    en.push('Cloud: no API key, no fallback if the box is unreachable.');
    fr.push("Cloud : pas de clé d'API, aucun repli si le boîtier est injoignable.");
  }

  en.push(`Devices: ${summarize(config, 'en')}`);
  fr.push(`Appareils : ${summarize(config, 'fr')}`);

  return { en: en.join('\n'), fr: fr.join('\n') };
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
