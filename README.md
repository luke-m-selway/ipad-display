# iPad Display

iPad Display turns one supported iPad into a low-latency secondary display for a
supported Intel Mac running macOS Ventura. It uses a fixed USB/private-network
link and a dedicated virtual display; it is not a general-purpose remote-desktop
or cross-platform screen-sharing product.

## Quick start

Clone the repository on the Mac, then run:

```bash
./scripts/install
ipad doctor
```

The installer provisions the validated Intel Node runtime locally, installs npm
dependencies, builds the host/viewer, prebuilds the touch helper, and installs a
global `ipad` wrapper where possible. It does not grant macOS privacy
permissions automatically.

Connect and trust the iPad over USB. In **System Settings → General → Sharing →
Internet Sharing**, share the Mac's **Wi-Fi** connection to **iPad USB** and turn
Internet Sharing on. The Mac side must expose `192.168.2.1`.

Start either mode:

```bash
ipad
# or
ipad touch
```

Open `http://192.168.2.1:3131/` on the iPad. For the most direct experience,
save that page to the iPad Home Screen and launch it as a standalone web app.
macOS will require **Screen Recording** for display capture and **Accessibility**
for touch mode; approve those prompts in System Settings when requested.

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
