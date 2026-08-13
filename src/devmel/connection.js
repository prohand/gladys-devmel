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
 * Handler of the `test_connection` manifest action: report the local channel
 * and what was understood from the device list, which is the fastest way to
 * spot a mistyped connection string or a device list that did not parse.
 */
export async function testConnection(client, config, service = null) {
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

  en.push(`Devices: ${summarize(config, 'en')}`);
  fr.push(`Appareils : ${summarize(config, 'fr')}`);

  return { en: en.join('\n'), fr: fr.join('\n') };
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
