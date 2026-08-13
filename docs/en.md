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
Devmel ships to drive the box over your LAN.

**It is included.** The integration runs it inside its own container, on
`http://127.0.0.1:33863`, and supervises it: nothing to install next to
Gladys, no URL to fill in. The **Use the built-in AirSend service** switch, on
by default, is what controls it.

So the only thing the local channel needs from you is the **connection
string** exported by airsend.cloud, which looks like:

```
sp://password@[fe80::xxxx:xxxx:xxxx:xxxx]?gw=0&rhost=192.168.1.50
```

Always keep the `?gw=0&rhost=<box IPv4>` part: without it the box is reached
by IPv6 link-local only and the service answers unexpected errors.

#### Using a service you already run

If the AirSend Web Service is already running somewhere on your network — the
Home Assistant add-on, the Jeedom daemon, a container of your own — just fill
in the **AirSend Web Service URL** field (`http://192.168.1.50:33863/`). A URL
typed there wins: the integration uses it and starts nothing of its own.

### Cloud

The cloud channel calls `airsend.cloud` directly with your account **API key**.
It is a **fallback**, entirely optional: it takes over when the box cannot be
reached locally. It can only send orders — sensors and incoming radio frames
are local-only features — and each device needs its airsend.cloud `id` for it
to work.

#### The cloud API key

The key belongs to your **airsend.cloud account**, the one where your devices
are declared: sign in on [app.airsend.cloud](https://app.airsend.cloud) and
look for the API key of your account.

Two things worth knowing before you go hunting for it:

- **you probably do not need it.** With the built-in service above, the local
  channel works on its own; the key only buys you a fallback for when the box
  is unreachable, and orders sent while it is;
- **it may already be in your export.** The YAML export references it as
  `!secret apiKey`, and this field is what that reference resolves to. An
  export that carries the key inline (`apiKey: xxxxx`) is used as is, per
  device — nothing to fill in at all.

The API itself is documented at
[asp.devmel.com/api-docs](https://asp.devmel.com/api-docs).

## Configuration

1. Open the **Configuration** tab of the integration.
2. Paste the **connection string** of your box. That is enough: the AirSend
   service is already running inside the integration.
3. Paste your **device list** (see below).
4. Save, then click **Test the connection**: it reports the built-in service,
   both channels, and how many devices it understood.
5. The devices appear in the **Discovery** tab, ready to be added to Gladys.

The **AirSend Web Service URL** and the **airsend.cloud API key** are only
needed in the two cases described above: a service of your own, and the cloud
fallback.

The **Prefer the local connection** toggle decides which channel is tried
first. Each device shows the channel that actually carried its last order as a
badge, with an orange dot when it ran degraded (local refused, cloud fallback).

## The device list

On airsend.cloud, open **Import/Export → Export YAML** and tick `spurl` for the
local connection. That export is what the **Devices** field expects, and the
`!secret spurl` / `!secret apiKey` references it contains are resolved with the
credentials you filled in above.

The field is a single-line input, so the safest paste is the **JSON** form of
that list — the same content, on one line:

```json
{ "Living room shutter": { "type": 4098, "channel": { "id": 25455, "source": 94311 } } }
```

The YAML export is read as well when the line breaks survive the paste:

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
- The built-in service reaches your box **from inside the integration's
  container**, over your LAN: the `rhost=<IPv4>` of the connection string is
  the address it dials, and it has to be routable from the Gladys host.
- Changing the `type` of a device in the list creates a new device in Gladys
  (the identifier changes) — except between `4098` and `4099`, which share it.

## Troubleshooting

| Symptom                           | What to check                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `Invalid connection string`       | The `sp://` URL, and that its password matches the box                                 |
| `Invalid input`                   | The `channel` of the device (`id` and `source`)                                        |
| `no radio confirmation`           | Normal on equipment without feedback: set `wait: false`                                |
| No device in the Discovery tab    | **Test the connection**: the device list probably did not parse                        |
| The box is unreachable            | The `?gw=0&rhost=<IPv4>` part of the connection string                                 |
| `Built-in service unavailable`    | The integration logs: the service logs its own startup there                           |
| The box answers by hand, not here | The `rhost=` IPv4 must be reachable **from the container**, not just from your desktop |

The integration logs everything it does: read the integration logs from the
Gladys UI (or `docker logs` on the host), with `LOG_LEVEL=debug` for the full
detail.
