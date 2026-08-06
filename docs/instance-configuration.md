# Instance configuration

Open Session application code has portable defaults. Team-specific repositories,
identity, domains, policy, integrations, and routines belong in
`~/.opensession/config.json`; use
[`config.example.json`](../config.example.json) as the schema and starting
point.

## Portability boundaries

- `repos` is authoritative when present. Repository behavior such as dependency
  installation, preview startup, warm-cache markers, AWS profile names,
  deployment tracking, and security-scan guidance lives on each repo entry.
  A repo entry can also carry an `icon` — a PNG served as the repo's tile icon
  (absolute path, or relative to the checkout); unset falls back to the GitHub
  org avatar (`src/server/routes/static-assets.ts`).
- `identity.team` owns commit attribution, GitHub/Slack/Linear mappings,
  per-user connector access, and the team web-sign-in allowlist. There is no
  built-in company roster. `identity.defaultTimezone` controls the fallback
  used for team-local scheduling and defaults to `UTC`.
- `branding` and `persona` are injected into the frontend and prompt builders.
  The frontend bootstrap also receives the public base URL, default repo id,
  configured GitHub bot logins, and the Plain workspace id.
- Integrations are off unless `integrations.<name>.enabled` is true (or an
  explicit enable/disable environment variable is set). Integration-specific
  values such as OAuth callbacks, GitHub/Plain mention handles, Slack
  workspace metadata, and Linear team keys live in the same section. Plain
  additionally takes `integrations.plain.workspaceId` (your `w_…` workspace
  id, used for deep links into app.plain.com; unset hides the UI's "open in
  Plain" affordances) and `integrations.plain.apiUrl` (the GraphQL endpoint
  for direct API calls, defaulting to Plain's hosted
  `https://core-api.uk.plain.com/graphql/v1`).
- Company routines are data. `integrations.seeds.actions` and
  `integrations.seeds.automations` create records only when
  `integrations.seeds.enabled` is true. Existing persisted records are never
  deleted when seeds are disabled.

Client distributions have their own packaging configuration. The values
committed here are deliberately **portable** — `http://127.0.0.1:3850`, so a
fresh clone points at your own machine and not at somebody else's server. Release
workflows stamp the real address in at build time from the `OS1_SERVER_URL`
repository variable.

Every client also lets the user change the server at runtime, so a wrong default
is an inconvenience rather than a dead end:

| Client | Where the user changes it | Build-time default |
| --- | --- | --- |
| Chrome extension | the Server field in the side panel | `os1-chrome/deployment.json` |
| Electron shell | `OS1_URL` / `OS1_CLOUD_URL` env | `os1-mac/package.json` → `opensession.defaultServer` |
| Swift app (iOS/macOS) | Settings → Server | `OS1DefaultServerURL` in `os1-ios/project.yml` |
| Web UI / PWA | n/a — served by the server itself | n/a |

Packaging configuration:

- Chrome: `os1-chrome/deployment.json`
- Electron: `os1-mac/package.json` → `opensession.defaultServer`
- Swift: `OS1DefaultServerURL` in `os1-ios/project.yml`

Bundle identifiers, signing teams, provisioning profiles, update feeds,
entitlements, deployment scripts, and infrastructure log destinations are
distribution/deployment metadata. A downstream distributor should replace
those files without changing application behavior.

## Compatibility literals

Several old names are protocol or persisted-data compatibility, not instance
branding. Do not rename the `bks-` session-id prefix or `OPENSESSION_VIDEO:` —
running and historical sessions depend on them.
