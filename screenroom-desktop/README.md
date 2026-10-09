# screenroom-desktop

Desktop sharing client for [MygleTV](../screenroom). This is where
**per-application audio capture** lives, because no browser can do it:

- **Firefox** supports audio only for a shared *tab*, and never system or
  application audio.
- **Chromium** can do per-window audio on Windows (Chrome 141+), but not on
  Linux, where the feature is still tracked as unstable.
- **Electron's** documented capture path gives you `audio: 'loopback'`, the
  *whole system mix* — Discord included. An open-source Electron Discord client
  ([Legcord #815](https://github.com/Legcord/Legcord/issues/815)) shows that
  failing in practice.

So we go around the browser and do the routing ourselves.

## Status

**The Linux path is built and verified against live PipeWire.**
The Electron shell is written but has never been executed — see *What is not
verified* below. Windows is not started. macOS is out of scope.

## The Linux approach

The picker offers exactly two kinds of choice, because that is all anyone
actually wants:

| Choice | What it does | Destructive? |
| --- | --- | --- |
| **Only &lt;application&gt;** | Just that app's audio, so a game goes to your friends without Discord | yes — looped back |
| **All system audio** | Everything the machine is playing | **no — a pure tap** |

Plus *No audio*, for sharing silently.

### Only one application

1. Create a private null-sink (`module-null-sink`)
2. Add a loopback from that sink's monitor back to the real output
3. Wrap the monitor as a real source (`module-remap-source`)
4. Move **every** stream the chosen application owns onto the private sink
5. The renderer captures the wrapped source with `getUserMedia`

**Step 2 is what makes this humane.** Routing is destructive: a stream moved to
a null-sink goes silent for the user. That loopback is the monitoring path they
would otherwise build by hand, as they do with a virtual audio cable. Here the
app creates and removes it automatically.

**Step 3 is not optional, and finding that out was the point of the spike.**
Chromium hides `*.monitor` sources from `enumerateDevices()` — verified against
Chrome 148 on PipeWire 1.6.9, which listed only the real microphones. Handing
the renderer a monitor name is useless. `module-remap-source` presents the
monitor as a normal source, which Chromium then offers and captures happily.

### All system audio

Remap the **default sink's** monitor and capture that. Nothing is moved, so no
loopback is needed and the user keeps hearing everything exactly as before —
it is a tap, not a detour.

**This taps the default sink only.** Audio routed to a different output is not
included. That is not hypothetical: a capture card linked straight to the
speakers in PipeWire plays to whichever sink it was linked to, which need not be
the default. Measured on one such setup, the default sink's monitor carried
silence while the other carried the audio. Setting the sink that has the sound as
the default fixes it — or use the audio-device route below.

### An audio device

The picker also lists **audio inputs** under their own heading, and capturing one
is a plain `getUserMedia` on that device: no routing, no null sinks, nothing
changed on the system.

This is the route for sound that **no application owns**. A capture card wired
directly to the output produces no application stream at all, so "only this app"
has nothing to find and "all system audio" taps the wrong sink — yet the card is
still an ordinary audio input, and this captures it. It works equally for a
microphone or an audio interface.

Device labels are withheld by the browser until the page has been granted audio
access once, so the first time the list is opened it asks for the default input
and releases it immediately. Our own capture sources are excluded, since sharing
them back would be a feedback loop.

Because every route ends in an ordinary input device, the renderer uses plain
`getUserMedia` — **no PCM plumbing and no AudioWorklet on Linux.** That is a
Windows-only problem.

## Layout

```
screenroom-desktop/
  main.js                    composition root: assembles the dependencies
  shell.js                   Electron wiring (IPC, capture handler, lifecycle)
  app-server.js              starts the bundled web server for local use
  preload.cjs                contextBridge -> window.screenroomNative
  audio/linux.js             pactl routing: probe, list, sink, remap, route, restore
  audio/session.js           capture lifecycle (set up / roll back / tear down)
  spike/linux-spike.mjs      interactive end-to-end CLI
  test/linux-router.test.mjs 22 tests: parsing, ordering, error tolerance
  test/session.test.mjs       9 tests: lifecycle and rollback
  test/shell.test.mjs        23 tests: Electron wiring, driven with fakes
  test/app-server.test.mjs    6 tests: spawns a real server and talks to it
  test/monitor-capture-check.mjs   does Chromium capture the source?
  test/shell-integration-check.mjs frontend <-> bridge, in real Chrome
```

The frontend additions live in the shared web app so both builds use one copy:
`screenroom/public/audio-source.js`, plus an audio picker in
`screenroom/public/app.js` that only appears when `window.screenroomNative`
exists. In a browser nothing changes.

`signaling.js` and `peers.js` are untouched. Signaling derives its WebSocket URL
from `location.host`, which means the shell must load a MygleTV *origin* —
one that serves both the app and the `/ws` signaling endpoint. So the shell
brings up its own server unless you point it elsewhere.

```sh
npm install
npm start                                    # starts a local server and uses it
SCREENROOM_URL=https://screens.example.com/ npm start   # use a deployment
SCREENROOM_PORT=8090 npm start               # local server on another port
```

`npm start` on its own is enough: it spawns the bundled `screenroom/server.js`
using Electron's own Node (`ELECTRON_RUN_AS_NODE`), so no system Node install is
needed. For friends to reach you, either run that server somewhere they can
reach and point them at it, or point the shell at a deployment with
`SCREENROOM_URL`.

**A failure is never a blank window.** If the origin cannot be reached, or the
server will not start, the shell renders an explanation saying which address
failed and how to fix it — the first version showed an empty dark page, which
told you nothing.

## Installing on Linux

So you do not have to run it from a terminal:

```sh
npm run install:desktop     # adds a MygleTV entry to the application menu
npm run uninstall:desktop   # removes it
```

The launcher points at **this checkout**, so the menu entry always runs the
current code and there is nothing to rebuild after a `git pull`. The trade-off is
that moving or deleting the checkout breaks the entry — run `uninstall:desktop`
before relocating it.

It writes two files, both per-user and both trivially reversible:

```
~/.local/share/applications/mygletv.desktop
~/.local/share/icons/hicolor/scalable/apps/mygletv.svg
```

**No environment variable is needed.** `main.js` defaults to the deployed relay,
the same way the Windows build does, so a launcher has nothing to configure.
Point it elsewhere only if you want a different relay:

```sh
SCREENROOM_URL=https://other-relay.example/ npm start
--url=            # start local mode instead (bundled server, this machine only)
```

## Commands

```sh
npm test                    # 109 unit tests, no sound server needed
npm run start               # run the app (menu entry does this too)
npm run spike:linux -- --list      # probe the environment
npm run spike:linux -- --tone      # self-test with a generated tone
npm run spike:linux -- --app firefox
npm run check:monitor       # can Chromium capture the source? (real PipeWire)
npm run check:shell         # frontend <-> bridge integration (real Chrome)
npm run check:proxy         # works behind a TLS reverse proxy (real Chrome)
npm run check:taploop       # the system tap survives create/destroy cycles
npm run check:linux-parity  # the Linux client renders the full player and quality
```

`--tone` generates a gated sine, routes it, records the monitor and checks the
result, so the whole chain can be verified without touching whatever the user is
listening to. `--crash` signals the process mid-share to prove the exit handler
restores audio.

## What is verified

Against PipeWire **1.6.9** (pipewire-pulse), Arch-family host, SteelSeries
Arctis Nova 3P as the default sink:

| Check | Result |
| --- | --- |
| Environment probe (server, version, JSON, default sink) | works |
| Listing applications currently producing audio | works |
| Create sink, virtual mic, monitor loopback | works |
| Route a native PipeWire client (`pw-play`) | works |
| Route a PulseAudio-protocol client (Firefox) | works |
| Capture one application's audio (spike, `parecord`) | **PASS** — peak 13107/32767 on a 0.4-amplitude tone |
| Chromium captures the remapped source via `getUserMedia` | **PASS** — level 0.5000 on a 0.5-amplitude tone |
| Raw monitor visible to Chromium | **no** — hence the remap |
| Restore on normal exit | clean, no leftovers |
| Restore after a simulated crash | clean, no leftovers |
| Frontend: picker offers the two real choices, captures both modes | **21/21 checks pass** |
| Electron wiring: IPC, capture handler, lifecycle, error pages | **23/23 tests pass** |
| Bundled server: spawns, serves the app, speaks `/ws`, frees its port | **6/6 tests pass** |
| Behind a TLS reverse proxy (the shape of every deployment) | **6/6 checks pass** |
| Stale-module sweep against live PipeWire | **PASS** - clears ours, leaves other apps' sinks alone |
| 80 unit tests (parsing, ordering, rollback, wiring, startup, grouping, modes, sweep) | all pass |
| Web app suite still green (signaling, WebRTC, two-browser e2e) | all pass |

After every run: no leftover sink, no leftover module, and applications back on
their original sink.

## What is NOT verified

**The Electron shell has never been executed**, and it cannot be here. Electron
44.5.1 dies with `SIGTRAP` before `app.whenReady()` resolves. The cause is now
known rather than guessed:

- `/dev/dri` does not exist — the sandbox exposes only 13 device nodes
  (`null`, `zero`, `random`, …) and no DRM render nodes, so Chromium's graphics
  stack cannot initialise. (`drmGetDevices2() has not found any devices`)
- `/tmp/.X11-unix` is masked, so there is no X11 socket. The Wayland socket at
  `/run/user/1000/wayland-0` *is* reachable, so this is not a Wayland problem —
  it is the missing GPU devices.

Every flag combination tried fails identically: `--no-sandbox`,
`--disable-gpu`, `--ozone-platform=headless`, `--ozone-platform=wayland`,
`--single-process`, `--no-zygote`, `--in-process-gpu`,
`--disable-seccomp-filter-sandbox`, `--headless`, `--disable-setuid-sandbox`.

Because of that, `shell.js` takes every Electron module as a parameter and
`test/shell.test.mjs` drives it with fakes. That covers which IPC channels
exist, what each returns on failure, that replacing a capture stops the old one
first, how the capture handler behaves with no sources or a throwing portal, and
that quitting restores audio. **What remains unverified is only whether
Electron itself launches and paints** — not the logic it runs.

Consequently the first thing to do on a real desktop is simply:

```sh
npm install && npm start
```

Known gaps to expect there:

- The display-capture fallback silently picks the first screen when no system
  picker is available (`TODO` in `shell.js`). An in-app picker is needed. On
  KDE/Wayland the xdg-desktop-portal picker should be used instead.
- `useSystemPicker: true` is documented as experimental and platform-dependent.
- The Electron and Chromium versions here were never exercised together.

## Findings worth knowing

**PipeWire does not reliably expose `application.process.id`.** `pw-play`
reports *no* PID at all, while Chromium and Firefox do. The process-based
identification Windows uses does not map here; the picker must key off
`application.name` / `media.name`, with the PID as optional metadata.

**`device.description` truncates at the first space.** PulseAudio parses
`source_properties` by splitting on whitespace, so
`device.description=MygleTV-System` silently became just `MygleTV`. The
system tap therefore carried the *same* label as the application mic, while the
renderer was searching for `MygleTV-System` and failing with "the MygleTV
System audio source did not appear". Escaping the space, quoting the value and
quoting the whole property all truncate identically, so device labels must not
contain whitespace at all -- a test enforces that now.

**A failed audio source must never cost you the screen share.** The audio path
runs first, because the capture source has to exist before the renderer looks
for it. Originally a failure there aborted the whole share, so an audio problem
presented as "the screen picker never opened" -- a completely misleading
symptom. Now the share proceeds silently and says so: *"System audio
unavailable (...). Sharing without sound."*

**"Device did not appear" hides which end failed.** A module can load and still
not produce its node, and the renderer's only symptom is a vague timeout.
`createVirtualMic()` and `createSystemTap()` now poll the source list and fail
with `module N loaded but source "x" never appeared`, which points at the real
cause.

**A crash leaves stale plumbing that silently breaks the next share.** If the
null-sink and remap-source survive an ungraceful exit, the old `MygleTV`
source still exists, wins the renderer's device lookup, and the app captures a
dead sink's monitor - **sending silence with no error anywhere**. `cleanupStale()`
sweeps them before every capture, and `listOurModules()` only touches modules
whose arguments name our own sinks, so another application's null-sink is left
alone.

**`pactl --format=json list modules` has no module id.** Its objects carry only
`name`, `argument`, `usage_counter` and `properties`. Unloading "by index" from
that JSON therefore does nothing - and `pactl unload-module <garbage>` can still
exit 0, so the failure is silent. Module indices are read from the tab-separated
text listing instead, and the sweep re-lists afterwards to confirm its work
rather than trusting the exit code.

**An application can own several streams, and that breaks the obvious design.**
Firefox with two tabs playing shows up as two separate sink-inputs. Listing one
row per stream produced a picker with duplicate "Firefox" entries, and — worse —
starting a capture moved only the first one, so the listener received part of
the audio while the sharer still heard the remainder on their speakers. Streams
are now grouped by application for display, and starting a capture moves *every*
stream that application owns.

**Chromium hides monitor sources**, so the remap step is load-bearing rather
than cosmetic.

**Module IDs are large.** PipeWire hands out ids like `536870916`; they are
stored and unloaded as numbers.

**Rollback must cover every failure, not just "app not found".** A test caught
this: an early failure (say the virtual mic could not be created) originally left
modules loaded, meaning the user's audio sat routed to a sink they could not
hear. `session.start()` now restores on any error.

**Restore ordering is load-bearing.** Streams are moved back *before* modules
unload, and modules unload in reverse load order — the loopback and the remap
must go before the sink they depend on. Pinned by tests.

**The spike's ~1.9s recording shortfall is a harness artifact.** The deficit is
*constant* regardless of window length (1.95s at 4s, 1.83s at 9s), which is
buffering lost when a CLI recorder is killed, not audio loss. The real
implementation uses `getUserMedia`, so it does not apply.

## Next steps

1. **Run it on a real desktop** and confirm the shell starts and the picker works.
2. Replace the screen-capture fallback with a real in-app picker.
3. Windows: `loopback-capture` (WASAPI process loopback), needing the
   PCM → AudioWorklet → track plumbing that Linux avoids.
4. Packaging: electron-builder, icons, an update path.
