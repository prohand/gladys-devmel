# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

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

[Unreleased]: https://github.com/prohand/gladys-devmel/compare/v2.2.4...HEAD
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
