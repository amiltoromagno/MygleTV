# Screen Room — project handoff

Everything a developer (or an agent) needs to understand this project and build
the Windows client. Written to be read cold, on a machine that has never seen
this code.

**Current state:** Linux desktop client works, verified end to end with two
people. Cloudflare deployment works. The web app works. **Windows does not
work at all** — see [§7](#7-the-windows-port).

---

## 1. What this is

A private screen-sharing app for a handful of people. Open a link, type a name,
share your screen; everyone else sees it in a grid. No accounts, no database.

The reason it exists rather than just using VDO.Ninja: **per-application audio**.
The goal is sharing a game's sound with friends *without* also sending Discord.
No browser can do that, so this ships a desktop client that can.

- **Web app** (`screenroom/`) — the viewer. Works in Firefox. Static files plus
  a small Node signaling server.
- **Desktop client** (`screenroom-desktop/`) — Electron. Adds per-app audio.
- **Cloudflare relay** (`screenroom-cloudflare/`) — the same signaling protocol
  as a Worker + one Durable Object per room, so there is no server to maintain.

---

## 2. Repo layout

```
screenroom/                  the web app and the Node signaling server
  server.js                  static hosting + WebSocket room relay
  public/                    the frontend (shared by every client)
    index.html
    app.js                   UI orchestration: gate, grid, roster, share flow
    peers.js                 WebRTC mesh: one RTCPeerConnection per participant
    signaling.js             WebSocket wrapper with reconnect/backoff
    audio-source.js          native-bridge client (no-op in a plain browser)
    config.js                ICE servers, display constraints, defaults
  test/                      signaling tests + browser end-to-end

screenroom-desktop/          Electron client
  main.js                    composition root
  shell.js                   Electron wiring: IPC, capture handler, lifecycle
  app-server.js              starts the bundled web server for local use
  preload.cjs                contextBridge -> window.screenroomNative
  audio/
    linux.js                 the Linux capture implementation (reference)
    session.js               platform-neutral capture lifecycle
  spike/
    linux-spike.mjs          interactive Linux end-to-end CLI
    windows-spike.mjs        ** run this first on Windows **
  test/                      unit tests + live checks

screenroom-cloudflare/       the relay as a Worker + Durable Object
  src/worker.js              routes /ws, /healthz, else static assets
  src/room.js                the Durable Object
  src/protocol.js            the protocol as pure functions
  wrangler.jsonc             assets directory, DO binding, migration
```

**The frontend is shared, not copied.** `screenroom-cloudflare/wrangler.jsonc`
points its asset directory at `../screenroom/public`, and the desktop client
loads a Screen Room *origin*. One copy of the app; three ways to run it. This is
why the repository should stay together — see §9.

---

## 3. Architecture

```
                  ┌──────────────────────┐
   publisher ────▶│  signaling (WS/HTTP) │◀──── viewer
   (desktop,      │  Node server  or     │      (browser)
    per-app       │  Cloudflare Worker   │
    audio)        └──────────────────────┘
                         │
                         │  SDP + ICE only, a few KB
                         ▼
                  ╔══════════════════════╗
                  ║  WebRTC media, P2P   ║   <- never touches the server
                  ╚══════════════════════╝
```

Signaling is a full mesh: every participant holds one `RTCPeerConnection` per
other participant. Comfortable to about 6–8 people; beyond that the upload cost
(one copy per viewer) needs an SFU.

**The relay never sees audio or video.** It forwards a few kilobytes of text and
goes quiet. That is true of both implementations.

### Why the room is in the WebSocket URL

The client connects to `/ws?room=NAME`. On Cloudflare the Durable Object must be
chosen *before* any message is read, so routing on the first message would be too
late. The Node server ignores the query and reads the room from the join message,
so one client works against both.

---

## 4. How audio capture works on Linux

Read this before designing Windows: it explains *why* the interface looks the way
it does.

**The problem.** A browser's `getDisplayMedia({audio: true})` gives you at best a
tab's audio. There is no web API for "this application's audio".

**The solution.** Route the target application's audio into a private sink, then
capture that sink. PipeWire models each application's stream as its own node, so
this is a *routing* problem, not a capture problem.

1. Create a private null-sink (`module-null-sink`)
2. Add a loopback from its monitor back to the real output — **without this the
   user stops hearing what they are sharing**
3. Wrap the monitor as a normal source (`module-remap-source`)
4. Move **every** stream the chosen application owns onto the private sink
5. The renderer captures the wrapped source with plain `getUserMedia`

Whole-system mode is simpler: wrap the *default* sink's monitor and capture that.
Nothing is moved, so it is non-destructive.

**Two things were only discoverable by testing on a real machine:**

- **Chromium hides `*.monitor` sources from `enumerateDevices()`.** Handing the
  renderer a monitor name is useless. Step 3 is load-bearing, not cosmetic.
- **`device.description` truncates at the first space.** `source_properties` is
  parsed by splitting on whitespace, so `device.description=ScreenRoom System`
  silently became `ScreenRoom`. Device labels must not contain whitespace.
  (Escaping and quoting all fail identically.)

---

## 5. The interface a platform module must satisfy

`audio/session.js` is platform-neutral and drives a *router*. That router is the
only thing a new platform must provide. `audio/linux.js` is the reference
implementation.

### 5.1 Router methods called by `session.js`

| Method | Contract |
| --- | --- |
| `probe()` | Detect the audio backend. Sets `this.environment`. |
| `cleanupStale(names)` | Remove plumbing left by a previous crashed run. |
| `createCaptureSink(name)` | Create the private sink. Returns `{id, name}`. |
| `createVirtualMic(sink, name, label)` | Expose the sink as a capturable source. |
| `addMonitorReturn(sink, targetSink)` | Loop the capture sink back to the speakers. |
| `createSystemTap(name, label)` | Expose the whole output as a source. |
| `routeApp(sinkInputIndex, sinkName)` | Move one application stream. |
| `listApps()` | `[{index, app, pid, sinkIndex, corked, ...}]` |
| `restore()` | Undo everything, in reverse order. |
| `loadedModules` / `movedStreams` | State that `isActive()` and `restore()` rely on. |

Anything not needed on a platform can be a no-op — but `session.js` calls them
unconditionally, so **they must exist**.

### 5.2 What `session.js` provides

```js
createCaptureSession({ router, ... })  ->  {
  get activeApp,            // string | null
  get activeMode,           // "app" | "system" | null
  isActive(),               // true when anything needs undoing
  listApps(),               // raw streams
  listApplications(),       // grouped: [{app, streams}]  <- what the picker shows
  start(target),            // {mode:"app", app} | {mode:"system"} | "AppName"
  stop(),
}
```

`start()` returns `{ mode, app, deviceLabel, streams? }`. `deviceLabel` is what
the renderer then looks for in `navigator.mediaDevices.enumerateDevices()`.

**It restores on any failure.** A half-finished setup would otherwise leave the
user's audio routed somewhere they cannot hear — silent game, no explanation.

### 5.3 The IPC contract

`shell.js` registers exactly five channels. A Windows implementation does not
change any of them:

| Channel | Renderer sends | Main returns |
| --- | --- | --- |
| `audio:list` | — | `{ok, apps:[{app, streams}]}` |
| `audio:probe` | — | `{ok, environment}` |
| `audio:start` | `{mode:"app",app}` or `{mode:"system"}` | `{ok, mode, app, deviceLabel}` |
| `audio:stop` | — | `{ok}` |
| `audio:state` | — | `{activeApp, activeMode}` |

`preload.cjs` exposes them as `window.screenroomNative`:
`platform`, `listApps`, `probe`, `startCapture`, `stopCapture`, `getState`.

`public/audio-source.js` is the renderer's client for that bridge. **In a plain
browser `window.screenroomNative` is absent and every audio feature is a no-op**,
which is how the same frontend serves Firefox viewers.

---

## 6. What the renderer does with the audio

`public/app.js` → `startShare()`:

1. Read the picker (`#audioSource`): `none` | `system` | `app:<id>`
2. If native, call `startNativeCapture(target)` — this **must happen before**
   `getUserMedia`, because the source has to exist before it can be found
3. Find the device by exact label (`findNativeDevice`) and `getUserMedia` it with
   `echoCancellation:false, noiseSuppression:false, autoGainControl:false`
4. `getDisplayMedia` for video only when native audio is in use
5. `peer.setScreen(videoTrack, audioTrack)` on every peer

**Point 5 is why this is tractable.** `peers.js` creates the video and audio
transceivers up front, so swapping audio is a `replaceTrack()` with **no
renegotiation**. Any track works — including a synthesised one, which is exactly
what Windows will produce.

**If audio setup fails the share still proceeds**, silently. Audio must never
cost the user their screen share.

---

## 7. The Windows port

**Nothing in this section has been run.** It is a plan based on reading the
platform's APIs and the shape of the existing code. Treat it as a hypothesis to
verify, not a specification that works.

### 7.1 Run the spike first

```sh
cd screenroom-desktop
npm install loopback-capture
node spike/windows-spike.mjs --list
node spike/windows-spike.mjs --pid <id>      # or --system, or --tone
```

It answers one question: **does WASAPI process loopback deliver that
application's audio on this machine?** Everything else is plumbing on top of that
answer. It writes a WAV and reports peak/RMS so "did we get real audio" is not a
judgement call.

If `npm install` fails, that is already the answer: no prebuilt for this
Node/Electron version, and the module would need building from source.

### 7.2 The two mechanisms

| Mode | Mechanism |
| --- | --- |
| Only \<app\> | `loopback-capture`: `capture.start(pid, true, onChunk)` |
| All system audio | `loopback-capture`: `capture.startSystemAudio(onChunk)` |

Both come from the same MIT-licensed native N-API module, built on
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` — the same Windows API the
official Discord client uses, and the reason an Electron Discord clone
([Legcord #815](https://github.com/Legcord/Legcord/issues/815)) *cannot* do this.

Constraints:

- **Windows 10 build 2004 or newer.** Process loopback does not exist before it.
- **x64.** The module publishes prebuilds for Windows and Linux x64 only.
- **Pass `includeDescendants: true`.** Games routinely spawn child processes that
  hold the audio; capturing only the parent yields silence.

**Windows is easier than Linux in one important way:** process loopback *taps* an
application's audio without moving it. The Linux route has to reroute a stream
and loop it back so the user can still hear it. On Windows they simply keep
hearing the game. No loopback, no restore-order problem, no stale-sink class of
bug. Steps 1–4 of §4 do not exist here.

Output format: **interleaved signed 16-bit little-endian PCM, stereo, 48 kHz.**

### 7.3 The PCM → track pipeline

This is the novel work. On Linux the capture source is a real device that
`getUserMedia` can open; WASAPI hands you raw bytes, so the renderer must
synthesise a `MediaStreamTrack`.

**Main process** — forward chunks to the renderer:

```js
const capture = new loopback.LoopbackCapture();
capture.start(pid, true, (chunk) => {
  mainWindow.webContents.send("audio:pcm", chunk);
});
```

**Renderer** — a `MediaStreamAudioDestinationNode` fed by an `AudioWorklet`:

```js
const ctx = new AudioContext({ sampleRate: 48000 });   // must match, or resample
await ctx.audioWorklet.addModule("./pcm-worklet.js");
const node = new AudioWorkletNode(ctx, "pcm-source");
const dest = ctx.createMediaStreamDestination();
node.connect(dest);

// on each IPC chunk: convert s16 -> Float32 [-1,1] and hand it over
bridge.onPcm((interleavedS16) => node.port.postMessage({ pcm: toFloat32(interleavedS16) }));

const track = dest.stream.getAudioTracks()[0];   // <- goes to replaceTrack
```

**`pcm-worklet.js`** — a FIFO that emits silence on underrun. Sketch:

```js
class PcmSource extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];      // Float32Array frames, de-interleaved or interleaved
    this.offset = 0;
    this.port.onmessage = (event) => this.queue.push(event.data.pcm);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    for (const channel of out) channel.fill(0);   // silence unless filled

    let written = 0;
    const needed = out[0].length;                 // usually 128
    while (written < needed && this.queue.length > 0) {
      const frame = this.queue[0];
      const take = Math.min(needed - written, frame.length - this.offset);
      for (let ch = 0; ch < out.length; ch++) {
        out[ch].set(frame.subarray(this.offset, this.offset + take), written);
      }
      written += take;
      this.offset += take;
      if (this.offset >= frame.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;   // must stay true or the processor is torn down
  }
}
registerProcessor("pcm-source", PcmSource);
```

**Three details that will bite if missed:**

1. **AudioContext must be 48000 Hz.** WASAPI gives 48 kHz; a different context
   rate resamples and can drift.
2. **You need a jitter buffer.** IPC delivery is bursty and the audio thread is
   real-time. Without a small target buffer (~40–100 ms) the queue empties
   constantly and you get clicks. Fill to the target before starting playback,
   and emit silence on underrun rather than stalling.
3. **Interleaving.** The chunk is `L,R,L,R…`. De-interleave before pushing to the
   worklet, or index carefully.

**No audio processing is applied** to a synthesised track, which is what we want —
echo cancellation and noise suppression are tuned for speech and would mangle
game audio.

**Audio/video sync is unverified.** Video comes from `desktopCapturer`, audio
from WASAPI; both ride the same `RTCPeerConnection`, so WebRTC's sender reports
*should* align them. Movie night is where a 100 ms lip-sync error is unbearable,
so measure it rather than assuming.

### 7.4 The process picker

`spike/windows-spike.mjs` lists processes with a window title via PowerShell:

```powershell
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
  Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress
```

**This is crude and the gap should be stated plainly:** it lists apps with a
*window*, not apps *playing audio*. The proper API is `IAudioSessionManager2` —
what the Windows volume mixer uses — and it needs native code of its own.

For a first version, listing windows is workable: the wrong choice gives silence
immediately rather than a mystery. But a game with no window title will not
appear, and a browser with many tabs will.

### 7.5 One interface change needed

The picker currently identifies an application **by name**, which works on Linux
(`app: "Firefox"`). On Windows the natural identity is a **PID**.

Recommended change, in `listApplications()` and the frontend:

```js
// listApplications() returns:
{ id: "Firefox", app: "Firefox", streams: 2 }     // Linux: id === name
{ id: "12345",   app: "MyGame", detail: "My Game — window title" }  // Windows: id === pid

// the renderer sends:
{ mode: "app", app: entry.id }
```

This is backwards compatible: on Linux `id` equals the name, so nothing changes.
It has not been done yet — do it as the first step of the Windows work, and keep
the Linux tests green.

---

## 8. Pitfalls, and the lessons behind them

Every item here cost real debugging time. They are the most valuable part of this
document.

**Verify, do not trust exit codes.** `pactl unload-module <garbage>` exits 0
without doing anything. `pactl --format=json list modules` returns objects with
**no id field at all** — so "unload by index" from that JSON silently does
nothing. The Linux sweep now re-lists afterwards to confirm its work. Assume the
same about any Windows API that returns success: confirm the effect.

**A failure must not take out something unrelated.** Audio setup runs first, so
an audio error originally aborted the whole share and presented as "the screen
picker never opened". Two completely different subsystems, one misleading
symptom. Keep failures local to the feature that failed.

**Never silently pick a default for the user.** A capture handler that grabs the
first screen without asking will share the wrong thing, and nothing says so.
Guessing is acceptable only when logged, and only when there is exactly one
option.

**Identical names on different systems are indistinguishable.** Two Screen Room
servers — one local, one remote — can both hold a room called `main`. Each user
sees only themselves, which looks exactly like a broken app. The desktop window
title now names the relay for this reason.

**An application owns several streams.** Firefox with two tabs playing is two
sink-inputs. One row per stream produced duplicate picker entries *and* moved
only the first stream, so the listener got part of the audio while the sharer
still heard the rest. Group by application for display; act on all of them.

**A crash leaves state that shadows the next run.** Leftover capture plumbing
meant the stale source won the device lookup, so the app captured a dead sink and
sent **silence with no error**. Linux sweeps before every capture; Windows should
assume any native resource can leak on an ungraceful exit.

**Test the seams, not the layers.** Every bug that reached a user was at a
boundary: audio-vs-video startup order, Linux-vs-Windows labels, local-vs-remote
relays, picker-vs-capture. Unit tests of each layer all passed.

**Beware instrumentation that changes the thing measured.** A test that wrapped
`window.WebSocket` without copying its static constants made `WebSocket.OPEN`
undefined, so the app under test silently never sent anything — and the test
"found" a bug that did not exist.

---

## 9. Repository layout

**Recommendation: one repository.** The projects are coupled in ways that make
splitting actively harmful:

- `screenroom-cloudflare/wrangler.jsonc` sets `assets.directory` to
  `../screenroom/public` — a cross-directory path that breaks if the web app
  moves to its own repo.
- The desktop client and the browser client share a frontend *contract*
  (`window.screenroomNative`, the five IPC channels). Changing one without the
  other silently breaks native audio.
- A Windows contributor needs the whole picture to work on one piece.

```
stream-app/                  (one repo)
  README.md                  overview and quick start
  HANDOFF.md                 this document
  screenroom/                web app + Node server
  screenroom-desktop/        Electron client
  screenroom-cloudflare/     Worker + Durable Object
```

Things worth adding:

- **`LICENSE`** — the code here is original (not VDO.Ninja's), so pick freely.
  MIT is consistent with the one dependency that matters, `loopback-capture`.
- **Root `.gitignore`** — at minimum `node_modules/`, `.wrangler/`, `dist/`.
  There is already one inside `screenroom-cloudflare/`.
- **A root `README.md`** pointing at each subproject.

**No secrets are committed.** `node_modules/` and `.wrangler/` are ignored; the
Cloudflare account is reached via `wrangler login` or a `CLOUDFLARE_API_TOKEN`
environment variable, never a file in the tree.

**Do not add npm workspaces.** The three targets are genuinely different
(browser+Node, Electron, Workers). Hoisting would make a Windows contributor
install Electron and a Linux contributor install wrangler for no benefit. Keep
separate `package.json` files.

---

## 10. Tests that exist

Run these before and after any change.

```sh
cd screenroom           && npm run test:all     # signaling, WebRTC, 2-browser e2e
cd screenroom-desktop   && npm test             # 84 unit tests
cd screenroom-desktop   && npm run check:shell  # frontend <-> bridge, real Chrome
cd screenroom-cloudflare&& npm test             # 22 protocol tests
```

Live checks (need a real sound server and Chrome):

```sh
cd screenroom-desktop
npm run check:monitor    # does Chromium capture the remapped source?
npm run check:taploop    # does the system tap survive create/destroy cycles?
npm run check:proxy      # does it work behind a TLS proxy?
npm run spike:windows    # Windows only
```

Two conventions worth keeping:

- **Checks that need hardware are separate from `npm test`**, so unit tests run
  anywhere.
- **Protocol conformance runs against both relays**
  (`screenroom-cloudflare/test/relay-conformance.mjs`), which is what proves the
  Node server and the Worker are interchangeable.

---

## 11. First steps on Windows

1. **Clone, then run the spike.** `npm install loopback-capture` in
   `screenroom-desktop`, then `node spike/windows-spike.mjs --system` and
   `--pid <a game>`. Confirm real audio in the WAV. **Stop here and report if it
   fails** — the rest of the plan changes.
2. **Generalise the picker identity** to `id` (§7.5). Keep the Linux tests green.
3. **Write `audio/windows.js`** implementing the router interface (§5.1),
   returning `{id, app, detail}` from `listApps()`. Nothing else in `shell.js`,
   `preload.cjs` or the frontend should need to change.
4. **Add the PCM pipeline** (§7.3) and the `audio:pcm` IPC channel.
5. **Wire the platform switch** in `main.js` (`process.platform === "win32"`).
6. **Verify with a real listener**, not just locally — the whole point is that a
   friend hears the game and not Discord.

### Open questions to answer on Windows

- Does `loopback-capture` install and capture on the target machine at all?
- Does the label semantics still apply? There is no `device.description` here, so
  the space-truncation bug should not exist — but the picker identity still needs
  to round-trip.
- What is the end-to-end latency, and does audio/video stay in sync?
- Does packaging work? A native module needs to be unpacked from the ASAR
  archive (`asarUnpack`) or it will not load in a built app.
- macOS is explicitly out of scope. No browser can capture per-app audio there,
  and Electron's options are worse than Windows'.

---

## 12. The one thing that matters

The feature this project exists for is **a friend hearing your game and not your
Discord**. That was confirmed working on Linux with a real second person. Every
other test in this repository is a proxy for it, and the bugs that got through
were all in places no proxy covered.
