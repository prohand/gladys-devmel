# Devmel — Gladys Assistant integration

External integration connecting [Gladys Assistant](https://gladysassistant.com)
to a **Devmel AirSend / AirSend Duo** radio gateway, and through it to the
433 MHz and 868 MHz equipment it drives — shutters, switches, dimmable lights,
gates, radio sensors (Somfy RTS, Chacon DiO, Nice, FAAC, Bubendorff…).

Built on the official
[JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
and the SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

User documentation: [English](./docs/en.md) · [Français](./docs/fr.md).

## What it does

| Device (airsend.cloud type)    | Gladys features                                       |
| ------------------------------ | ----------------------------------------------------- |
| AirSend box (`0`)              | Temperature + illuminance, read by polling            |
| Radio sensor / remote (`1`)    | Temperature, humidity, illuminance, click — push only |
| Button (`4096`)                | Push button (TOGGLE)                                  |
| Switch (`4097`)                | On/Off                                                |
| Shutter (`4098`)               | Open / Stop / Close, **+** position once timed        |
| Shutter with position (`4099`) | Open / Stop / Close **+** position (0-100 %)          |
| Dimmable light (`4100`)        | On/Off **+** brightness                               |

The radio carries orders, never positions. A shutter given its travel times
(`travel_up` / `travel_down`) has its position computed from them instead —
from Gladys orders and from the ones heard on the radio alike — and
resynchronized on every end stop. See
[the user documentation](./docs/en.md#the-position-of-a-shutter).

Devices are not discovered over the air: they are the ones the user paired in
the AirSend app and exported from airsend.cloud (Import/Export → Export JSON),
pasted as is in the configuration.

## How it talks to the hardware

One transport, declared in the manifest: **local** — the
[AirSend Web Service](https://github.com/devmel/hass_airsend-addon)
(port `33863`): `POST /airsend/transfer` to send radio notes,
`POST /airsend/bind` to subscribe to the ones it hears, authenticated with the
`sp://` connection string.

The image **ships that service** and runs it in the integration's own
container, on `http://127.0.0.1:33863`: a fresh install needs the connection
string of the box and nothing else. `src/devmel/service.js` starts it, watches
it and restarts it; the binary comes from Devmel at build time (see the
`Dockerfile`), daemonizes, and leaves its pid in `AirSendWebService.lock` in
`/data`. Filling in the service URL by hand still wins, for anyone who already
runs it elsewhere.

Each device reports the channel that actually carried its last order
(`publishTransports`): `local` when the box answered, `unreachable` when
nothing did.

The box is bound to a listening channel, and every radio frame it hears — a
wall remote pressed by hand, a weather sensor waking up — comes back to the
integration. It is the _service_ that calls back, from the machine it runs on
and in plain HTTP: when that machine is our own container,
`src/devmel/callback.js` answers on its loopback, and that is where both the
subscription and the answers to fire-and-forget transfers are pushed. A service
the user runs elsewhere cannot reach it, and its frames go through the `events`
webhook relayed by Gladys Plus instead. Both routes hand the same payload to
the same handler.

What is bound is a _protocol_, not a device: the box has one radio, and
subscribing switches it to permanent reception of a single protocol.
`src/devmel/listening.js` reads the protocol table of the service
(`GET /channels/`, which says what decodes what) and deduces that protocol from
the declared devices, rather than hoping the generic 433 MHz decoder covers
them.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no radio logic)
├─ src/
│  ├─ config.js                      # config defaults + the airsend.cloud device list parser
│  ├─ devmel/                        # the AirSend driver
│  │  ├─ client.js                   #   the local transport and the transport badge
│  │  ├─ service.js                  #   the bundled AirSend Web Service (start, watch, stop)
│  │  ├─ notes.js                    #   the radio "notes" protocol (build & decode)
│  │  ├─ travel.js                   #   shutter position, computed from the travel times
│  │  ├─ callback.js                 #   where the service posts the frames it hears
│  │  ├─ listening.js                #   which radio protocol the box is asked to listen to
│  │  └─ connection.js               #   connection status + the "Test the connection" action
│  └─ devices/                       # one file per device type
│     ├─ index.js                    #   registry: config -> Gladys devices, event routing
│     ├─ gateway.js                  #   the box sensors (poll)
│     ├─ sensor.js                   #   radio sensors and remotes (push)
│     ├─ button.js                   #   push button
│     ├─ switchDevice.js             #   on/off
│     ├─ shutter.js                  #   shutters, with or without position
│     └─ light.js                    #   dimmable light
├─ docs/                             # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest (config schema, actions, webhook…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI + UI-driven release, multi-arch image
```

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="devmel" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container. The SDK reads them
automatically.

Outside the image there is no bundled AirSend Web Service, so the local channel
is simply reported as unavailable. To exercise it, unpack Devmel's tarball
somewhere and point the two optional variables at it:

```bash
DEVMEL_SERVICE_DIR=/opt/airsend   # holds bin/unix/<arch>/AirSendWebService
DEVMEL_DATA_DIR=/tmp/gladys-devmel # writable, for the daemon's pid file
```

## Quality checks

The same three checks run on every push and pull request (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
npm run format:check   # Prettier: is everything formatted?
npm run lint           # ESLint: catch real mistakes
npm test               # Unit tests, via the built-in `node --test` runner
```

Before tagging a release, the store validation can be run locally:

```bash
npx github:GladysAssistant/integration-store .
```

## Release

**Actions → Release → Run workflow**, pick `patch`, `minor` or `major`: the
workflow bumps the version everywhere (`package.json` + manifest
`version`/`docker_image`), pushes the `vX.Y.Z` tag and builds the
`linux/amd64` + `linux/arm64` image to `ghcr.io`. The decentralized indexer
then picks up the new manifest version — the repository must be public and
carry the `gladys-assistant-integration` GitHub topic.

## Credits

The AirSend HTTP API and its radio note protocol are the ones Devmel documents
through its official [Home Assistant](https://github.com/devmel/hass_airsend)
and [Jeedom](https://github.com/devmel/jeedom_airsend) integrations. The
AirSend Web Service the image bundles is Devmel's own binary, downloaded at
build time from `devmel.com` exactly as their
[Home Assistant add-on](https://github.com/devmel/hass_airsend-addon) does; it
is redistributed unmodified and remains their work. This project is not
affiliated with Devmel.

## License

Apache-2.0
