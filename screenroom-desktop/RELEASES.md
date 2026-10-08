Desktop downloads for Windows and Linux (x64).

## Windows

Download `MygleTV-Setup-0.1.0-x64.exe` and run the installer. The installer is unsigned.

## Linux

For Ubuntu, Debian and compatible distributions, download `MygleTV-0.1.0-x64.deb` and install it:

```sh
sudo apt install ./MygleTV-0.1.0-x64.deb
```

MygleTV then appears in the application menu. Audio capture requires a running PulseAudio server or PipeWire with PulseAudio compatibility.

For other distributions, download `MygleTV-0.1.0-x64.AppImage`:

```sh
chmod +x MygleTV-0.1.0-x64.AppImage
./MygleTV-0.1.0-x64.AppImage
```

AppImage requires FUSE support and `pactl` (usually provided by `pulseaudio-utils`). If FUSE is unavailable, use `./MygleTV-0.1.0-x64.AppImage --appimage-extract-and-run`.

Both apps connect to the project's Cloudflare room service by default. No separate Node.js installation or repository checkout is needed.

`SHA256SUMS.txt` contains the checksums of all three downloads. Linux packages are checked for startup in CI; real screen and audio capture still depend on the desktop environment and its permissions.
