# iPad Display

iPad Display turns one supported iPad into a low-latency secondary display for a
supported Intel Mac running macOS Ventura. It uses a fixed USB/private-network
link and a dedicated virtual display; it is not a general-purpose remote-desktop
or cross-platform screen-sharing product.

## Quick start

A fresh supported Mac does **not** need Homebrew, Node, npm, or Git preinstalled.
Open Terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/luke-m-selway/ipad-display/main/scripts/bootstrap -o /tmp/ipad-display-bootstrap
bash /tmp/ipad-display-bootstrap --open-settings
```

If Xcode Command Line Tools are missing, Apple's installer opens and the bootstrap
stops before cloning anything. Finish that installation, then rerun the same two
commands. The bootstrap validates Intel/x86_64 + macOS Ventura, creates a normal
Git checkout at `~/ipad-display`, and hands off to the project installer. On a
later rerun it will update that checkout only when it is clean and still points
to this repository; it will not overwrite local changes or another directory.

The installer provisions the validated Intel Node runtime locally, installs npm
dependencies using an installer-owned npm cache, builds the host/viewer,
prebuilds the touch helper, and installs a global `ipad` wrapper where possible.
It does not depend on Homebrew or the state/ownership of `~/.npm`, and it does not
grant macOS privacy permissions automatically. If the wrapper directory is not
already on `PATH`, the installer prints the one-line `~/.zprofile` change needed
to add it.

After installation, run the repository-local doctor so the first check does not
depend on shell `PATH` setup:

```bash
~/ipad-display/scripts/ipad doctor
```

Complete the one-time USB/network/privacy setup using the
[visual setup walkthrough](docs/setup.md). It includes the Internet Sharing,
Screen Recording, Accessibility, and iPad Home Screen steps with screenshots.

Then start either mode:

```bash
ipad
# or
ipad touch
```

| Command | Result |
| --- | --- |
| `ipad` | Start the display-only stack. |
| `ipad stop` | Stop a display-only stack. |
| `ipad touch` | Start display plus opt-in touch control. |
| `ipad touch stop` | Stop a touch stack. |
| `ipad status` | Report `stopped`, `display-only`, or `touch`. |
| `ipad doctor` | Run read-only deployment/runtime checks. |

Stop the active mode before starting the other one; the script never changes a
running stack's mode implicitly. Plain `ipad` remains the lowest-complexity
fallback and never starts the native input helper.

## Touch mode

`ipad touch` asks macOS for Accessibility permission when needed. Touch is
available only from the current streaming viewer and only while it has Mac
control. The Mac keyboard remains the typing device.

| iPad gesture | Mac result |
| --- | --- |
| Tap | Move the cursor and click. |
| One-finger drag | Native macOS drag. |
| Two-finger drag | Scroll. |
| Three fingers up | Mission Control. |
| Three fingers left / right | Next / previous Space, matching natural swipe direction. |
| `iPad` / `Mac` button | Yield touch ownership to iPadOS / resume Mac control. |

The saved Home Screen viewer is already immersive, so it does not show the
fullscreen-entry hint or request browser fullscreen before enabling touch.
In an ordinary Safari tab, tap once to enter element fullscreen first. The
`iPad` setting yields the interaction surface to Safari and iPadOS; it does not
turn the video into a media-control surface.

## Supported setup and boundary

- Intel macOS Ventura Mac with Screen Recording permission.
- iPad on the dedicated USB/private network exposing `192.168.2.1` on the Mac.
- iPad Safari or a Home Screen standalone viewer.
- Touch mode additionally requires Accessibility permission for the local input
  helper.

The virtual display and Electron host own the lifecycle. The host captures that
display, serves the viewer only on `192.168.2.1:3131`, and keeps viewer authority
and input injection generation-bound. The validated checkpoint is a
1600×1200 logical virtual display with a 3200×2400 HiDPI backing surface and a
2304×1728 iPad media path.

There is no keyboard forwarding, Pencil support, right click, pinch/zoom,
momentum, or generic remote-desktop feature set.

## Upstream and license

This is a modified derivative of
[Deskreen CE](https://github.com/pavlobu/deskreen), based on Deskreen CE v3.2.16
and substantially modified for this fixed Intel Ventura/iPad workflow in 2026.
It remains licensed under the [AGPL-3.0](LICENSE); upstream copyright and
applicable third-party notices are preserved.

The touch-control design was informed by
[MacPilot](https://github.com/joonlab/MacPilot) (MIT) and
[Weylus](https://github.com/H-M-H/Weylus) (AGPL-3.0-or-later, with BSD-3-Clause
contributions) as implementation references. No source from either project is
vendored or copied into this repository.
