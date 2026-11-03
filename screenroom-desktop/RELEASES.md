Desktop downloads for Windows and Linux (x64).

## What's new in 0.1.4

Windows now follows the Linux and web sharing flow: choose a screen or window,
then review its live preview and select resolution, FPS, bitrate and audio in
**Ready to share**. Only **Share** starts transmission and native audio capture;
**Cancel** or **Esc** releases the preview. The separate toolbar **Quality**
button is removed. Quality preferences survive restarts, while every Windows
share requires an explicit audio choice. Window audio, other applications,
system audio and audio inputs remain available.

The Windows installer is `MygleTV-Setup-0.1.4-x64.exe`. The Linux packages below
refer to the previous 0.1.3 release.

## What's new in 0.1.3

Windows Picture-in-Picture now supports multiple streams simultaneously, each in its own movable, resizable, always-on-top window. The native browser timeline and address bar are replaced with MygleTV controls that appear on hover or keyboard focus: mute, volume up to 300%, and close. Volume stays synchronized with the stream's controls in the room, and audio is played only once.

This release also includes clearer audio-picker feedback and direct audio-input selection.

## Windows

Download `MygleTV-Setup-0.1.3-x64.exe` and run the installer. The installer is unsigned. Version 0.1.2 has single-window native PiP; install this version for multiple PiP windows and volume controls.

## Linux

For Ubuntu, Debian and compatible distributions, download `MygleTV-0.1.3-amd64.deb` and install it:

```sh
sudo apt install ./MygleTV-0.1.3-amd64.deb
```

MygleTV then appears in the application menu. Audio capture requires a running PulseAudio server or PipeWire with PulseAudio compatibility.

For other distributions, download `MygleTV-0.1.3-x86_64.AppImage`:

```sh
chmod +x MygleTV-0.1.3-x86_64.AppImage
./MygleTV-0.1.3-x86_64.AppImage
```

AppImage requires FUSE support and `pactl` (usually provided by `pulseaudio-utils`). If FUSE is unavailable, use `./MygleTV-0.1.3-x86_64.AppImage --appimage-extract-and-run`.

Both apps connect to the project's Cloudflare room service by default. No separate Node.js installation or repository checkout is needed.

## Arch Linux and compatible distributions

The separately tested Arch package remains available in the previous v0.1.1 release:

```sh
sudo pacman -U https://github.com/amiltoromagno/MygleTV/releases/download/v0.1.1/mygletv-0.1.1-1-x86_64.pkg.tar.zst
```

Run `mygletv` or select it in the application menu. This package uses the distribution's `electron44` runtime and `libpulse`. Audio capture needs an existing PulseAudio server or PipeWire with `pipewire-pulse`; Wayland screen capture needs the portal backend appropriate to your desktop.

The AUR recipe is prepared under the name `mygletv`, but AUR publication is pending account availability. The download above works independently of the AUR.

`SHA256SUMS.txt` contains the checksums of this release's Windows installer, Debian package and AppImage. Linux packages are checked for startup in CI; real screen and audio capture still depend on the desktop environment and its permissions.
