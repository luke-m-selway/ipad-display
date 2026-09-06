# Agent instructions

These instructions apply to coding and automation agents working in this repository.

Read `README.md` before changing supported behavior, command semantics, deployment, touch controls, or the public project boundary.

For explicit code-maintainability review, or before creating or modifying source code, scripts, or behavioral/executable configuration, read and apply `.agents/skills/code-maintainability/SKILL.md`.

For documentation work, and before completing a technical change that may alter documented state, read and apply `.agents/skills/lean-documentation/SKILL.md`.

## Product and runtime guardrails

- `README.md` owns the supported user-facing setup and command contract. Keep it current when that behavior changes.
- Preserve plain `ipad` as the lowest-complexity display-only path; it must never start the touch helper. Touch remains explicit through `ipad touch`.
- Do not implicitly switch a running stack between display-only and touch modes.
- Preserve stack-owned process/PID state and safe teardown. Do not use broad process-kill commands to recover the host, helper, browser, or virtual display.
- Preserve the single-current-viewer, generation/session-bound authority model. Ignore stale authority rather than adding competing lifecycle owners.
- Prefer dropping stale media work over accumulating a latency-producing backlog.
- Do not add arbitrary production timers to repair lifecycle, reconnect, or gesture behavior when an event/state boundary can own the transition.

## Stable baseline and experiments

Current `main` is the qualified rollback path. Keep substantial media, transport, Android/tablet, display-geometry, packaging, or lifecycle experiments isolated until physical evidence shows they are ready to replace or extend the baseline.

Do not change the existing iPad media path, virtual-display identity, or command semantics merely to create a generic abstraction for another device. Share infrastructure only after a real common boundary is demonstrated.

Do not casually change Electron Builder identity/signing configuration as part of unrelated work; macOS privacy/TCC behavior can depend on application identity.

## Public-repository boundary

This repository must be self-contained for external contributors and repo-local agents. Do not add required references to private repositories, private ChatGPT/project instructions, private host paths, credentials, or inaccessible operating infrastructure.

When using external implementation references or adapting external code, record the public source and license where needed and preserve applicable attribution/notices.

## Validation

Run the checks relevant to the changed surface. The normal code-change baseline is:

```bash
node --test scripts/test-ipad-*.mjs
npm run typecheck
npm run build
bash -n scripts/ipad scripts/install scripts/ipad-doctor
git diff --check
```

Use narrower checks only when the change cannot affect the broader runtime, and state that boundary in the result.

Changes affecting media latency/quality, capture, virtual-display behavior, touch/input, USB networking, lifecycle/reconnect, installer behavior, or macOS privacy integration require physical qualification on supported hardware before they can be claimed as fully validated. Automated success does not substitute for that physical gate.
