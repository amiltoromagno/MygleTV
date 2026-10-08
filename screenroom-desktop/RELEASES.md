Desktop downloads for Windows and Linux (x64).

## Windows

Download `MygleTV-Setup-0.1.1-x64.exe` and run the installer. The installer is unsigned.

## Linux

For Ubuntu, Debian and compatible distributions, download `MygleTV-0.1.1-amd64.deb` and install it:

```sh
sudo apt install ./MygleTV-0.1.1-amd64.deb
```

MygleTV then appears in the application menu. Audio capture requires a running PulseAudio server or PipeWire with PulseAudio compatibility.

For other distributions, download `MygleTV-0.1.1-x86_64.AppImage`:

```sh
chmod +x MygleTV-0.1.1-x86_64.AppImage
./MygleTV-0.1.1-x86_64.AppImage
```

AppImage requires FUSE support and `pactl` (usually provided by `pulseaudio-utils`). If FUSE is unavailable, use `./MygleTV-0.1.1-x86_64.AppImage --appimage-extract-and-run`.

Both apps connect to the project's Cloudflare room service by default. No separate Node.js installation or repository checkout is needed.

## Arch Linux and compatible distributions

Install the Arch package directly from this release:

```sh
sudo pacman -U https://github.com/amiltoromagno/MygleTV/releases/download/v0.1.1/mygletv-0.1.1-1-x86_64.pkg.tar.zst
```

Run `mygletv` or select it in the application menu. This package uses the distribution's `electron44` runtime and `libpulse`. Audio capture needs an existing PulseAudio server or PipeWire with `pipewire-pulse`; Wayland screen capture needs the portal backend appropriate to your desktop.

The AUR recipe is prepared under the name `mygletv`, but AUR publication is pending account availability. The download above works independently of the AUR.

`SHA256SUMS.txt` contains the checksums of all four downloads. Linux packages are checked for startup in CI; real screen and audio capture still depend on the desktop environment and its permissions.
