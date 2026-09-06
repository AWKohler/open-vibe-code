# Local simulator previews

Set this **server-side** environment variable, then restart the deployment:

```env
SIMULATOR_PROVIDER=local
```

`cloud` (the default when unset) retains the existing Mac fleet. An invalid
value fails closed. `/api/swift-preview/config` exposes the provider to signed-in
clients at runtime; it is not a `NEXT_PUBLIC` build-time flag.

In local mode, Swift preview mounts show the capacity notice and Companion setup.
Cloud start/rebuild endpoints refuse allocation. Device IPA builds and App Store
publishing keep using the existing cloud service. Existing cloud sessions may
still be released after switching the flag.

## Companion

The existing checkout on the development Mac is
`/Users/aronne/Documents/botflow-companion`.
Use the Python engine / native Mac application, not the obsolete `server.mjs` MVP.

The Mac app requires Apple Silicon and macOS 14+. It reports full Xcode setup,
available iOS runtimes, XcodeGen, and idb-companion readiness. Compatible older
Xcodes work; the local builder requests an upgrade only for incompatible SDK /
deployment requirements. Missing runtimes get runtime-specific instructions.

The packaged app bundles its Python runtime, input CLI, XcodeGen, and H.264
capture helper. Xcode/runtimes and idb-companion remain installed by the user.
The latter can be installed with `brew tap facebook/fb && brew install idb-companion`.
Apple-ID sign-in is not required for simulator builds.

For development, install Companion's engine requirements and run:

```sh
BOTFLOW_SIMULATOR_ORIGINS=http://localhost:3000 engine/.venv/bin/python engine/companion.py
```

Production allows only `https://botflow.io` and `https://www.botflow.io`. Additional
development origins must be explicitly configured in the worker environment;
arbitrary preview domains are not trusted. The engine advertises simulator
protocol version 1 at port 17321. A supervised worker binds to 127.0.0.1:17322.

The browser uses an origin-bound connection token and per-session stream secret.
The project source endpoint retains Clerk/project/Swift-plan authorization and
returns uncached archive bytes; browser code transfers them to its own Companion.
Cloud credentials are never sent to Companion. Local archives reject path
traversal, links, special files, excessive expansion, and oversized uploads.

Only simulators created by Companion are shut down/deleted. The worker reaps
abandoned sessions, cleans up its own devices after a crash, and uses an exclusive
data-directory lock to keep a second worker from deleting a live session.

Local preview supports builds, refresh, touch/swipe/scroll/keyboard input,
screenshots, and orientation (iOS 16+). H.264 capture falls back to JPEG screenshot
streaming when needed. Webcam forwarding is currently cloud-only; its local
control is disabled with an explanation. The Mac must stay awake during preview.

## Verification

```sh
node --import tsx --test src/lib/simulator-provider.test.ts src/components/persistent-workspace/swift-preview-session-pool.test.ts
npm run build
```

Companion includes `engine/simulator/test_worker.py` and
`scripts/test-local-simulator.py`. The latter builds a disposable SwiftUI app,
streams it, sends input, rebuilds it, and deletes its simulator.

`node scripts/verify-local-simulator.mjs /path/to/fixture.tgz` runs the actual
React preview in a fresh headless browser against the real Companion. It serves
fixture-backed config/source/state API responses at localhost:3000, requires the
port to be free, and verifies setup, decoded video, rotation, refresh and Stop.
This is not a test of production Clerk authentication or live sandbox export.
Set `BOTFLOW_TEST_BROWSER` to another Chromium executable if needed. Screenshots
and request records are written to `/tmp/botflow-browser-test`.

## Release

Build and notarize the updated Companion before enabling local mode for users.
Publish its DMG through the existing `botflow-companion-dist` release channel, or
set `NEXT_PUBLIC_COMPANION_MAC_URL` to the new release asset. Old Companion builds
are detected and show an update prompt. A Developer-ID signature alone does not
replace notarization; the packaging script accepts `NOTARY_PROFILE` for the
existing `notarytool` keychain profile. This change does not publish a release or
change the production deployment environment.
