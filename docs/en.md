# Devmel (AirSend)

This integration connects Gladys to a **Devmel AirSend** or **AirSend Duo**
radio gateway, and through it to the 433 MHz / 868 MHz equipment it drives:
roller shutters, switches, dimmable lights, gates, and the sensors that talk
back (Somfy RTS, Chacon DiO, Nice, FAAC, Bubendorff…).

## Before you start

Your devices are paired in the **AirSend mobile app** or on
[airsend.cloud](https://airsend.cloud), not in Gladys: this integration
replays the radio orders they already know. Get them working there first.

Everything then goes through the local channel below: the integration drives
your box on your own network, and never calls airsend.cloud to send an order.

### Local

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

## Configuration

1. Open the **Configuration** tab of the integration.
2. Paste the **connection string** of your box. That is enough: the AirSend
   service is already running inside the integration.
3. Paste your **device list** (see below).
4. Save, then click **Test the connection**: it reports the built-in service,
   the local channel, and how many devices it understood.
5. The devices appear in the **Discovery** tab, ready to be added to Gladys.

The **AirSend Web Service URL** is only needed in the case described above: a
service of your own.

Each device shows as a badge the channel that carried its last order — `local`
when your box answered, `unreachable` when it could not be reached.

## The device list

On airsend.cloud, open **Import/Export** and export your devices as **JSON**.
That export is read as it comes, on a single line included, which is what the
**Devices** field expects.

### The JSON export

It looks like this — a list, with the radio channel written flat:

```json
{
  "devices": [
    {
      "name": "Living room shutter",
      "localip": "fe80::dcf6:e5ff:fe8f:89cd",
      "type": 4098,
      "pid": 25455,
      "addr": 8295
    }
  ]
}
```

Paste it as is, one line included. `pid` and `addr` are the radio channel of
the device: `pid` is the channel id (the protocol, shared by every device
driven the same way) and `addr` its source (the address of the emitter).
`localip` is the address of the box the device belongs to; the box itself is
still reached through the `sp://` connection string filled in above.

An entry without a radio channel is ignored: there is nothing the box could
send for it. The box itself (`type: 0`) is the exception — it always answers on
channel 1.

### Writing the list by hand

The same list can be written by hand, keyed by name, with the channel nested
under `channel` instead of the flat `pid` / `addr` pair. It stays JSON:

```json
{
  "devices": {
    "AirSend box": { "type": 0, "sensors": true, "refresh": 300 },
    "Living room shutter": {
      "type": 4098,
      "invert": true,
      "channel": { "id": 25455, "source": 94311 }
    },
    "Pergola light": { "type": 4100, "channel": { "id": 26848, "source": 1442421508 } },
    "Outdoor sensor": {
      "type": 1,
      "features": ["temperature", "humidity"],
      "channel": { "id": 1368, "source": 542 }
    }
  }
}
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
| `channel`  | Radio channel (`id`, `source`, `mac`, `seed`), **required**                |
| `pid`      | The `channel.id` of the JSON export (use either form)                      |
| `addr`     | The `channel.source` of the JSON export                                    |
| `spurl`    | Connection string of this device, if it differs from the global one        |
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

- **Test the connection** — checks the local channel and reports the devices it
  parsed. The fastest way to spot a mistyped connection string or a device
  list that did not parse.
- **Identify a device** — pick a device and it is sent a PING. Not every piece
  of 433 MHz equipment reacts to it.

## Good to know

- 433 MHz is a **one-way** protocol for most equipment: nothing confirms an
  order was received, and Gladys shows the value it sent. Listening (above) is
  what turns that assumption into a real state.
- Sensors are read from the **box itself**, over the local channel.
- The built-in service reaches your box **from inside the integration's
  container**, over your LAN: the `rhost=<IPv4>` of the connection string is
  the address it dials, and it has to be routable from the Gladys host.
- Changing the `type` of a device in the list creates a new device in Gladys
  (the identifier changes) — except between `4098` and `4099`, which share it.

## Troubleshooting

| Symptom                           | What to check                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `Invalid connection string`       | The `sp://` URL, and that its password matches the box                                 |
| `Invalid input`                   | The `channel` of the device (`id`/`pid` and `source`/`addr`)                           |
| `no radio channel` in the logs    | The entry carries no channel: it needs `channel.id`, or the `pid`/`addr` pair          |
| `no radio confirmation`           | Normal on equipment without feedback: set `wait: false`                                |
| No device in the Discovery tab    | **Test the connection**: the device list probably did not parse                        |
| The box is unreachable            | The `?gw=0&rhost=<IPv4>` part of the connection string                                 |
| `Built-in service unavailable`    | The integration logs: the service logs its own startup there                           |
| The box answers by hand, not here | The `rhost=` IPv4 must be reachable **from the container**, not just from your desktop |

The integration logs everything it does: read the integration logs from the
Gladys UI (or `docker logs` on the host), with `LOG_LEVEL=debug` for the full
detail.
