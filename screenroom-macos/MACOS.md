# MygleTV for macOS

The macOS desktop client (`screenroom-macos/`) captures screen video and either
one application's audio, all system audio, an audio input device, or no audio.
Application and system audio capture use Apple's `ScreenCaptureKit` (`SCStream`)
with descendant processes included. It does not reroute playback or require a
virtual audio driver (such as BlackHole or Soundflower). Existing Linux, Windows
and web files remain completely untouched.

## Requirements

- macOS 13.0 (Ventura) or newer on Apple Silicon (`arm64`) or Intel (`x64`).
- Xcode Command Line Tools (`swiftc`) for building the native `ScreenCaptureKit`
  audio helper during development.
- Node 22.12+ for development.
- Screen & System Audio Recording permission in **System Settings → Privacy &
  Security → Screen & System Audio Recording** when sharing a screen or
  capturing application audio.

## Run in development

Install dependencies and launch the macOS app:

```sh
npm --prefix screenroom ci
npm --prefix screenroom-macos ci
npm --prefix screenroom-macos start
```

The macOS app connects automatically to the deployed Cloudflare relay:

**https://screenroom.amiltoromagno.workers.dev/**

Explicit URL overrides remain available for development:

```sh
SCREENROOM_URL="http://127.0.0.1:8080/?room=development" npm --prefix screenroom-macos start
```

Or pass `--url=` to start the bundled local Node signaling server on port 8080:

```sh
npm --prefix screenroom-macos start -- --url=
```

## How audio capture works on macOS

1. **Native Swift helper (`native/macos-audio-helper.swift` → `bin/macos-audio-helper`):**
   - `--probe`: Reports `ScreenCaptureKit` backend, macOS version, architecture,
     and PCM format (`48000 Hz`, 2 channels, 16-bit signed little-endian).
   - `--list-apps`: Enumerates running GUI applications (`NSWorkspace` +
     `CGWindowListCopyWindowInfo`, enriched with `SCShareableContent` window
     titles when permission is already granted).
   - `--resolve-windows`: Maps `CGWindowID` handles from Electron's
     `window:<id>:0` sources to their owning process PID (`kCGWindowOwnerPID`)
     so **Window audio — [window]** in the **Ready to share** dialog targets the
     exact process that owns the chosen window.
   - `--capture-pid <pid>` / `--capture-system`: Starts an `SCStream` with
     `capturesAudio = true`, `sampleRate = 48000`, `channelCount = 2`,
     `excludesCurrentProcessAudio = true`, walking the process tree via
     `sysctl(KERN_PROC_ALL)` so child helper processes spawned by games or
     browsers are included automatically. Converts `CMSampleBuffer` audio
     buffers to interleaved 16-bit little-endian stereo PCM (`s16le`) on
     `stdout`.
2. **Renderer PCM → WebRTC track pipeline:**
   - Reuses the untouched shared frontend in `../screenroom/public`
     (`windows-audio.js` + `pcm-worklet.js` + `pcm-buffer.js` +
     `windows-screen-picker.js` + `share-setup.js`).

## Build `.app` and `.dmg`

```sh
cd screenroom-macos
npm run pack:macos            # unpacked MygleTV.app bundle in dist/macos/
npm run check:macos-package   # smoke-check the built MygleTV.app
npm run dist:macos            # .dmg and .zip archives in dist/macos/
```

## Verification

```sh
cd screenroom-macos
npm test                                    # unit and proxy tests
npm run spike:macos -- --list               # list candidate applications
npm run spike:macos -- --tone --seconds 4   # self-test with generated 440 Hz tone
npm run check:macos                         # real Electron + ScreenCaptureKit IPC check
```

