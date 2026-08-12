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
| Shutter (`4098`)               | Open / Stop / Close                                   |
| Shutter with position (`4099`) | Open / Stop / Close **+** position (0-100 %)          |
| Dimmable light (`4100`)        | On/Off **+** brightness                               |

Devices are not discovered over the air: they are the ones the user paired in
the AirSend app and exported from airsend.cloud, pasted as is (YAML or JSON) in
the configuration — `!secret` references included.

## How it talks to the hardware

Two transports, declared in the manifest and selected by the standard
**"Prefer the local connection"** toggle:

- **local** — the [AirSend Web Service](https://github.com/devmel/hass_airsend-addon)
  on the LAN (port `33863`): `POST /airsend/transfer` to send radio notes,
  `POST /airsend/bind` to subscribe to the ones it hears, authenticated with the
  `sp://` connection string;
- **cloud** — `GET https://airsend.cloud/device/<id>/<action>/<value>/` with the
  account API key. Commands only.

Each one is the other's fallback: a device reports the channel that actually
carried its last order (`publishTransports`), flagged **degraded** when the
preferred channel had to be rerouted.

When the user has Gladys Plus, the box is bound to the listening channel and
pushes every radio frame it hears to the integration's `events` webhook — so a
wall remote pressed by hand, or a weather sensor waking up, reaches Gladys.
Without it, the box sensors are refreshed by polling and everything else keeps
working.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no radio logic)
├─ src/
│  ├─ config.js                      # config defaults + the airsend.cloud device list parser
│  ├─ devmel/                        # the AirSend driver
│  │  ├─ client.js                   #   local + cloud transport, fallback, transport badge
│  │  ├─ notes.js                    #   the radio "notes" protocol (build & decode)
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
and [Jeedom](https://github.com/devmel/jeedom_airsend) integrations. This
project is not affiliated with Devmel.

## License

Apache-2.0
