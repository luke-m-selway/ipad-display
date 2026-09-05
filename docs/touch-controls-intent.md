# iPad touch controls — intended behaviour

This note records the intended user-facing behaviour for basic touch control from the iPad display. It deliberately does not choose an implementation or technical architecture yet.

## Goal

When the Mac desktop is being shown on the iPad, touching the displayed Mac content should provide simple cursor control without changing the existing display/streaming behaviour.

## Intended controls

- **Tap:** move the Mac cursor to that point and perform a normal left click.
- **One-finger drag:** click and drag on the Mac, suitable for moving windows, selecting text, moving sliders, and similar interactions.
- **Two-finger drag:** scroll the Mac content under the pointer.
- **Text fields:** tapping a text field should focus it on the Mac. Typing remains on the MacBook keyboard; iPad keyboard forwarding is not required.

## Fullscreen behaviour

Touch controls must not conflict with the current tap-to-enter-fullscreen interaction.

Before fullscreen is active, the viewer should present an explicit **Tap to enter fullscreen** affordance. That initial tap is only for entering fullscreen.

Once fullscreen is active, taps and gestures are used for cursor control instead of toggling fullscreen.

## User experience requirements

- Cursor response should feel direct and should not materially add latency to the display stream.
- Touch coordinates should correspond naturally to the Mac content visible on the iPad.
- Touch input must not accidentally control the Mac before the viewer is ready for it.
- Normal mouse/trackpad and keyboard use on the MacBook should continue to work alongside iPad touch control.

## Out of scope for the first version

- iPad keyboard forwarding
- hover emulation
- right-click gestures
- pinch-to-zoom or other extra multitouch gestures
- Apple Pencil pressure or Pencil-specific behaviour
- broader remote-control features
- changes to the video/capture quality or streaming configuration

Technical design, permissions, event transport, macOS input injection, and implementation details are intentionally deferred until this feature is taken up.