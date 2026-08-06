# OS¹ for Mac

A thin Electron shell around a configured Open Session server, with
an opt-in local mode that supervises a local Open Session backend. Both modes use
the current hosted frontend; in local mode the loopback server proxies that app
shell so its same-origin API and WebSocket requests stay local. The app only
owns the window, navigation policy, local process lifecycle, notifications,
dock badge and deep links.

The shell lives in `os1-mac/` inside the Open Session repository so native
window changes and their frontend counterparts can ship together.

## Development

```sh
cd os1-mac
bun install
bun start
```

Requires network access to the configured server; otherwise you get the
built-in retry screen.

### Local sessions

Choose **OS¹ → Use Local Sessions** and the app relaunches against a supervised
local server. Packaged builds work out of the box: the app bundle ships a
prebundled server sidecar (`Contents/Resources/server`, built by
`scripts/build-server-sidecar.ts`) and a pinned Bun runtime
(`Contents/Resources/bun`), so no checkout, bun install, or PATH setup is
needed. What local sessions still need from the machine is a model login —
the Claude Code or Codex CLI credentials the local engine runs on.
`OS1_LOCAL=1 bun start` forces the same mode for development.

To hack on the server itself, a source checkout overrides the sidecar:

```sh
git clone https://github.com/tellahq/opensession ~/os1/server
cd ~/os1/server
bun install
```

The shell configuration is `settings.json` in Electron's `app.getPath("userData")`
directory:

```json
{
  "localMode": true,
  "serverDir": "/Users/ada/code/opensession"
}
```

All fields are optional. `localMode` defaults to `false`. The server is
resolved in order: `serverDir` (a source checkout or a sidecar-shaped
directory), then the `~/os1/server` checkout when it exists, then the bundled
sidecar. Local mode accepts only the active
`opensession_auth` cookie from the Electron cloud session: sign in through cloud
mode first, then enable local sessions. An expired or revoked session locks the
local API and WebSocket until cloud sign-in and local mode are restarted. Child
output is appended to `local-server.log` in the same user-data directory.

The local server supplies backend code only. It never builds or serves its
frontend; shell documents and assets are proxied from the configured cloud
upstream (the distribution's `opensession.defaultServer`, or `OS1_CLOUD_URL`)
while the browser origin remains the loopback server. The sidecar is frozen at the shell's release (auto-update
keeps it current); a source checkout tracks whatever you pull.

### Iterating on the frontend before it ships

The shell renders whatever the server serves. To test unmerged Open Session
frontend changes against **live production data**, run this from the
repository root:

```sh
bun app:dev
```

This starts the local SPA on `:3851`, waits for it to become ready, prepares a
lightweight unsigned development `.app`, launches it with the proper OS¹ Dock
name/icon, and stops both processes together on `Ctrl+C`. Fully quit an
already-running OS¹ first (`⌘Q`); closing its window only hides it and the
single-instance lock would otherwise reuse that older process.

Edits hot-reload in place (React Fast Refresh + CSS hot-swap; Tailwind output
refreshes within ~3s). ⚠️ Writes are real — prompts/steers/archives hit
production. For a fully isolated sandbox instead, run the whole server locally
(`mkdir -p ~/.opensession-sessions && bun --hot run opensession.ts`, port 3850) —
empty local state, optionally rsync'd from prod.
`OS1_URL` overrides the server for a run. Distributions set
`opensession.defaultServer` in `package.json` (or `OS1_CLOUD_URL`).

## Architecture

- `src/main.js` — a single sandboxed `BrowserWindow` loading the cloud or active
  loopback server (`contextIsolation`, no Node in the renderer). In-window
  navigation is limited to the active app origin plus
  `github.com` (the OAuth redirect flow); everything else opens in the default
  browser. Window close hides to the dock; state persists across launches.
- `src/local-server.js` — local-mode server resolution and supervision. It
  resolves which server to run (configured dir → `~/os1/server` checkout →
  bundled sidecar) and which Bun to run it with (bundled → `~/.bun` → PATH),
  picks a free loopback port, starts `bun run opensession.ts` (or the
  sidecar's `opensession.js`, pointing OPENSESSION_MCP_PROXY_ENTRY at its
  prebundled `mcp-proxy.js`), waits for `/api/health`, restarts crashes with
  exponential backoff, logs output under user data, and sends SIGTERM on app
  quit.
- `src/preload.js` — exposes `window.os1` (`desktop`, `setBadge`, `clearBadge`)
  for the frontend to feature-detect and mirror its app badge to the dock.
- `src/offline.html` — retry screen for when the configured server is
  unreachable.
- **The web app's service worker is deliberately blocked** (request to `sw.js`
  cancelled + registrations cleared at boot). Its jobs — Web Push, app-shell
  cache, PWA badge — don't function in Electron anyway, and its Cache Storage
  writes crash Electron 43's renderer with a bad `CacheStorageCache` Mojo
  message (reproducible on every launch; likely an Electron/Chromium bug —
  re-test when bumping Electron majors).
- Window chrome: the frontend already supports Window Controls Overlay (its PWA
  manifest), which Electron activates via `titleBarStyle: hidden` +
  `titleBarOverlay`. The window uses macOS's native `sidebar` vibrancy material;
  the frontend keeps the detail pane opaque and exposes that material only
  beneath its translucent sidebar.

## Auth

GitHub web sign-in works in-window via the redirect flow (github.com is an
allowed navigation origin); the device-flow fallback link works too. The
`opensession_auth` cookie persists in Electron's default session.

## Deep links

- `os1://…` opens the app and maps to the active server
  (e.g. `os1://session/abc` → `/session/abc`). In local mode, incoming
  universal links for the cloud host preserve their path on the local
  origin.
- **Universal links** (plain `https://os.tella.dev/…` links opening the app,
  e.g. from Slack — Tella's host; see the rebrand note under Signing & release):
  the server side is done — Open Session serves
  `/.well-known/apple-app-site-association` for app IDs
  `6GUXT43C8B.dev.tella.os1` (the iOS + Mac App Store pair) and
  `6GUXT43C8B.dev.tella.os1.shell` (this shell). Signed CI
  builds install the
  Developer ID profile from the `OS1_PROVISIONING_PROFILE_BASE64` repository
  secret and sign the top-level app with `build/entitlements.mac.applinks.plist`;
  the release fails if either the signed entitlement or embedded profile is
  missing. The Electron helpers keep inheriting `build/entitlements.mac.plist`
  (no associated-domains): they carry no provisioning profile, and macOS
  SIGKILLs any helper that claims a restricted entitlement it can't back with
  one — which surfaces as `GPU process isn't usable. Goodbye.` at launch. Local
  unsigned builds use `build/entitlements.mac.plist` for both and need no
  profile.
  Caveat: os.tella.dev resolves to a tailnet IP, so Apple's AASA CDN cannot
  fetch the association file. The entitlement therefore also lists the
  `?mode=developer` alternate, which fetches directly — each team device must
  enable Associated Domains development mode for the links to activate. If
  that proves too fiddly, `os1://` links remain the reliable path.

## Signing & release

This section (and the universal-links app IDs above) documents **Tella's own
release setup** — Apple team `6GUXT43C8B` and the `dev.tella.os1.*` bundle ids.
If you fork, rebrand those identifiers to your own namespace (your Apple team
id, your bundle id prefix, your server URL) and supply your own signing
secrets; nothing in the shell depends on Tella's values.

CI (`../.github/workflows/os1-mac-release.yml`) builds, signs, notarizes and
publishes a GitHub Release on every `v*` tag. Manual "Run workflow" does a dry
run with artifacts attached to the run. Repository secrets (the values below
are Tella's — supply your own):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATES_P12` | "Developer ID Application: Tella HQ Inc. (6GUXT43C8B)" as base64 .p12 |
| `APPLE_CERTIFICATES_PASSWORD` | password of that .p12 export |
| `APPLE_ID` | Apple ID with app access |
| `APPLE_APP_PASSWORD` | app-specific password for that Apple ID |

Releasing: `git tag v0.1.0 && git push origin v0.1.0`.

Local `bun run dist` produces an unsigned build (signing/notarization are
skipped with a warning when no identity/credentials are present). It first
fills the gitignored `build/vendor/` directory: pinned OpenCode 1.18.4
(`scripts/fetch-opencode.sh`), pinned Bun 1.3.14 (`scripts/fetch-bun.sh`), and
the server sidecar (`scripts/build-server-sidecar.ts` — requires `bun install`
at the repository root first). Release builds copy those into
`Contents/Resources` (`opencode`, `bun`, `server/`); `scripts/sign-binaries.js`
signs the two Bun-based CLIs with `build/entitlements.opencode.plist` and every
Mach-O inside the sidecar's node_modules with plain hardened-runtime
signatures. The workflow verifies the versions, Developer ID signatures, JIT
entitlements, sidecar layout, and enclosing app signature before notarization. The package keeps only Electron's English locale
resources because OS¹ is currently English-only; Chromium's unused locale set
otherwise adds roughly 49 MB to the installed app.

## Auto-update

The packaged app keeps itself current via Electron's built-in Squirrel.Mac
updater. It polls `<cloud server>/api/os1-mac/update?version=<installed>`
on launch and every 4 hours — served by `src/server/routes/os1-update.ts` in
this repository, which serves the latest GitHub release in Squirrel's static
JSON feed format and proxies the signed arm64 zip out of it (Squirrel can't
reach a private GitHub repo itself). When an update is found Squirrel downloads it
in the background; the web frontend shows a persistent bottom-right toast
(`DesktopUpdateToast`, driven by `window.os1.updates` from `src/preload.js`)
that flips to "Restart to update" once the download is staged, and restarting
installs + relaunches.

Shipping an update is unchanged: bump `version` in `package.json`, tag, push
the tag. Installed apps (≥ 0.2.0) pick it up on their next check. Dev runs
(`electron .`, unsigned) skip the updater entirely.

## Follow-ups tracked

- **Dock badge**: the web app sets its badge via `navigator.setAppBadge` in the
  service worker, which doesn't reach Electron's dock. Frontend change in the
  Open Session repo: when `window.os1` exists, also call `window.os1.setBadge(n)`.
- **Universal links**: see above.
- **Web Push**: push events don't arrive in Electron (no FCM); notifications
  while the app is running come through the page's WebSocket + Notification
  API, which works. Closed-app push would need a native APNs story — not
  planned.
