---
type: plan
status: temporary
as_of: 2026-09-04
---

# Native Rust VideoToolbox host proposal

> **Covers:** a future macOS-native Rust sender that keeps the iPad browser/WebRTC experience but replaces Electron/Chromium capture and encoding with ScreenCaptureKit + Apple VideoToolbox hardware H.264.
> **Does not change current implementation:** the validated VP8/libvpx path remains the production target. This document authorizes no implementation work.

## Trigger

Do not start this rebuild unless the current VP8 path is no longer sufficient after bounded tuning, or Apple hardware H.264 has a clear expected benefit worth a native sender.

The first implementation task must still be a small proof of concept. Do not commit to a full rewrite before proving hardware encode latency and Safari/WebRTC interoperability.

## Why this fallback exists

The current HiDPI path is already usable: 1600x1200 logical workspace, 3200x2400 backing pixels, dedicated 2048x1536 capture, `contentHint="text"`, `maintain-resolution`, direct USB/private-LAN WebRTC, and Safari as the viewer. A recent VP8 sample produced about 23 fps at 2048x1536 with ~20.5 ms average encode time and acceptable physical latency.

The H.264 experiment in PR #5 proved that asking Chromium WebRTC to prefer H.264 is not enough. Electron 37.10.3 / Chromium 138 negotiated H.264 but selected software OpenH264, with ~41 ms settled encode time and substantially worse physical latency. The runtime reported `videoEncode: disabled_software`, and Chromium's desktop WebRTC H.264 factory contains OpenH264 rather than a macOS VideoToolbox encoder candidate. The current upstream WebRTC desktop factory follows the same pattern, so there is no identified minimal Electron upgrade path.

OBS proves the separate native path on this exact Mac: its macOS VideoToolbox plugin enumerates Apple encoders, selects the exact hardware-accelerated encoder ID, creates a `VTCompressionSession`, and verifies that the session is actually hardware accelerated. The future design should follow that control model rather than merely request the H.264 codec.

## Proposed architecture

```text
ipad command
  ├─ existing CGVirtualDisplay helper initially
  │    └─ 1600x1200 logical / 3200x2400 backing
  └─ Rust host
       ├─ ScreenCaptureKit: exact virtual display
       │    └─ 2048x1536 capture surface
       ├─ VideoToolbox: exact hardware H.264 encoder
       ├─ newest-frame / bounded-queue policy
       ├─ native WebRTC library
       │    └─ H.264 RTP/RTCP + ICE/DTLS/SRTP
       ├─ small HTTP/signalling service on 192.168.2.1
       └─ existing Safari viewer where practical
```

Keep the current shell UX:

```text
ipad
ipad status
ipad stop
```

Retain the existing Objective-C virtual-display helper for the first native proof. Porting that helper to Rust is optional later and should not block the media-path experiment.

## Candidate Rust stack

These are candidates to evaluate, not selected dependencies.

| Concern | First candidate | Why it is relevant |
| --- | --- | --- |
| Apple capture + encode bindings | `objc2-screen-capture-kit` + `objc2-video-toolbox` | Generated Rust bindings exist for both Apple frameworks and expose the native APIs directly. |
| Alternative Apple bindings | `cidre` | Also wraps ScreenCaptureKit and VideoToolbox; compare ergonomics only if `objc2` creates friction. |
| WebRTC | `webrtc-rs/webrtc` | Its current H26x example registers Safari-compatible H.264 `42e01f` and sends encoded H.264 samples with `TrackLocalStaticSample`, which closely matches externally encoded VideoToolbox output. |
| WebRTC alternative | `str0m` | Supports H.264 and application-supplied encoded media through `Writer::write`; its Sans-I/O design could make queue/timing behavior explicit. Its own documentation notes peer-to-peer use is less exercised than its SFU use, so evaluate it second. |

Do not implement WebRTC, RTP, DTLS, SRTP, congestion control, or ICE from scratch.

## Capture contract

Start with ScreenCaptureKit rather than repeating the earlier CGDisplayStream/FFmpeg transport experiments.

Requirements:

- select the exact virtual display by ID;
- preserve 1600x1200 logical desktop geometry and 3200x2400 backing pixels;
- request a 2048x1536 output surface, unless the final VP8 qualification establishes a better capture ceiling that should be inherited;
- prefer a VideoToolbox-friendly pixel format such as NV12/bi-planar 4:2:0 if ScreenCaptureKit can provide it directly on Ventura; avoid unnecessary RGB -> YUV copies;
- use the smallest practical capture queue depth and keep application buffering bounded;
- never process a stale backlog merely to preserve every frame.

The low-latency rule remains: when the encoder cannot keep up, drop stale frames and encode the newest useful frame rather than accumulating latency.

## VideoToolbox contract

Mirror the important OBS behavior, not its recording-oriented settings.

The encoder setup should:

1. enumerate VideoToolbox encoders with `VTCopyVideoEncoderList`;
2. identify the H.264 entry marked hardware accelerated;
3. use its exact `EncoderID` when creating `VTCompressionSession` (and require hardware where the API supports doing so cleanly);
4. verify `kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder == true` after creation;
5. fail the native experiment if hardware acceleration is unavailable rather than silently falling back to software H.264.

Interactive-display defaults should be investigated around:

- `RealTime = true`;
- frame reordering/B-frames disabled;
- Safari-compatible constrained H.264 profile;
- 2048x1536;
- force a keyframe on initial viewer connection and on WebRTC recovery requests;
- no unbounded encoder queue.

The physical iPad currently advertises H.264 constrained baseline `42e01f` and constrained high `640c1f`, including packetization mode 1. Start interoperability work with `42e01f` because the current `webrtc-rs` H.264 example already uses that exact format. Verify that this Mac's VideoToolbox hardware encoder can produce the required constrained profile on Ventura; do not assume it from API availability alone.

Do not copy the current OBS recording settings directly. In particular, do not inherit B-frames or OBS's non-realtime bias. Its 10 Mbps ABR setting is evidence that the hardware encoder handles substantial H.264 throughput, not a target bitrate for this display.

## Encoded-frame boundary

VideoToolbox and WebRTC must agree on access-unit/NAL representation.

VideoToolbox commonly returns length-prefixed H.264 samples. A WebRTC library may expect Annex-B NAL units or another specific H.264 sample representation. The proof of concept must explicitly verify:

- AVCC/length-prefixed -> expected WebRTC sample conversion;
- SPS/PPS extraction and injection at the right points;
- IDR/keyframe detection;
- RTP timestamp progression at 90 kHz;
- packetization mode 1;
- PLI/FIR-triggered keyframes from Safari.

OBS is a useful reference here because its VideoToolbox encoder converts length-prefixed NAL blocks to Annex B and handles H.264 parameter sets at keyframes. Reuse the behavior as a design reference; do not copy implementation code without a license review.

## WebRTC and bitrate policy

Preserve WebRTC because it already solves the parts we do not want to rebuild: browser interoperability, RTP/RTCP, retransmission, timing, ICE, DTLS/SRTP, and recovery behavior.

For the first local USB proof, a bounded fixed bitrate is acceptable if that keeps the test small. A production native sender must then choose one of two explicitly validated policies:

- a fixed bitrate shown to be safe on the dedicated 192.168.2.x USB/private-LAN link; or
- feedback-driven VideoToolbox bitrate updates using the selected WebRTC library's bandwidth/congestion signals.

Do not assume OBS's 10 Mbps is appropriate and do not add a complex congestion controller outside the WebRTC library.

Keep `iceServers` empty and advertise only the private/local host path unless a future requirement changes the networking model.

## Proof-of-concept sequence

### 1. Native encoder microbenchmark

Use the existing virtual display and capture one live 2048x1536 stream into VideoToolbox.

Prove:

- the selected encoder is hardware accelerated;
- the Safari-compatible H.264 profile is accepted;
- average encode time is materially below the current VP8 ~20 ms baseline, ideally below 10 ms;
- CPU use is materially lower;
- no frame backlog develops.

Stop if native hardware encoding does not produce a clear advantage.

### 2. Encoded H.264 -> Safari WebRTC proof

Before integrating the full display lifecycle, feed VideoToolbox-produced H.264 access units into the chosen Rust WebRTC library and display them in Safari.

Prefer `webrtc-rs/webrtc` first because its existing H.264 sample example already demonstrates the required `42e01f` codec negotiation and application-supplied encoded sample path.

Prove:

- Safari connects without a custom iPad app;
- 2048x1536 decodes correctly;
- keyframe/recovery requests work;
- media does not accumulate latency;
- reconnect works.

### 3. Live display integration

Only after both previous gates pass, combine:

```text
virtual display -> ScreenCaptureKit -> VideoToolbox -> Rust WebRTC -> Safari
```

Reuse the current viewer and signalling semantics where that is cheaper than rewriting them. A small viewer/signalling adjustment is acceptable; rebuilding the iPad client as a native/sideloaded app is not.

### 4. CLI/lifecycle integration

Replace the Electron host process behind the existing `ipad` command only after the native path clearly wins. Preserve PID ownership, fixed-IP checks, start/status/stop behavior, and safe teardown.

## Acceptance criteria

The native route is worth adopting only if physical testing shows all of the following:

- hardware acceleration is positively verified by VideoToolbox;
- output remains 2048x1536 with the 1600x1200 logical workspace intact;
- text sharpness is no worse than the VP8 HiDPI baseline;
- normal interaction latency is equal to or lower than VP8;
- encode time is materially lower than the VP8 baseline;
- CPU use is materially lower;
- stale frames are dropped rather than queued;
- Safari reconnect/recovery is reliable;
- normal `ipad`, `ipad status`, and `ipad stop` remain simple;
- no custom iPad application is required.

If it does not clearly beat VP8, keep VP8.

## Open questions for a future implementation

Resolve these before committing to the rebuild:

- Can ScreenCaptureKit capture this CGVirtualDisplay reliably on Intel Ventura and deliver the required 2048x1536 surface without an expensive conversion?
- Which exact VideoToolbox H.264 hardware encoder ID does this Mac expose, and can it encode `42e01f` or `640c1f` in realtime at 2048x1536?
- Does `webrtc-rs/webrtc` handle live VideoToolbox access units, PLI/FIR, retransmission, and Safari negotiation cleanly enough for this use case?
- If not, does `str0m` offer a simpler sender path without requiring us to recreate too much WebRTC behavior?
- Is a fixed bitrate sufficient on the dedicated USB link, or must WebRTC bandwidth feedback update VideoToolbox dynamically?
- What is the lowest stable ScreenCaptureKit/VideoToolbox queue depth on this Mac?
- What frame-rate ceiling is accepted by the final VP8 qualification and should be inherited by the native prototype?
- What licensing obligations apply if code is reused rather than merely informed by OBS or the current AGPL Deskreen-derived repository?

## Explicit non-goals

Do not use this proposal to:

- graft an external VideoToolbox encoder back into Chromium;
- optimize or retain OpenH264;
- implement a custom video transport when WebRTC libraries already exist;
- port the virtual-display helper before the media path is proven;
- build a cross-platform abstraction before the macOS target works;
- add audio;
- change the USB/private-LAN networking model;
- require a native or sideloaded iPad app;
- start implementation without explicit authorization.

## References

Project evidence:

- [PR #4 — HiDPI VP8 baseline](https://github.com/luke-m-selway/ipad-display/pull/4)
- [PR #5 — rejected H.264/OpenH264 experiment](https://github.com/luke-m-selway/ipad-display/pull/5)

External implementation references, pinned where practical:

- [OBS macOS VideoToolbox encoder](https://github.com/obsproject/obs-studio/blob/57bfcf10ac731b9577e6ec42b3d7913f3e9ef168/plugins/mac-videotoolbox/encoder.c)
- [Chromium 138 WebRTC internal encoder factory](https://webrtc.googlesource.com/src/+/e4445e46a910eb407571ec0b0b8b7043562678cf/media/engine/internal_encoder_factory.cc)
- [`webrtc-rs` H.264/H.265 encoded-sample example](https://github.com/webrtc-rs/webrtc/blob/c9c0453cdafb4802cfd154f8736eb9ea8aa9c913/examples/play-from-disk-h26x/play-from-disk-h26x.rs)
- [`str0m` media writer and H.264 overview](https://github.com/algesten/str0m/blob/b616675f09dface72dca285ceead792740642511/README.md)
- [`objc2-video-toolbox` bindings](https://github.com/madsmtm/objc2/tree/0cfd2780067956c8a7a490006e2d7c8b0b3ecfa6/framework-crates/objc2-video-toolbox)
- [`objc2-screen-capture-kit` bindings](https://github.com/madsmtm/objc2/tree/0cfd2780067956c8a7a490006e2d7c8b0b3ecfa6/framework-crates/objc2-screen-capture-kit)
