# Devmel (AirSend)

This integration connects Gladys to a **Devmel AirSend** or **AirSend Duo**
radio gateway, and through it to the 433 MHz / 868 MHz equipment it drives:
roller shutters, switches, dimmable lights, gates, and the sensors that talk
back (Somfy RTS, Chacon DiO, Nice, FAAC, Bubendorff…).

## Before you start

Your devices are paired in the **AirSend mobile app** or on
[airsend.cloud](https://airsend.cloud), not in Gladys: this integration
replays the radio orders they already know. Get them working there first.

You then need at least one of the two channels below — both is best, they
back each other up.

### Local (recommended)

The local channel talks to the **AirSend Web Service**, the small HTTP server
Devmel ships to drive the box over your LAN. Run it wherever you like on the
network (the Home Assistant add-on, the Jeedom daemon, or the binary in its
own container); it listens on port `33863`.

You need:

- its URL, e.g. `http://192.168.1.50:33863/`;
- the **connection string** exported by airsend.cloud, which looks like
  `sp://password@[fe80::xxxx:xxxx:xxxx:xxxx]?gw=0&rhost=192.168.1.50`.

Always keep the `?gw=0&rhost=<box IPv4>` part: without it the box is reached
by IPv6 link-local only and the service answers unexpected errors.

### Cloud

The cloud channel calls `airsend.cloud` directly with your account **API key**.
It needs no local service, but it can only send orders: sensors and incoming
radio frames are local-only features.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Fill in the **AirSend Web Service URL** and the **connection string**,
   and/or the **airsend.cloud API key**.
3. Paste your **device list** (see below).
4. Save, then click **Test the connection**: it reports both channels and how
   many devices it understood.
5. The devices appear in the **Discovery** tab, ready to be added to Gladys.

The **Prefer the local connection** toggle decides which channel is tried
first. Each device shows the channel that actually carried its last order as a
badge, with an orange dot when it ran degraded (local refused, cloud fallback).

## The device list

On airsend.cloud, open **Import/Export → Export YAML** and tick `spurl` for the
local connection. Paste the file as is in the **Devices** field: the
`!secret spurl` and `!secret apiKey` references it contains are resolved with
the credentials you filled in above. JSON is accepted too.

```yaml
devices:
  AirSend box:
    type: 0
    spurl: !secret spurl
    sensors: true
    refresh: 300

  Living room shutter:
    id: 12345
    type: 4098
    invert: true
    apiKey: !secret apiKey
    channel:
      id: 25455
      source: 94311

  Pergola light:
    id: 65838
    type: 4100
    channel:
      id: 26848
      source: 1442421508

  Outdoor sensor:
    type: 1
    features: [temperature, humidity]
    channel:
      id: 1368
      source: 542
```

### Device types

| `type` | Device                | What you get in Gladys                       |
| ------ | --------------------- | -------------------------------------------- |
| `0`    | AirSend box           | Its temperature and light sensors            |
| `1`    | Radio sensor / remote | The readings it emits (see `features` below) |
| `4096` | Button                | A push button sending TOGGLE                 |
| `4097` | Switch                | On/Off                                       |
| `4098` | Shutter               | Open / Stop / Close                          |
| `4099` | Shutter with position | Open / Stop / Close **+** a 0-100 % position |
| `4100` | Dimmable light        | On/Off **+** brightness                      |

### Device options

| Option     | Meaning                                                                    |
| ---------- | -------------------------------------------------------------------------- |
| `type`     | Device type (table above), **required**                                    |
| `id`       | airsend.cloud device id — required for the cloud channel                   |
| `channel`  | Radio channel (`id`, `source`, `mac`, `seed`) — required for the local one |
| `spurl`    | Connection string of this device, if it differs from the global one        |
| `apiKey`   | API key of this device, if it differs from the global one                  |
| `wait`     | Wait for the radio confirmation before answering (`false` by default)      |
| `invert`   | Swap open and close, for shutters installed the other way round            |
| `sensors`  | On a box (`type: 0`), expose its temperature and light sensors             |
| `refresh`  | Read interval of those sensors, in seconds                                 |
| `features` | On a sensor (`type: 1`): `temperature`, `humidity`, `illuminance`, `click` |

A box declared without `sensors: true` creates no device in Gladys — it is
only there to carry the connection string.

## Listening to the radio (optional, needs Gladys Plus)

The AirSend box can forward every frame it hears — a wall remote pressed by
hand, a weather sensor waking up — so Gladys follows what happens in the house
instead of only what it ordered itself.

The box pushes those frames to a public URL, which Gladys Plus provides: link
your Gladys Plus account and paste your Open API key in the **Webhooks** block
of the Configuration screen. The integration then subscribes the box to the
**listening channel** (channel `1` by default; `0` disables it).

Without Gladys Plus everything else keeps working, and the box sensors are
refreshed by polling.

## Actions

- **Test the connection** — checks both channels and reports the devices it
  parsed. The fastest way to spot a mistyped connection string or a device
  list that did not parse.
- **Identify a device** — pick a device and it is sent a PING. Not every piece
  of 433 MHz equipment reacts to it.

## Good to know

- 433 MHz is a **one-way** protocol for most equipment: nothing confirms an
  order was received, and Gladys shows the value it sent. Listening (above) is
  what turns that assumption into a real state.
- Sensors are read from the **box itself**, so they need the local channel.
- Changing the `type` of a device in the list creates a new device in Gladys
  (the identifier changes) — except between `4098` and `4099`, which share it.

## Troubleshooting

| Symptom                        | What to check                                                   |
| ------------------------------ | --------------------------------------------------------------- |
| `Invalid connection string`    | The `sp://` URL, and that its password matches the box          |
| `Invalid input`                | The `channel` of the device (`id` and `source`)                 |
| `no radio confirmation`        | Normal on equipment without feedback: set `wait: false`         |
| No device in the Discovery tab | **Test the connection**: the device list probably did not parse |
| The box is unreachable         | The `?gw=0&rhost=<IPv4>` part of the connection string          |

The integration logs everything it does: read the integration logs from the
Gladys UI (or `docker logs` on the host), with `LOG_LEVEL=debug` for the full
detail.
