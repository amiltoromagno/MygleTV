# MygleTV for Windows

The Windows desktop client captures screen video and either one application's
audio, all system audio, or no audio. Application capture uses WASAPI process
loopback with descendant processes included. It does not reroute playback or
require a virtual audio cable. The Linux implementation is unchanged.

## Requirements

- Windows x64, build 20348 or newer (Windows 11 is the recommended desktop target).
- For development, Node 22.12+ is required by the pinned Electron release.
- Installed users need neither Node nor development tools.
- Friends only need a browser and access to the same relay.

## Run in development

Install each target's dependencies independently:

```powershell
npm --prefix screenroom ci
npm --prefix screenroom-desktop ci
npm run start:desktop
```

The Windows app connects automatically to our existing Cloudflare application:

**https://screenroom.amiltoromagno.workers.dev/**

Enter your name, choose audio, and share. There is no relay setup screen or
saved server configuration. Friends open the same address in a browser.
Explicit URL overrides remain available for development:

```powershell
$env:SCREENROOM_URL = 'http://127.0.0.1:8080/?room=development'
npm run start:desktop
```

The `--url=` command-line option takes precedence over the environment variable,
which takes precedence over the fixed Cloudflare address. An explicit empty
`--url=` starts local mode for testing. In local mode the bundled Node
signaling server listens on loopback port 8080; `SCREENROOM_PORT` overrides it.
Local mode is for local checks, not inviting friends on other machines.

On Windows, remote mode serves the current shared frontend from the app's bundled
files on an ephemeral loopback port, and proxies only `/ws` to the chosen relay.
This does not require changing the deployed frontend. Browser viewers continue
using the public relay URL. **Copy invite link** copies that public URL, and the
window title identifies the actual relay. Remote URLs must be HTTPS (HTTP is
allowed for localhost tests).

Click **Share screen**, then select a screen or window thumbnail. When a window
can be associated with its owning process, **Share audio from [window]** appears
as an unchecked checkbox. The user chooses whether to enable it. **Other audio
to share**, below the thumbnails, selects another application or all system audio
instead. Names have no “Only” prefix. Click **Share** to start; selecting a
thumbnail alone starts no capture. Leaving both audio choices off shares silently.
The audio list refreshes when the picker opens. Cancelling starts no capture.

Window audio uses the exact native window handle to identify its process rather
than matching titles. Capture includes that process's descendants and may include
other windows of the same application. Screens have no owning application;
unavailable window associations leave the checkbox disabled while other audio
choices remain usable.

## Stream quality

The Windows **Quality** button beside **Copy invite link** sets the video bitrate ceiling (0.5–100 Mbps per
viewer), FPS (30, 60 or 120), and resolution (original, 720p, 1080p, 1440p or 4K).
Defaults remain 4 Mbps, 30 FPS and original resolution. Changes apply to an active
capture and its current senders; late arrivals and reconnections use the same
profile. Audio is kept running. Preferences are saved in the Windows user data
directory as `stream-quality.json`, independently of the local frontend port.

Resolution limits preserve the source aspect ratio. The dialog reports current
capture dimensions and frame rate from the track's settings, which is distinct
from actual encoded FPS. The monitor, capture source, CPU/GPU and network can
produce lower rates. A bitrate ceiling is not a constant bitrate, and audio plus
network overhead are additional. Each viewer receives a separate stream.
At 30 FPS the encoder favors resolution; higher FPS uses motion content hints
and balanced degradation. Linux and standalone browser settings are unchanged.

## Watching streams

Windows and browser viewers keep the other streams as smaller tiles below a
focused stream. Each received stream has an independent 0–100% volume slider
and mute button; unmuting restores the previous volume. The local preview stays
muted to avoid feedback. The full-screen button opens an individual stream;
the **×** at the top right or **Esc** exits. Volume controls remain available
in full screen. These playback controls do not change the shared audio track.

Windows also has **Full screen in app** on each stream. It fills the existing
window without resizing it and hides the application UI, caption buttons and
tile borders. **×** or **Esc** restores the room. If the stream ends, the room
returns automatically. The video keeps its aspect ratio, so different source
and window proportions can leave black space. The regular full-screen button
still fills the monitor. A custom Windows caption provides minimize, maximize /
restore and close in the normal view.

In Windows and browser clients, click another participant under **In this room**
to open their actions menu, choose **Kick from session**, then confirm to remove
their current connection. Clicking a name does not immediately open the kick
confirmation. Escape, clicking outside, or clicking the name again dismisses
the menu. Any joined
participant can do this; there are no administrator roles. The relay removes the
member and stream for everyone, stops capture, and returns the removed client
to **Join room** with the name cleared. They must enter a name and explicitly
join before sharing again; reloading is unnecessary. Controls initialize once,
so rejoining does not duplicate listeners or quality controls. The server rejects
reconnections with the removed login token for 24 hours; an explicit join creates
a fresh token. Removal targets a session ID, so duplicate display names are safe.
This is not a permanent ban. The relay also confirms the kick and sends the
remaining participants the authoritative member list.
The Cloudflare Worker and clients must both be updated for this feature.

## Build

```powershell
cd screenroom-desktop
npm run pack:windows            # executable directory
npm run check:windows-package   # verify the built executable
npm run dist:windows            # installer
```

Outputs:

- `dist/windows/win-unpacked/MygleTV.exe` — keep the entire directory together.
- `dist/windows/MygleTV-Setup-0.1.0-x64.exe` — installer for sharing.

The frontend, bundled Node server, WebSocket dependency and Windows native addon
are included. Native `.node` files are unpacked from ASAR. The installer is
unsigned unless a signing certificate is supplied to electron-builder. No
automatic updater is configured.

## Verification

```powershell
npm test                      # platform-independent unit and I/O tests
npm run spike:windows -- --tone --seconds 4
npm run check:windows          # real Electron, sound device and WebRTC
```

`check:windows` plays 440 Hz and 880 Hz tones in separate hidden PowerShell
processes. It exercises the real Windows native addon, isolated preload, IPC,
stereo AudioWorklet, explicit screen picker, proxy and a late-joining browser.
It measures the received signal to confirm that the selected process's tone
arrives while the other process's tone is excluded. It also checks cancellation,
stop, invalid selection, signaling reconnection, both tones in the system mix,
video continuing after an injected audio failure, and cleanup on renderer reload.
Quality checks cover saved preferences, resolution bounds for a late viewer,
and live 120 FPS / bitrate parameter updates with audio still arriving.
The hidden tone processes are supplied as test picker entries because they do
not have application windows; real process discovery is checked separately.

## Current limits

- The application picker lists processes with a window, not Windows audio
  sessions. Background applications may be absent and a listed app may be silent.
  It identifies processes by PID and displays the window title to distinguish
  processes with the same name.
- A selected application exiting produces silence. Select its new process after
  relaunching it; automatic reattachment is not implemented.
- The PCM FIFO targets 60 ms and caps queued audio at 200 ms. Silent native gaps
  become silence. IPC deliveries are bounded and old capture generations ignored.
  End-to-end latency and audio/video sync with a real game and remote friend
  still need measurement.
- TURN remains unconfigured, so some networks cannot establish a direct media
  connection. The relay carries signaling only; it never carries media.
- Linux routing, capture session, shell and preload files were not modified.
