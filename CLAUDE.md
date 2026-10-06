# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 20+, ESM, no build step, one runtime
dependency: `@gladysassistant/integration-sdk`) for a **Devmel AirSend / AirSend Duo** radio
gateway and the 433/868 MHz equipment it drives: shutters (with or without position), switches,
dimmable lights, gates, buttons, radio sensors and wall remotes (Somfy RTS, Chacon DiO, Nice,
FAAC, Bubendorff…). Gladys 5.1+ adds scene triggers (remote pressed, order failed), scene actions
(set a shutter's known position, re-arm listening) and an "AirSend radio" widget.

Devices are not discovered over the air: the user pastes the JSON exported from airsend.cloud
(Import/Export → Export JSON) into the configuration.

## Commands

```bash
npm install
npm test                                    # node --test (built-in runner)
node --test test/travel.test.js             # one file
node --test --test-name-pattern "echo"      # one test by name
npm run lint                                # eslint .
npm run format:check                        # prettier --check . (CI gate)
npm run format                              # prettier --write .
```

CI runs `format:check`, `lint`, `test`. Releases: **Actions → Release** only (bumps
`package.json`, manifest `version` + `docker_image`, re-runs Prettier, tags, builds).

## Architecture

The README has the full tree; the short version:

```
index.js                SDK bootstrap + wiring (no radio logic): timers, listening, warm link
src/config.js           defaults + the airsend.cloud device list parser (tolerant of many shapes)
src/logging.js          log level switchable from the Configuration screen
src/devmel/service.js   the bundled AirSend Web Service binary: start, watch, restart
src/devmel/client.js    local transport (POST /airsend/transfer, /airsend/bind) + transport badge
src/devmel/notes.js     radio "notes" protocol (build and decode)
src/devmel/orders.js    orders just sent, so their echo is not replayed as a new order
src/devmel/travel.js    shutter position computed from travel times
src/devmel/callback.js  loopback HTTP endpoint the service posts heard frames to
src/devmel/listening.js which protocol the box listens to (from GET /channels/)
src/devmel/heard.js     emitters heard on the air, remembered
src/devmel/remotes.js   "Attach a remote": writes the device list entry for a heard remote
src/devmel/protocols.js pid <-> protocol names
src/devmel/connection.js connection status + "Test the connection"
src/devices/            one file per device type (gateway, sensor, button, switch, shutter, light)
src/capabilities/       Gladys 5.1 scenes and widget
```

### Invariants worth knowing

- **The image ships the AirSend Web Service** (downloaded from Devmel at build time, see the
  Dockerfile) and runs it in the container on `http://127.0.0.1:33863`. Its lock/pid file lives in
  `/data`, the only writable path. A service URL typed by hand wins.
- **The radio carries orders, never positions.** A shutter given `travel_up` / `travel_down` has
  its position computed (`travel.js`) from Gladys orders and from orders heard on the air, and
  resynchronized at every end stop.
- **Everything transmitted comes back** (transfer answer + the box hearing itself):
  `orders.js` remembers what was sent so the echo is not replayed — that bug once sent a shutter
  positioned at 40 % to the top.
- **One radio, one transmission at a time**: orders are queued, retried when the box could not
  carry them, and repeated like a real remote when needed (`repeat`).
- **Listening binds a protocol, not a device**: subscribing switches the box to permanent
  reception of one protocol, deduced from the declared devices.
- **The link is kept warm**: an idle box is touched every four minutes (a sensor read, never on
  the air), down to a minute when waking it proved slow.
- **Heard frames arrive two ways**: the loopback callback (bundled service) or the `events`
  webhook relayed by Gladys Plus (service elsewhere). Both hand the same payload to the same
  handler.
- **Polling**: Gladys `poll_frequency` is an enum in ms (1000, 2000, 10000, 15000, 30000,
  60000); any other value rejects the WHOLE discovery batch, and Gladys only polls a device that
  also carries `should_poll: true`. The configured `poll_frequency` / per-device `refresh` are
  seconds and must never be published as is.
- **Transport badge** per device: `local` when the box answered, `unreachable` otherwise.
- **Every feature declares `min`/`max`** (NOT NULL in Gladys), button/switch/light on/off
  included.
- The `sp://` connection string is a secret: never log it in full.
- Trigger, action and widget keys are stored by users: never rename them.

### Manifest

`test/manifest.test.js` keeps `gladys-assistant-integration.json` (config schema, actions,
webhook, 5.1 capabilities) in sync with `DEFAULT_CONFIG` and the handlers.

## Testing

No hardware, no network: `test/helpers/fakeAirSend.js` fakes the web service,
`test/helpers/fakeClock.js` drives timers, `test/helpers/captureLogs.js` asserts on log lines and
`test/helpers/fakeGladys.js` stands in for the SDK.

## Conventions

Prettier formats, ESLint catches mistakes. Comments explain **why** (radio behaviours look
arbitrary without them). User-facing messages are bilingual `{ en, fr }`; user docs in
`docs/en.md` and `docs/fr.md`, kept in sync.
