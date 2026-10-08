# MygleTV on the AUR

`mygletv-bin` repackages the released Linux application with Arch's `electron44`
runtime. It installs `mygletv` in the terminal and adds an application-menu entry.
The application code is taken directly from the release, without changes.

## Install after AUR publication

```sh
yay -S mygletv-bin
# or
paru -S mygletv-bin
```

Without an AUR helper:

```sh
sudo pacman -S --needed base-devel git
git clone https://aur.archlinux.org/mygletv-bin.git
cd mygletv-bin
makepkg -si
```

These AUR commands require the package to have been published first. Before
publication, the recipe can be installed directly from this repository:

```sh
sudo pacman -S --needed base-devel git
git clone https://github.com/amiltoromagno/MygleTV.git
cd MygleTV/packaging/aur/mygletv-bin
makepkg -si
```

Run `mygletv` or use the application menu. Audio capture needs an existing
PulseAudio server or PipeWire with `pipewire-pulse`. Wayland screen sharing also
needs the desktop's portal backend (such as `xdg-desktop-portal-kde`,
`xdg-desktop-portal-gnome`, or the one appropriate to your compositor).

## Publish

Create an account at https://aur.archlinux.org/register and add a public SSH key
to the account settings. The private key stays on the publisher's computer.

Clone the package repository over SSH, copy only `PKGBUILD`, `.SRCINFO`,
`mygletv` and `mygletv.desktop` from `mygletv-bin/`, then commit and push:

```sh
git -c init.defaultBranch=master clone ssh://aur@aur.archlinux.org/mygletv-bin.git
cd mygletv-bin
# Copy the four recipe files here.
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO mygletv mygletv.desktop
git commit -m 'Publish MygleTV 0.1.1'
git push origin master
```

## Update

After publishing a new Linux release, update `pkgver`, reset `pkgrel` to `1`,
and replace the download checksum in `PKGBUILD`. Regenerate `.SRCINFO` with
`makepkg --printsrcinfo`, run the AUR package check workflow, and push the four
recipe files to the AUR repository. GitHub releases alone do not update the AUR.

The upstream application does not currently declare a license, so the recipe
records `unknown` rather than assigning one. The AUR check workflow builds and
installs the package in Arch Linux, validates `.SRCINFO` and the desktop entry,
and checks startup using the system Electron runtime.
