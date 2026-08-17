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

| `type` | Device                | What you get in Gladys                          |
| ------ | --------------------- | ----------------------------------------------- |
| `0`    | AirSend box           | Its temperature and light sensors               |
| `1`    | Radio sensor / remote | The readings it emits (see `features` below)    |
| `4096` | Button                | A push button sending TOGGLE                    |
| `4097` | Switch                | On/Off                                          |
| `4098` | Shutter               | Open / Stop / Close (**+** position once timed) |
| `4099` | Shutter with position | Open / Stop / Close **+** a 0-100 % position    |
| `4100` | Dimmable light        | On/Off **+** brightness                         |

### Device options

| Option              | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `type`              | Device type (table above), **required**                                    |
| `channel`           | Radio channel (`id`, `source`, `mac`, `seed`), **required**                |
| `pid`               | The `channel.id` of the JSON export (use either form)                      |
| `addr`              | The `channel.source` of the JSON export                                    |
| `remotes`           | Other emitters driving the device (see "The wall remote")                  |
| `spurl`             | Connection string of this device, if it differs from the global one        |
| `wait`              | Wait for the radio confirmation before answering (`false` by default)      |
| `repeat`            | Extra emissions of the orders sent to this device (see below)              |
| `invert`            | Swap open and close, for shutters installed the other way round            |
| `travel_up`         | On a shutter: seconds for a full opening (see below)                       |
| `travel_down`       | On a shutter: seconds for a full closing                                   |
| `travel`            | Both at once, for a motor that behaves the same in either direction        |
| `favorite_position` | On a shutter: the position programmed in the motor, in %                   |
| `sensors`           | On a box (`type: 0`), expose its temperature and light sensors             |
| `refresh`           | Read interval of those sensors, in seconds                                 |
| `features`          | On a sensor (`type: 1`): `temperature`, `humidity`, `illuminance`, `click` |

A box declared without `sensors: true` creates no device in Gladys — it is
only there to carry the connection string.

## Getting an order through

Nothing acknowledges a radio order. A 433 MHz shutter has no way back: the box
transmits, and nobody will ever say whether the motor heard it. A frame lost in
the noise — a microwave, the neighbour's remote, a garage door — is therefore
not an error shown anywhere, it is a click that did nothing. That is exactly
what "I have to press Open two or three times" is made of.

Three things answer it, with nothing to set:

- **orders go out one at a time.** A box has one radio: while it transmits it
  hears nothing, and a second order fired straight after reaches a box that is
  still busy. Orders therefore queue up, a quarter of a second apart, in the
  order you gave them;
- **an order the box could not carry is sent again.** A refusal is not: a
  rejected connection string and an unknown channel answer exactly the same way
  the second time;
- **an order is repeated on the air**, the way a real remote repeats it for as
  long as the button is held. By default every order goes out twice.

The **Command repeats** field sets that number of extra emissions: raise it to
`2` or `3` if a device still ignores Gladys now and then, `0` sends each order
once. A stubborn device can have its own, without changing anything for the
others:

```json
{ "devices": { "Patio door": { "type": 4098, "pid": 25455, "addr": 8295, "repeat": 3 } } }
```

Only orders that mean the same thing twice are repeated — Open, Stop, Close, a
position. A push button TOGGLE goes out once: heard twice, it is back where it
started.

Those repeats do **not** make the interface wait: Gladys is answered as soon as
the order is on the air, and the repeats keep going behind it, in their place in
the queue. They are a second chance for a frame lost in the noise, not part of
the answer — and re-arming the listener, which needs the radio too, now waits
for the queue to empty instead of slipping between two orders. That is what made
a "Close" clicked right after an "Open" take a few seconds to go out.

### Gladys does not mistake itself for the remote

Everything the integration transmits comes back to it: the box answers the
order, and since it listens permanently, it hears itself transmitting. That echo
carries the order just sent — and reading it as a fresh order undoes what the
order was doing. A timed shutter sent to 40 % is the example: the echo of its
"Open" retargeted it at 100 % and cancelled the Stop due half way, so the
shutter ran to the top. The integration now recognizes its own orders and does
not replay them.

What identifies an echo is **the address it comes from**. The channel Gladys
transmits on is the box's own: nothing else in the house speaks with that voice,
whatever the delay. A box that takes ten seconds to repeat itself is no longer
mistaken for a hand on a remote — which was enough to send a shutter stopped at
40 % back to the top.

Two visible consequences:

- a wall remote emits from **another address**: it is never taken for that echo,
  and goes on driving the shutter in Gladys;
- when the box answers that it **could not transmit**, the integration writes it
  in its logs, naming the device. It is the only trace of an order that went
  nowhere, and it is worth a look if you often click twice.

## The position of a shutter

A 433 MHz shutter never says where it is: the radio carries orders, not
positions. What it does have is a **duration** — a given motor always takes the
same time to travel from one end stop to the other. Time that travel once and
the position becomes computable.

Time your shutter with a stopwatch, from the moment it starts moving to the
moment it stops by itself, and write the two durations down:

```json
{
  "devices": {
    "Living room shutter": {
      "type": 4098,
      "travel_up": 22,
      "travel_down": 20,
      "channel": { "id": 25455, "source": 94311 }
    }
  }
}
```

From then on the integration follows the shutter second by second, whether the
order came from Gladys or from a wall remote it heard on the radio (which needs
the listening channel below). Three things follow:

- a **`4098` gets a position too** — the feature appears as soon as the shutter
  is timed, and its slider drives the motor with a timed Open/Stop: the
  integration starts the shutter in the right direction and sends the Stop at
  the moment the travel says it has arrived;
- **Stop is honest**: a shutter stopped half-way reports the position it
  actually reached, instead of keeping the 100 % the order had announced;
- **the estimate repairs itself**: a shutter allowed to reach an end stop is at
  exactly 0 % or 100 %, because the motor physically stops there. Every full
  open or close wipes the error accumulated by the previous partial travels.

Expect around ±5 % of accuracy: a motor slows down under load and in the cold.
If a shutter drifts, a scenario opening it fully once a day is enough to keep
it in step.

A shutter you did not time keeps its previous behaviour: Gladys shows the
destination of the last order, which is all a one-way protocol can offer.

Two more things worth knowing:

- until its first full travel, a timed shutter's position is **unknown**, and
  the integration publishes nothing rather than inventing a value. Open or
  close it once and it is set. Asking for a position before that sends the
  shutter to the nearest end stop, which is exactly what establishes the
  reference;
- the position is **remembered across restarts** of the integration: it starts
  again from the value Gladys kept.

### The favourite position

Many motors have a position of their own, programmed in the hardware (the
Somfy "my" button). The radio says "go to your position" without ever saying
what that position is. Measure it once and declare it with
`"favorite_position": 40`: pressing that button then reports 40 % in Gladys.
Without it, the shutter is reported as stopped somewhere in between — the
honest answer.

## Listening to the radio

The AirSend box can forward every frame it hears — a wall remote pressed by
hand, a weather sensor waking up — so Gladys follows what happens in the house
instead of only what it ordered itself. It is what makes the position of a
shutter move when it is opened from its own remote.

It is **on by default**, and there is nothing to set: the integration
subscribes the box to the radio protocol of your devices and receives the
frames itself. Nothing to install, nothing to link.

The subscription is **re-armed after every order**, and renewed every ten
minutes. Transmitting takes the box out of reception, and a subscription that
did not survive a command is a wall remote Gladys silently stops following —
until the next renewal.

### The listening channel

What the box listens to is a **protocol**, not a device: it has one radio, and
subscribing switches it to permanent reception **of a single protocol** at a
time. Channel `1` is generic 433 MHz listening, which covers the protocols
built to fit in it — but not the others, and a Somfy shutter listened to on
channel `1` stays as silent as a remote nobody presses.

So the integration does not guess: it asks the AirSend service which channel
decodes which protocol, and subscribes the box to the one your devices use.
Leave the **Listening channel** field empty.

Fill it in only to listen to something else: the `pid` of a protocol you have
not declared yet, `1` for generic listening, or `0` to turn listening off.

To check, click **Test the connection**: the _Listening_ line says which
protocol is listened to, which devices it covers, and where the frames are
pushed — or why they are not.

When two protocols are declared equally — a shutter on one side, the wall remote
attached to it on the other — the one that **emits** wins. A shutter, a switch,
a lamp do not talk: they are talked to. A remote declared in `remotes` is there
precisely to be heard, so that is what the box is subscribed to.

#### A protocol nobody speaks on

If nothing declared on the channel being listened to ever emits by itself, the
subscription is armed, the route works, and nothing will ever come through it:
the box will only hear the echo of Gladys' own orders. That is the normal state
of a house where only shutters are declared — and it looks exactly like a
listener that never armed, so the integration says it out loud, in its logs at
startup and in the _Listening_ line of **Test the connection**:

```text
Nothing declared on channel 25455 emits by itself: shutters, switches and lamps
are talked to, they do not talk. The box will hear the echo of Gladys own orders
and nothing else.
```

The way out is the same one as everywhere else on this page: attach the wall
remote that drives the equipment (see below). It has its own address, it is a
real emitter, and once declared it is what the deduction listens to.

### 868 MHz and rolling code

Channel `1`, the generic listening, **is 433 MHz**. An 868 MHz protocol —
Profalux, Somfy io — is not heard on it at all. And as long as you have declared
nothing, there is nothing to deduce from, so the integration falls back to that
channel `1` by default: the box then listens to the wrong band, and the silence
that follows looks exactly like a remote nobody presses. The integration now
says so, in its logs and in **Test the connection**.

Two ways out: declare a device on that protocol, or fill in its `pid` as the
**Listening channel**.

The **rolling code** of those remotes is not what stops the frames from coming
in. It protects _emission_: to drive a Profalux shutter, the AirSend box has to
have been paired with the motor, like one more remote. On _reception_ it gets in
the way of nothing: the counter and the `mac` / `seed` fields change on every
frame, and the integration ignores them on purpose — an emitter is identified by
its `pid` and its `addr`, and those do not move.

What the rolling code does change is the **decoding**: the AirSend service only
partially decodes those protocols. The frame arrives, the emitter is named, but
it carries no usable note. Such frames are now logged with their `pid` and
`addr`: proof that the radio works, and what you need to attach the emitter to a
device.

### The wall remote

One shutter is driven by several emitters: the AirSend box, and the remote
screwed on the wall. They speak the same protocol from **different addresses**,
so the box hears them on different channels, and a frame coming from the wall
belongs to no declared device. It is logged by the integration, with its `pid`
and its `addr`.

Attach that address to the device it drives, and pressing the wall remote
updates the shutter in Gladys just like Gladys itself would:

```json
{
  "devices": {
    "Living room shutter": {
      "type": 4098,
      "travel_up": 30,
      "travel_down": 26,
      "channel": { "id": 25455, "source": 8295 },
      "remotes": [94311]
    }
  }
}
```

A bare address is read on the protocol of the device itself; a remote on
another protocol is written in full: `"remotes": [{ "pid": 1368, "addr": 542 }]`.

#### Let the integration write that line

Copying a `pid`/`addr` pair out of a log into one-line JSON, in the right
spelling, is exactly the kind of thing one gets wrong every other time. The
**Attach a remote** action does it for you:

1. press the wall remote (the integration remembers the emitters it hears,
   including the ones nobody declares);
2. in the Configuration screen, run **Attach a remote** and pick the device it
   drives;
3. the action answers with your device list, unchanged, the remote attached as
   `{"pid": …, "addr": …}`: paste it into the **Devices** field and save.

It attaches the **last** emitter heard that no device claims, and names the
others without touching them. It also says what its frames decoded to, and
warns when the remote speaks another protocol than the device: the box listens
to one at a time.

#### A frame dropped, or one with no address

The box grades every frame it decodes, and the integration ignores the ones it
grades badly — exactly as the official Jeedom plugin does. Two very different
shapes in the logs:

```text
Ignored a radio frame (unreliable, graded 0): pid 14177, carrying no note the service could decode.
Ignored a radio frame (unreliable, graded 2): pid 25455, addr 94311, carrying level 100 (up).
```

**A frame with an address, graded too low** (second line): the box decoded both
the emitter and the order, it is simply not confident — a remote at the edge of
its range, a crowded band. Turn on **Accept unreliable frames**: they are then
used anyway, at the price of the occasional false trigger.

**A frame with no address** (first line, a `pid` and nothing else): the box
picked the protocol up **without decoding it**. There is no emitter to name and
no order to replay, and no setting makes usable what was never decoded. It is
the signature of a box listening to the **wrong decoder**: put that `pid` in the
**Listening channel** field so the box listens to that protocol on its own
decoder, then run **Test the connection** again. If the frames come back with an
address, attach it as usual.

If the protocol stays address-less even on its own channel, the AirSend service
only decodes it partially (868 MHz rolling code) and no software setting will
change that. As a last resort, a device can follow **every** unattributed frame
of a protocol:

```json
{
  "devices": {
    "Patio door": { "type": 4098, "pid": 25455, "addr": 8295, "remotes": [{ "pid": 14177 }] }
  }
}
```

A `remotes` entry reduced to a `pid` no longer names a remote but a whole
protocol: a neighbour's remote on that protocol will drive your shutter. Use it
knowingly.

#### The remote is attached, and nothing moves

Once the emitter is declared the frame does reach the device — what remains is
whether it **carries an order**. Start with **Test the connection**: its _Heard_
line answers without going through the logs (see "What the box actually heard").
It tells apart three cases that look alike and are unrelated:

- `declared on Living room shutter, but its frames carry no order to replay` —
  the frame arrived, the device has no use for it. That is the fate of
  rolling-code 868 MHz protocols: the service only decodes them partially, so the
  frame proves the radio works but carries nothing to replay. **The position
  cannot follow**, and attaching the remote cannot change that; on the first
  frame from that emitter the integration says so in the logs too, at info level
  (`no note the service could decode`);
- `no device declares it` — the emitter is heard, it is simply attached to
  nothing: run **Attach a remote** again;
- the emitter is not listed at all — the frame no longer arrives. When the remote
  was declared on another protocol than its device, the _Listening_ line names it
  as unheard, and putting its `pid` in the **Listening channel** field listens to
  its side instead.

**Nothing in the logs after a press?** The line is written when a frame comes
in: press the remote, then read the logs of the integration again. If there is
still nothing, the frame never arrived, and there are only three reasons why:

- **listening is not in place.** Click **Test the connection**: the _Listening_
  line says which protocol is listened to and where the frames are pushed — or
  why they are not;
- **the remote speaks another protocol.** The box listens to a single one at a
  time, the one of your declared devices (see "The listening channel"). A wall
  remote normally uses the protocol of the shutter it drives; if yours is of
  another make, put its `pid` in the **Listening channel** field long enough to
  spot it;
- **the frame was heard, but graded too doubtful to be published.** Radio is
  noisy, and the box grades every frame it decodes. Turn on **Detailed logs
  (debug)**: those frames are traced there too, with their `pid`, their `addr`
  and the reason they went no further.

#### What a press writes in the logs

Each of those lines is said **once per emitter** — a remote held down emits a
frame every half second, and a log that scrolls is a log nobody reads. The
counter is re-armed **every time you save the configuration**: you changed
something because it did not work, and the very next press is the one you are
watching for.

So after saving, one press writes exactly one line, and which line it is says
where the frame stopped:

```text
Heard pid 25455, addr 94311 -> "Baie vitrée" followed it: level 0 (down).
Heard a frame on a channel no device declares: pid 14177, addr 3359265281.
Heard pid 14177, addr 3359265281 for "Baie vitrée", but no note the service could decode
Ignored a radio frame (unreliable, graded 2): pid 25455, addr 94311, carrying level 100 (up).
```

The first one is the only one that says it works — and it is worth reading twice
before blaming the integration for a shutter that did not move: the frame was
heard, routed and followed, so what is left is between the order and the motor.
No line at all means no frame arrived; see the three reasons above.

#### Is that really my remote?

An emitter heard is not proof it is the one in your hand: 433 MHz is a public
band, and the neighbourhood is on it too. Press yours five times, then run
**Test the connection** and read the counter of the emitter under _Heard_:

```text
pid 14177, addr 3359265281 (5 frames, last one 3 s ago, no decoded note)
```

Five frames and "3 s ago" is your remote. A counter that does not move while you
press is somebody else's, and attaching it declares a stranger's remote on your
shutter.

### What the box actually heard

Every check above answers "can the frames get in?". The _Heard_ line of **Test
the connection** answers the next question, the only one that matters once a
remote is attached: **did they, and did anything move?**

The integration remembers the emitters it hears, most recent first, with how
many frames each sent, how long ago, what they decoded to, and what the devices
made of them:

```text
Heard: 1 emitter heard: pid 14177, addr 3359265281 (3 frames, last one 4 s ago,
no decoded note) — declared on Living room shutter, but its frames carry no
order to replay (a protocol the service only partially decodes): the position
cannot follow.
```

Three possible verdicts per emitter:

| Verdict                    | What it means                                                             |
| -------------------------- | ------------------------------------------------------------------------- |
| `followed by <device>`     | it works: those frames do drive the device                                |
| `no device declares it`    | the emitter is heard but attached to nothing — **Attach a remote**        |
| `carry no order to replay` | the frame reaches its device and carries nothing to replay (rolling code) |

The line quotes **every** distinct note an emitter has been heard saying, not
just its last frame — that is what tells a remote whose buttons the service
decodes (`notes: level 100 (up); level 0 (down); state stop`) from one whose
every button decodes to the same order. The second is a `followed by` that moves
nothing: a STOP replayed on a shutter that is not moving changes a state, not a
percentage. The report now says so and offers the check: press Open, then Close,
and run the action again. If the note does not change, the AirSend service does
not decode the buttons of that remote, and the position cannot follow.

The echoes of your own orders are not emitters: they are counted apart, at the
end of the line (`Plus 3 echoes of your own orders`). That is the proof the
frames have a route back in, even when nothing else is heard.

The registry is emptied when the integration restarts: "no radio frame since the
integration started" means "nothing since then", not "never". Press the remote,
then run the action again.

#### Three silences that look alike

"Nothing heard" covers three very different problems, and the _Heard_ line now
tells them apart:

| What it says                                    | What is going on                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `no radio frame since the integration started`  | nothing gets in at all: neither the frames of the house nor the echoes of your own orders |
| `no frame from any other emitter, but N echoes` | the route works — the box simply hears nothing else on the protocol it listens to         |
| `N frames arrived and were dropped`             | the radio works: it is the frames themselves that were not usable                         |

Hence the test to run when the line says "no radio frame": **drive a device from
Gladys**, then run the action again. Everything the integration transmits comes
back to it, so the echo of that order must show up in the counter.

- the echo comes back → the route is fine, and it is the **protocol being
  listened to** that is not your remote's. Read the _Listening_ line again: it
  says which channel is bound and which devices it covers. An 868 MHz remote
  (Profalux, Somfy io) is never heard on channel `1`, which is 433 MHz;
- the echo does not come back either → the problem is upstream of the radio: the
  AirSend service posts nothing to the integration. Check the _Listening_ line
  (did the box accept the subscription?) and the _Local_ line (does the service
  answer?), then the detailed logs.

### Detailed logs

Radio is the one part of this integration nobody can watch: a remote that never
shows up is either unheard, dropped as unreliable, or heard and undecodable —
and only the debug logs tell those three apart.

The **Detailed logs (debug)** field of the Configuration screen turns them on.
It takes effect at once, with no restart: tick it, press the remote, read the
logs, untick it. It is verbose, and not meant to stay on.

Your `sp://` connection string is never logged, at any level.

If you would rather use the container environment variable, `LOG_LEVEL` still
works and still wins: the switch raises the level to debug while it is on, then
hands your `LOG_LEVEL` back when you turn it off.

### If you run the AirSend service elsewhere

The AirSend Web Service pushes the frames from the machine it runs on. When the
integration is the one running it (the default), it pushes them straight to the
integration. A service running **on another machine** has no way to reach the
integration, so the frames have to go through a public URL, which Gladys Plus
provides: link your Gladys Plus account and paste your Open API key in the
**Webhooks** block of the Configuration screen.

## Actions

- **Test the connection** — checks the local channel, says which protocol is
  listened to, **what the box actually heard**, and which devices were parsed.
  The fastest way to spot a mistyped connection string, a device list that did
  not parse, or an attached remote whose frames carry no order.
- **Attach a remote** — press the remote, pick the device it drives: the action
  writes the device list to paste back, remote included (see "The wall remote").
- **Identify a device** — pick a device and it is sent a PING. Not every piece
  of 433 MHz equipment reacts to it.

## Good to know

- 433 MHz is a **one-way** protocol for most equipment: nothing confirms an
  order was received, and Gladys shows the value it sent. Listening (above) is
  what turns that assumption into a real state, and timing a shutter (above) is
  what gives it a position.
- Sensors are read from the **box itself**, over the local channel.
- The built-in service reaches your box **from inside the integration's
  container**, over your LAN: the `rhost=<IPv4>` of the connection string is
  the address it dials, and it has to be routable from the Gladys host.
- Changing the `type` of a device in the list creates a new device in Gladys
  (the identifier changes) — except between `4098` and `4099`, which share it.

## Troubleshooting

| Symptom                            | What to check                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `Invalid connection string`        | The `sp://` URL, and that its password matches the box                                 |
| `Invalid input`                    | The `channel` of the device (`id`/`pid` and `source`/`addr`)                           |
| `no radio channel` in the logs     | The entry carries no channel: it needs `channel.id`, or the `pid`/`addr` pair          |
| `no radio confirmation`            | Normal on equipment without feedback: set `wait: false`                                |
| No device in the Discovery tab     | **Test the connection**: the device list probably did not parse                        |
| The box is unreachable             | The `?gw=0&rhost=<IPv4>` part of the connection string                                 |
| `Built-in service unavailable`     | The integration logs: the service logs its own startup there                           |
| The box answers by hand, not here  | The `rhost=` IPv4 must be reachable **from the container**, not just from your desktop |
| You have to click several times    | Raise **Command repeats** to `2` or `3`, or the device's own `repeat`                  |
| A shutter shows no position        | Time it: `travel_up` / `travel_down`, then open or close it fully once                 |
| The position drifts over time      | Re-time the travel, and open the shutter fully once a day to resynchronize it          |
| No frame from an 868 MHz remote    | **Test the connection**: channel `1` is 433 MHz. Declare the device, or its `pid`      |
| Remote attached, nothing moves     | **Test the connection**, _Heard_ line: it says whether the frames carry an order       |
| `unreliable, graded N` in the logs | A frame graded too low: **Accept unreliable frames**, or move the box closer           |
| A frame with a `pid` and no `addr` | The protocol is not decoded: put that `pid` in **Listening channel**                   |

The integration logs everything it does: read the integration logs from the
Gladys UI (or `docker logs` on the host), and tick **Detailed logs (debug)** in
its configuration for the full detail.
