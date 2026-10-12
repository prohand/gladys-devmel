# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [3.0.1] - 2026-10-12

### Changed

- `@gladysassistant/integration-sdk` updated to 0.15.0.

## [3.0.0] - 2026-10-12

### Fixed

#### Shutters and gates

- A shutter or gate order retried after a slow or failed transfer no longer goes out again after the newer order given meanwhile (UP, STOP, then UP again set the shutter off by itself; a gate you closed reopened).
- STOP (and the favourite position) is sent once instead of being repeated, and is retried only when it certainly never went out: on Somfy RTS a second STOP is the "my" press and sent a just-stopped shutter to its favourite position.
- A STOP pressed on a wall remote cancels the queued repeat of the previous Gladys order, which used to restart the shutter while Gladys showed it stopped; a timed shutter's STOP still waiting for the radio no longer goes out after a wall remote has set the shutter off again.
- A timed shutter sent to a position is stopped on time even when Gladys refuses the state published with the order (429, timeout) or is slow to take a position published on the way; that refusal no longer reports the order as failed.
- A STOP heard just after an Open/Close, while Gladys was still taking that order's state, no longer leaves Gladys showing the shutter travelling to its end stop.
- Many timed shutters moving together (a "close all" scene) no longer exceed the 300 states a minute Gladys accepts, so their end-stop positions are no longer refused.
- When the STOP of a timed shutter could not be sent, or the box reports later that it refused it (BUSY, NETWORK…), the position follows the shutter to its end stop and the "A radio order failed" trigger fires, instead of showing the target (or the shutter stopped) while the motor runs on. This holds for the STOP that ends a positioning and for a Stop given from Gladys.
- An arrival that waited for a slow Gladys no longer publishes its old target and STOP state over a newer movement started meanwhile; a position asked while the shutter is already moving is honoured, and two positions asked at once no longer drop the second.
- A shutter given travel times in a saved configuration no longer takes the destination of its last untimed order for its position: it starts unknown, and the first percentage runs to the nearest end stop.
- Correcting `invert` mirrors the position the shutter remembers, the travel under way included, instead of showing the mirror in Gladys and sending the motor into the end stop it rests at.
- A position known to be unknown (the "my" button without `favorite_position`, a one-button keyfob) is no longer replaced by Gladys' stale value on a reconnection or a saved configuration, and a position Gladys missed while it was unreachable is published again when it comes back.
- A position order to a 4099 without travel times updates the shutter state too.
- A one-button keyfob (TOGGLE) heard by a timed shutter makes its position unknown instead of leaving a stale one later orders were timed from.
- An ON/OFF heard by a shutter (Chacon DiO remotes) drives it like UP/DOWN, tracked over the travel time, instead of putting it at an end stop at once without a state; an untimed 4098 follows it too.
- A timed shutter still moving when the integration stops (update, Gladys restart) is no longer left running: a shutter driven to a position is stopped where it is, a full opening or closing is published at its end stop, and the next start resumes from there.
- No listening bind (the re-arm after an order, the 10-minute renewal, a configuration save, a reconnection, a re-arm from the widget or a scene) takes the radio just before the STOP of a shutter driven to a position, which made the shutter stop past the position asked for.

#### Echoes and failed orders

- The echo of a percentage or of an ON/OFF sent by Gladys is no longer taken for the device reporting its state: a timed 4099 keeps its travel instead of jumping to the target, and a late echo no longer switches a plug or a light back on after it was switched off.
- A remote copied onto the address of its device (same channel as Gladys' orders) is followed as a remote press within the minute after a Gladys order: shutters and gates follow its Up/Down/Stop, the Gladys repeat still waiting for the radio is dropped, `remote_pressed` fires, and a press repeating a value Gladys sent earlier is no longer dropped as an echo. An answer of the box arriving late is still never taken for a press.
- A device that lists a group channel in its `remotes` follows the orders Gladys sends on that channel, once: a late or repeated echo of the group order no longer cancels an order the device was given since ("close all, then the living room to 50 %" leaves it at 50 %).
- When the box reports that an order never reached the air (NETWORK, BUSY…), the device's badge turns to unreachable, a timed shutter's travel is taken back (its STOP is no longer sent to a motor that never moved), and a switch or a light shows its state from before again (ON, OFF, ON clicked faster than the box answers and all refused end as before the three).
- Each late verdict of the box is charged to the exact emission it answers: a refused repeat no longer makes the next order fail, a carried repeat no longer hides a refused STOP, the box hearing its own emission no longer counts as a confirmation, and an order the AirSend service never received (connection refused) no longer takes the next order's verdicts.
- A repeat the box refused after the order itself went out, a refused "Identify" PING, or a state Gladys refused after the radio order went out no longer fires the "A radio order failed" trigger nor undoes the order.

#### Lights, switches, remotes and sensors

- Switching a dimmable light on while a brightness order was still waiting for the radio no longer puts the lamp back at the brightness before.
- A dimmable light switched on from its wall remote no longer shows 100 % in Gladys, and the next On from Gladys no longer sends it to full brightness.
- A dimmable light switches back on at its last brightness after a restart of the integration, instead of at 100 %.
- Radio sensor readings and remote clicks heard live are published as current values, so Gladys scenes triggered on them (a keyfob click, a temperature threshold) run; only frames relayed late keep their date.
- The stop and "my" buttons of a type 1 remote publish a click like the other buttons.
- A remote button held down for 1.5 s or more counts as one press: one "remote pressed" scene event and one click.
- A sensor feature listed twice (e.g. "Temperature, temperature") no longer prevents Gladys from creating the sensor.

#### Radio queue, listening and the AirSend service

- With two AirSend boxes, a box that does not answer no longer delays the orders sent through the other one, and keep-warm wakes every box after its own silence, not only the first one. One box whose connection string is written two ways keeps a single radio queue.
- The keep-warm interval is no longer halved by the slow first contact after start-up or by a box that is switched off (which also logged a line every minute all night).
- A general remote declared on several shutters no longer outvotes sensors on another protocol when the listening protocol is deduced: each emitter counts once.
- A listening channel typed by hand for a protocol the generic 433 MHz decoder covers is listened to on channel 1, and its devices are no longer reported as not heard.
- A disconnection no longer lets a queued listening request bind the box and start a renewal timer afterwards.
- A second box declared with its own connection string no longer stops the box behind the global connection string from being listened through and kept warm.
- When the AirSend service could not list its protocols at startup, the renewals switch to the right listening protocol once it can.
- Setting the listening channel to 0 stops frames from the previous subscription from moving devices.
- The widget's Re-arm button and the `rearm_listening` scene action no longer fail with a spurious "No route" while another re-arm or a configuration save is in progress.
- A reconnection or a configuration save while the bundled AirSend Web Service was slow to answer no longer starts a second copy and loses track of the first; switching to a service of your own while the bundled one was starting no longer leaves it running, and switching back no longer leaves it stopped.
- Saving the configuration while Gladys refused the device list no longer fails silently: the failure is logged and the Configuration screen shows "Initialization failed".
- An installation with more than 100 devices no longer fails to start: transport badges are sent in batches of 100, and a badge Gladys refuses no longer fails initialization.
- With the AirSend service on another machine, the Gladys Plus webhook accepts a single event or a bare list, as the local callback does, and a failed read of the webhook address keeps the last known one (and logs the failure) instead of stopping listening and order verdicts.
- Transport badges republished after a configuration save show what the new configuration allows, not the result of the last order under the old one.

#### Configuration, Test the connection, widget and "Attach a remote"

- A mistyped connection string written on a second box is flagged on the Configuration screen and in the logs, naming that box, and Test the connection shows it (password removed).
- A box declared before the sp:// connection string is pasted no longer makes listening fail every ten minutes; a box with its string but no AirSend service is told the service is missing.
- Ticking "Detailed logs" logs the connection string (password removed) on that very save and at startup; the save that turns them off no longer prints it.
- Test the connection and the widget report a listening renewal the box refused, keep each remote's verdict across a reconnection, and read "not heard since the configuration changed" after a remote is attached, instead of calling it mute.
- A remote declared by its protocol alone is shown as followed, and no longer printed as "addr undefined"; a spare remote attached to a Button is shown as followed; a press heard well by one box and badly by the other no longer shows the remote as dropped.
- An order decoded but ignored by its device (a TOGGLE heard by a switch), a sensor pasted without `features`, or a STOP on a sensor without "click" is no longer blamed on a partially decoded rolling-code protocol: the logs and Test the connection name the actual fix.
- Every piece of advice about the Listening channel field, the "Accept unreliable frames" description included, says "generic" for pid 1, never 1 (which the field reads as "deduce").
- "Attach a remote" refuses the AirSend box as the device a remote drives, writes the last-resort line for a remote heard without its address on its device's own protocol instead of answering "press again" forever, and says when a remote's frames were dropped as unreliable instead of claiming they carry no order (or that the device state will not follow when an earlier press decoded an order).
- "Find a radio protocol" no longer lists the AirSend box as a device declared on the generic 433 MHz protocol.

### Security

- A device list that cannot be read no longer copies part of the sp:// connection string (its password included) into the error log.
- A box whose sp:// password contains an `@`, and whose string has no `rhost=`, no longer gets part of its password in its Gladys id; such a box appears once more in Discovery, under its address.

## [2.2.4] - 2026-10-10

### Fixed

- A reconnection to Gladys, or a configuration saved, while a timed shutter is travelling no longer cancels the travel: a shutter driven to 40 % gets its STOP on time instead of running into its end stop, and a position known in memory is no longer replaced by the older one Gladys kept.
- The Somfy "my" button, which most RTS remotes send as a plain STOP, sends a still timed shutter to its `favorite_position` in Gladys too, the Gladys STOP order included; the repeated frames of one press count as one STOP. A shutter without travel times keeps reading a STOP as a STOP: nothing says whether it moves.
- A remote that shares the address of its device (a remote copied into the AirSend app) is followed again a minute after an order from Gladys, instead of being taken for Gladys' own echo for as long as the integration runs.
- A press of a type `1` remote publishes one click, not one per frame: a scene "on click, toggle" no longer toggles two or three times.
- "Attach a remote" keeps a remote already declared as `"remote": …` or as a lone `"remotes": …` instead of dropping it from the line to paste.
- A connection string declared on the box alone serves every device: shutters and lamps are no longer "unreachable" and the status no longer says "not configured yet".
- A device entry whose `type` is empty (`null`, `""`) is reported and ignored instead of being read as a box.
- A Gladys Plus webhook payload already decoded is read instead of dropped.
- Without any box to listen through (no connection string), listening, "Test the connection" and the widget say so, instead of pointing at a missing route or Gladys Plus.

## [2.2.3] - 2026-10-08

- Maintenance release, no functional change.

## [2.2.2] - 2026-10-08

- Maintenance release, no functional change.

## [2.2.1] - 2026-10-08

### Fixed

- A timed shutter driven to a position (40 %, say) is stopped on time even when Gladys fails to take a position update: the STOP goes out before the position is published, and a failed publication no longer ends the position tracking (the shutter used to run into its end stop).
- A push button TOGGLE (a gate) is no longer sent a second time after a failure that does not prove it never went out (box timeout, lost synchronization, "no radio confirmation", request timeout): the gate opened and then closed again. It is still retried when the service was unreachable or the box busy.
- Listening requested twice at the same moment no longer leaves a renewal timer running that nothing stops, not even the disconnection or the shutdown.
- The bundled AirSend Web Service is restarted only after three unanswered checks in a row, and the hung daemon is terminated (SIGTERM, then SIGKILL) first, so the new one can take the port.
- A box sensor read that failed is tried again at the next Gladys tick instead of a whole `refresh` interval later.
- A device created or updated in Gladys after the integration started gets its known states at once: the shutter position already known, a fresh read of the box sensors.
- An unhandled promise rejection is logged instead of terminating the integration.

### Security

- The AirSend Web Service tarball is downloaded over HTTPS and checked against a pinned SHA-256 at build time.

### Changed

- Node.js 22 or later is required (`engines`); CI tests on Node 22 and 24 and builds the image on pull requests. Dependabot also watches the Docker base image.

## [2.2.0] - 2026-10-07

- Maintenance release, no functional change.

## [2.1.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

### Fixed

- An AirSend box declared with `sensors: true` is published with a `poll_frequency` Gladys accepts (in milliseconds) and `should_poll: true`: its `refresh` in seconds made Gladys reject the whole discovery, leaving the Discovery tab empty for every device. The `refresh` interval is now enforced by the integration.

## [2.0.5] - 2026-10-06

### Fixed

- Follow a declared wall remote whatever grade the box gives its frame

## [2.0.4] - 2026-10-06

### Fixed

- A wall remote updates the current state of what it drives

## [2.0.3] - 2026-10-02

### Fixed

- Give button, switch and light on/off features a min and max

## [2.0.2] - 2026-09-28

### Fixed

- Never attach a remote by its protocol alone when the box decodes its address

## [2.0.1] - 2026-09-28

### Fixed

- Log times match the widget, and attaching a remote says what the box will really hear

## [2.0.0] - 2026-09-28

### Added

- Gladys 5.1 scenes and dashboard widget, and four radio fixes

## [1.0.18] - 2026-08-20

### Added

- Name what the box refused, instead of blaming the radio
- Keep the link to the box warm, and say where a slow order lost its time
- Let the box say how fast its link goes cold

## [1.0.17] - 2026-08-18

- Maintenance release, no functional change.

## [1.0.16] - 2026-08-18

### Added

- Say what is wrong with a connection string, instead of quoting the 401

### Fixed

- Stop asking for square brackets, and show the string that is refused

## [1.0.15] - 2026-08-18

### Added

- Let a shutter be driven with the orders its protocol answers to

## [1.0.14] - 2026-08-17

### Added

- Show which protocols the box can be asked to listen to
- Name the protocol a pid stands for, wherever a pid is printed
- Let the generic 433 MHz decoder be asked for by name

### Fixed

- Let the listening channel be left empty, since empty is the answer

## [1.0.13] - 2026-08-17

### Added

- Recognize our own voice, and quote every button a remote presses

## [1.0.12] - 2026-08-17

### Added

- Answer the order first, and say what the listener will never hear

## [1.0.11] - 2026-08-16

### Added

- Say what a dropped frame carried, and how to make it usable

## [1.0.10] - 2026-08-16

### Added

- Tell the three silences of a radio that hears nothing apart

## [1.0.9] - 2026-08-16

### Added

- Get the order through, and stop hearing ourselves

## [1.0.8] - 2026-08-16

### Added

- Say what the box heard, and what the devices made of it

## [1.0.7] - 2026-08-15

### Added

- Write the wall-remote configuration line, and stop failing in silence

## [1.0.6] - 2026-08-15

### Added

- Switch the detailed logs on from the Configuration screen

## [1.0.5] - 2026-08-15

### Changed

- Drop the "environment" store category

### Fixed

- Surface the radio frames an 868 MHz remote actually sends

## [1.0.4] - 2026-08-15

### Fixed

- Log a frame from an undeclared emitter whatever its notes say

## [1.0.3] - 2026-08-15

### Changed

- Declare the store categories, on SDK 0.12 and Gladys 4.86

### Fixed

- Listen to the protocol of the declared devices, not to channel 1

## [1.0.2] - 2026-08-14

### Fixed

- Receive the radio frames the box hears, without Gladys Plus

## [1.0.1] - 2026-08-14

First public release.

### Added

- Compute the position of a shutter from its travel time

[Unreleased]: https://github.com/prohand/gladys-devmel/compare/v3.0.1...HEAD
[3.0.1]: https://github.com/prohand/gladys-devmel/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/prohand/gladys-devmel/compare/v2.2.4...v3.0.0
[2.2.4]: https://github.com/prohand/gladys-devmel/compare/v2.2.3...v2.2.4
[2.2.3]: https://github.com/prohand/gladys-devmel/compare/v2.2.2...v2.2.3
[2.2.2]: https://github.com/prohand/gladys-devmel/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/prohand/gladys-devmel/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/prohand/gladys-devmel/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/prohand/gladys-devmel/compare/v2.0.5...v2.1.0
[2.0.5]: https://github.com/prohand/gladys-devmel/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/prohand/gladys-devmel/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/prohand/gladys-devmel/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/prohand/gladys-devmel/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/prohand/gladys-devmel/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/prohand/gladys-devmel/compare/v1.0.18...v2.0.0
[1.0.18]: https://github.com/prohand/gladys-devmel/compare/v1.0.17...v1.0.18
[1.0.17]: https://github.com/prohand/gladys-devmel/compare/v1.0.16...v1.0.17
[1.0.16]: https://github.com/prohand/gladys-devmel/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/prohand/gladys-devmel/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/prohand/gladys-devmel/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/prohand/gladys-devmel/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/prohand/gladys-devmel/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/prohand/gladys-devmel/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/prohand/gladys-devmel/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/prohand/gladys-devmel/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/prohand/gladys-devmel/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/prohand/gladys-devmel/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/prohand/gladys-devmel/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/prohand/gladys-devmel/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-devmel/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-devmel/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-devmel/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-devmel/releases/tag/v1.0.1
