Desktop downloads for Windows and Linux (x64).

## What's new in 0.1.2

Windows streams now have a translucent Picture-in-Picture button when hovered or focused. Open a stream in a floating window, keep watching while MygleTV is minimized, and close it using the same button or the floating window's controls. The stream keeps its existing volume and amplification settings.

This release also includes clearer audio-picker feedback and direct audio-input selection.

## Windows

Download `MygleTV-Setup-0.1.2-x64.exe` and run the installer. The installer is unsigned. Previous installers do not include Picture-in-Picture; install this version to get it.

## Linux

For Ubuntu, Debian and compatible distributions, download `MygleTV-0.1.2-amd64.deb` and install it:

```sh
sudo apt install ./MygleTV-0.1.2-amd64.deb
```

MygleTV then appears in the application menu. Audio capture requires a running PulseAudio server or PipeWire with PulseAudio compatibility.

For other distributions, download `MygleTV-0.1.2-x86_64.AppImage`:

```sh
chmod +x MygleTV-0.1.2-x86_64.AppImage
./MygleTV-0.1.2-x86_64.AppImage
```

AppImage requires FUSE support and `pactl` (usually provided by `pulseaudio-utils`). If FUSE is unavailable, use `./MygleTV-0.1.2-x86_64.AppImage --appimage-extract-and-run`.

Both apps connect to the project's Cloudflare room service by default. No separate Node.js installation or repository checkout is needed.

## Arch Linux and compatible distributions

The separately tested Arch package remains available in the previous v0.1.1 release:

```sh
sudo pacman -U https://github.com/amiltoromagno/MygleTV/releases/download/v0.1.1/mygletv-0.1.1-1-x86_64.pkg.tar.zst
```

Run `mygletv` or select it in the application menu. This package uses the distribution's `electron44` runtime and `libpulse`. Audio capture needs an existing PulseAudio server or PipeWire with `pipewire-pulse`; Wayland screen capture needs the portal backend appropriate to your desktop.

The AUR recipe is prepared under the name `mygletv`, but AUR publication is pending account availability. The download above works independently of the AUR.

`SHA256SUMS.txt` contains the checksums of this release's Windows installer, Debian package and AppImage. Linux packages are checked for startup in CI; real screen and audio capture still depend on the desktop environment and its permissions.
