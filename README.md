# iPad Display

A lightweight macOS-to-iPad secondary-display setup derived from Deskreen's Chromium desktop-capture → WebRTC path.

This repository is intentionally narrow: it targets the validated Intel macOS Ventura setup in this project, using a USB/private-LAN connection to an iPad rather than a general-purpose cross-platform screen-sharing app.

## Usage

```bash
ipad
ipad status
ipad stop
```

`ipad` owns the virtual-display and streaming-host lifecycle. The viewer is served at the fixed private USB address:

```text
http://192.168.2.1:3131/
```

The runtime fails rather than silently falling back to another network interface if the expected private link is unavailable.

## Current validated checkpoint

- logical desktop: `1600x1200`
- HiDPI backing surface: `3200x2400` (`@2x`)
- iPad capture/output: `2304x1728`
- capture request: `15-30 fps`
- codec: native/default WebRTC negotiation, currently VP8/libvpx
- `contentHint="text"`
- `degradationPreference="maintain-resolution"`
- no explicit bitrate cap
- no sender framerate cap
- no SDP munging or explicit codec preference
- normal runtime diagnostics overhead: zero

A controlled comparison against `2048x1536` found the `2304x1728` checkpoint modestly sharper without a measurable end-to-end latency regression. The temporary benchmark harness is kept off the production path on `experiment/vp8-ab-benchmark`.

## Deferred work

- [#7](https://github.com/luke-m-selway/ipad-display/issues/7): bounded VP8 bitrate-headroom experiment at the current runtime checkpoint.
- [#6](https://github.com/luke-m-selway/ipad-display/pull/6): proposal-only native Rust + ScreenCaptureKit + VideoToolbox fallback if the current VP8 path is ever no longer sufficient.

Neither item changes the current runtime unless explicitly resumed.

## Architecture

```text
ipad
  ├─ CGVirtualDisplay helper
  │    └─ 1600x1200 logical / 3200x2400 backing
  └─ lightweight Electron host
       ├─ exact virtual-display selection
       ├─ Chromium desktop capture
       ├─ WebRTC / simple-peer
       ├─ private bind: 192.168.2.1:3131
       └─ minimal Safari viewer on iPad
```

The design deliberately preserves the low-latency Chromium capture → libwebrtc media path while removing the normal Deskreen host UI, pairing flow, source picker, and other general-purpose behavior from the intended workflow.

## Scope

Current production scope is macOS Ventura on the validated Intel MacBook Pro with the dedicated USB/private-LAN iPad link. Windows/Linux support and general Deskreen behavior are not project goals.

## Upstream and license

This project is derived from [Deskreen CE](https://github.com/pavlobu/deskreen), reviewed from upstream commit `b5dc3d4d1a74ec38091d36578fd84174db3792bc` (Deskreen CE v3.2.16).

Deskreen CE and this derivative are licensed under the **AGPL-3.0**. Upstream copyright and third-party dependency notices remain applicable; see `LICENSE` and the repository history for attribution.
