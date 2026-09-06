---
type: reference
status: current
as_of: 2026-09-06
source_of_truth: package.json and src/client-viewer/package.json
---

# Dependency audit

This record owns the reachability classification for issue #13. The manifests
and lockfiles own exact versions.

## Dedicated iPad runtime boundary

`scripts/ipad` starts `out/main/ipad-host.js` and serves `src/ipad-viewer`.
Its Node/Electron closure uses Electron, `@electron-toolkit/utils`, `uuid`,
`shortid`, `electron-log`, Koa, the Socket.IO server, and their required
transitive dependencies. The iPad viewer receives vendored `socket.io-client`
and `simple-peer` assets.

The root Electron configuration still builds retained Deskreen
main/preload/renderer code and copies `src/client-viewer`; those paths do not
start for `ipad` or `ipad touch`. Material/Blueprint/general UI packages,
`@roamhq/wrtc`, devtools, storage, i18n, QR, React, and client-viewer packages
remain classified as retained legacy UI/runtime support. Electron builder/Vite,
Biome, TypeScript, `fs-extra`, and type packages are build/typecheck support.
The retained paths are not assumed safe to delete.

## Changes

Removed proven-unused root packages: `@blueprintjs/select`, `classnames`,
`electron-settings`, `electron-updater`, `i18next-sync-fs-backend`,
`@vercel/blob`, and stale stub type packages. Removed unused client-viewer
`react-app-polyfill` and stale type packages.

Updated retained packages only through compatible releases: `axios` 1.20.0,
`i18next-fs-backend` 2.6.7, `ua-parser-js` 2.0.10, Vite 7.3.6, `nanoid`
3.3.18, `engine.io-client` 6.6.6, `socket.io-parser` 4.2.7, and `fast-uri`
3.1.7. Lockfile resolution also selects fixed compatible transitive versions,
including `ws` 8.21.3.

No forced audit remediation, major Electron migration, or identity/signing
change was performed.

## Audit result

| Lockfile | Before | After full audit | After production-only audit |
| --- | --- | --- | --- |
| Root | 33: 1 low, 4 moderate, 24 high, 4 critical | 2 high | 0 |
| `src/client-viewer` | 17: 7 low, 4 moderate, 6 high | 6 low | 0 |

No reported advisory is production-reachable from `ipad` or `ipad touch` after
this cleanup.

Remaining advisories are build/dev-only:

| Advisory chain | Dependency path | Disposition |
| --- | --- | --- |
| `electron`, `extract-zip` (2 high) | root dev dependency `electron` → `extract-zip` | Deferred: the available Electron remediation is a major runtime migration, outside the qualified display/touch surface. |
| `browserify-sign`, `create-ecdh`, `crypto-browserify`, `elliptic`, `node-stdlib-browser`, `vite-plugin-node-polyfills` (6 low) | client-viewer dev dependency `vite-plugin-node-polyfills` → `node-stdlib-browser` → `crypto-browserify` | Deferred: replacing the legacy client browser-polyfill stack is a behavior-affecting build migration. |

Re-run from the root and from `src/client-viewer` after changing either
manifest:

```bash
npm audit --package-lock-only --json
npm audit --package-lock-only --omit=dev --json
```
