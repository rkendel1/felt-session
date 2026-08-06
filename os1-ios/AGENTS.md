# OS1 native app (iOS + macOS, SwiftUI) — agent guide

This directory is the NATIVE Swift client for OS1: one SwiftUI codebase, two
targets — `OS1` (iOS 26+) and `OS1Mac` (macOS). It is not the web UI
(`src/frontend/`) and not the Electron desktop shell (`os1-mac/`); see the
"client apps" section of the root AGENTS.md for how to disambiguate requests.
`README.md` here is the human-facing overview (features, architecture map,
WS protocol notes) — keep it updated alongside changes.

## Project setup

- The Xcode project is GENERATED: `project.yml` (XcodeGen) is the source of
  truth — `OS1.xcodeproj` is not checked in and must never be hand-edited.
  New/removed Swift files under `OS1/` are picked up by `xcodegen generate`.
- Deployment targets live in `project.yml` (iOS 26.0; don't trust stale docs).
- Pure SwiftUI. SwiftStreamingMarkdown is the deliberate exception to the
  no-third-party-dependencies default; discuss any additional dependency first.
- Both targets share one bundle id (one App Store Connect record, universal
  purchase) — Tella ships `dev.tella.os1`, set in `project.yml`; forks rebrand
  to their own team id and bundle-id prefix. The Electron shell uses a
  distinct `.shell`-suffixed id (Tella: `dev.tella.os1.shell`); two Mac apps
  must never share a bundle id.

## Building and testing (from a non-Mac host)

A Linux host has no Xcode. Verify every change on a Mac build node over SSH —
the commands below show how Tella does it (`ssh tella-mac-node`, Xcode 26.6);
substitute your own Mac's hostname:

```sh
rsync -a --delete os1-ios/ tella-mac-node:/tmp/os1-check/os1-ios/
ssh tella-mac-node '
  cd /tmp/os1-check/os1-ios && xcodegen generate --quiet
  xcodebuild -quiet build -skipMacroValidation -project OS1.xcodeproj -scheme OS1 \
    -destination "generic/platform=iOS Simulator" -derivedDataPath /tmp/os1-check/dd
  xcodebuild -quiet build -skipMacroValidation -project OS1.xcodeproj -scheme OS1Mac \
    -destination "platform=macOS" -derivedDataPath /tmp/os1-check/dd CODE_SIGNING_ALLOWED=NO
  xcodebuild -quiet test -skipMacroValidation -project OS1.xcodeproj -scheme OS1Mac \
    -destination "platform=macOS" -derivedDataPath /tmp/os1-check/dd \
    CODE_SIGNING_ALLOWED=NO'
```

- Always build BOTH schemes: `#if os(macOS)` blocks only compile in `OS1Mac`.
- Keep `-skipMacroValidation` on noninteractive builds. SwiftStreamingMarkdown's
  exact pinned dependency graph includes the Equatable compiler macro.
- A Mac-target `errSecInternalComponent` CodeSign failure over SSH is the build
  box's locked keychain, not a code error — `CODE_SIGNING_ALLOWED=NO` avoids it
  for compile checks.
- The Linux host can't catch Swift compile errors; never declare a change done
  without a real xcodebuild run.

## Using the Mac node beyond builds

A build node with a logged-in GUI session is a full Mac — use it whenever
a task needs real Apple hardware, not just for compiles:

- **Run the actual app.** `ServerConfig` honors `OS1_SERVER` / `OS1_TOKEN`
  env overrides (nothing persisted), so a built Mac app launches
  pre-configured straight from SSH. If the server isn't reachable from the
  Mac (a private/VPN-only instance), reverse-tunnel it:
  `ssh -R 13850:127.0.0.1:3850 <mac-node> '…'` and launch with
  `OS1_SERVER=http://127.0.0.1:13850 OS1_TOKEN=<token>
  <build>/OS1.app/Contents/MacOS/OS1` (tokens:
  `~/.opensession-web-sessions.json` on the server host). On the iOS simulator the
  same overrides inject via `SIMCTL_CHILD_*`.
- **Profile it.** `sample <pid> 15 -file out.txt` gives per-thread call
  graphs — enough to see exactly what runs on the main thread; `xctrace
  record --template "Time Profiler" --attach <pid>` when a full Instruments
  trace is needed.
- **Micro-benchmark suspect code.** The model files are plain Foundation:
  compile them against a `main.swift` harness (`swiftc -O main.swift
  Session.swift`) and feed real payloads fetched from the live server.

This is how the 2026-07 sessions-poll hitch was found and verified: the old
formatter-per-parse comparator sort measured ~400ms per poll on the Mac (the
fixed decorated sort ~50ms), and a `sample` of the running app confirmed the
main thread idle afterwards. Prefer measuring there over reasoning from
source alone.

## Releasing

Pushing to `main` with changes under `os1-ios/**` auto-triggers the
TestFlight workflows (`.github/workflows/os1-ios-testflight.yml` and
`os1-mac-testflight.yml`; markdown-only changes are excluded from the path
filter). There is no separate release step — treat every push as shipping to
TestFlight.

## Performance invariants (learned the hard way — don't regress)

- **Observation granularity is per view `body`.** `SessionViewModel` is
  `@Observable`; any property read inside `SessionView.body` re-evaluates the
  whole body — transcript included. Per-keystroke state (`draft`, `canSend`,
  `attachedImages`) is read ONLY inside `SessionInputBar`; keep it that way,
  and give other hot state the same treatment (own view struct).
- **Streaming markdown uses one persistent source.** `StreamingMarkdownBody`
  feeds coalesced full-text snapshots through one `StreamedMarkdownView` and a
  newest-only `AsyncStream`; don't recreate the renderer per chunk or bypass
  the source. Durable rows use the library's async `MarkdownView`.
- **Stream text is coalesced.** `stream_text` chunks buffer in the view model
  and flush to `liveText` at ~8Hz; don't bind UI to per-chunk updates.
- **Scroll pinning is explicit.** `onScrollGeometryChange` tracks
  "near-bottom"; new output follows only while pinned, sends and pending
  questions always scroll. Don't rely on `defaultScrollAnchor(... .sizeChanges)`
  alone — keyboard insets and lazy row settling knock it loose.
- Decode server frames off the main thread (see `OS1Socket` / `ServerEvent`);
  the transcript can be large.
- **REST decoding and list preparation are off-main too.** `OS1API` is
  `@MainActor`, so its generic get/post decode via `decodeDetached` —
  `/api/sessions` is multi-megabyte (thousands of rows) and polls every 5s
  while a session is open, and inline decoding was a visible periodic hitch
  while typing. Keep new endpoints on that path, keep the sessions-list
  filter/sort in `SessionsListViewModel.prepared` (detached, decorated sort),
  and never allocate an `ISO8601DateFormatter` per call — `Session.parseISO`
  uses cached thread-safe formatters because it runs inside sort comparators.

## Server coupling

- REST + WS shapes live in `src/server/` (routes, `ws-handlers.ts`,
  `pr-info.ts` for `PrDetails`). Models here decode a tolerant SUBSET —
  optionals everywhere, unknown fields ignored — so server additions never
  break older app builds. Keep new fields optional.
- The server answers a bare JSON `null` for "no PR" style routes — probe the
  raw body before decoding (see `OS1API.pr`).
- Cross-platform shims live in `PlatformCompat.swift`; add new
  iOS-only/Mac-only API bridging there rather than scattering `#if os(...)`.
