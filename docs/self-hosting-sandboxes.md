# Self-hosting sandboxes

How to run OpenSession sessions inside isolated sandboxes on your own
infrastructure. Companion to `docs/sandboxes-plan.md` (the architecture and
phase plan) and `deploy/sandbox/README.md` (the runner image + provider
internals). This page is the operator's view: what to install, the full
config schema, the provider guides, and the safety switches.

**Default = no sandboxes.** With no config file, every session runs on the
host exactly as before. Sandboxes are opt-in per session (the "Run in
sandbox" toggle on session create, the `sandbox: true` arg on
`create_session`, or a per-automation `sandbox: true` field) and only take
effect once a provider is configured.

## TL;DR (Docker, the self-host default)

```sh
# 1. One-time host setup: block containers from the cloud metadata service
deploy/sandbox/setup-host.sh

# 2. Build the runner image (tags backstage-runner:latest + :<git-sha>)
deploy/sandbox/build.sh

# 3. Configure the provider
cat > ~/.opensession-sandbox.json <<'EOF'
{ "provider": "docker", "image": "backstage-runner:latest" }
EOF

# 4. Restart OpenSession to load runner-internal changes
sudo systemctl restart opensession

# 5. Verify
bun run deploy/sandbox/verify.ts
```

Then create a session with the sandbox toggle on. The session gets a
container named `bks-sbx-<sessionId>` that survives across turns; the badge
in the session header shows `docker · bind` (provider · workspace mode).

### What setup-host.sh does

Installs an idempotent `DOCKER-USER` iptables rule dropping container
traffic to `169.254.169.254` (EC2 IMDS) — the container mirror of the
`IPAddressDeny` the systemd units enforce, so sandboxed agent code can never
mint instance-role credentials. Off-cloud it's harmless. **Not persisted
across host reboots** — re-run it after one (or wire a `@reboot` cron /
systemd oneshot).

### Building the image

`deploy/sandbox/build.sh` builds `deploy/sandbox/Dockerfile` from the repo
root. Pins are `ARG`s — override with `--build-arg` per build:

| ARG | Default | Keep in lockstep with |
| --- | --- | --- |
| `BUN_VERSION` | 1.3.14 | host `bun --version` |
| `CLAUDE_VERSION` | 2.1.218 | host `claude --version` |
| `NODE_MAJOR` | 24 | host Node LTS |
| `OPENCODE_VERSION` | 1.17.15 | host opencode |

Rebuild whenever: the host Claude CLI or bun is bumped, `bun.lock` changes
(any dep, incl. the Agent SDK / vendored codex binary), or **anything under
`src/runner-host/` changes** — sandboxed runs execute the image's copy of
the runner, not your checkout.

### Path parity is load-bearing (do not "tidy" it)

The image reproduces the host's absolute paths exactly: the runner bundle at
`/home/ubuntu/projects/tella-backstage`, the claude CLI at
`/home/ubuntu/.local/bin/claude`, uid-1000 user `ubuntu`, and the session
worktree bind-mounted at its **identical host path**. That parity is what
lets diff/status/push/preview/@-mentions and Claude session resume work
unchanged (resume state is keyed by cwd). If your host's `$HOME` or checkout
path differs, **rebuild the image with matching paths**. This is the one place
the `/home/ubuntu` coupling is intrinsic rather than lazy: the parity is the
mechanism, not a default nobody got round to extracting.

## Images, warm pools and snapshots

Three separate mechanisms get confused with each other. They solve the same
problem — a cold sandbox is slow — at different layers.

### The runner image

The base image a sandbox starts from. `deploy/sandbox/build.sh` builds it and
tags `backstage-runner:latest` plus the git SHA (the tag predates the rename; `IMAGE=` overrides it). It carries the toolchain a
session needs (bun, git, the engine) so no session pays to install them.

This is the piece you should rebuild deliberately: pinning
`"image": "backstage-runner:<sha>"` means a rebuild cannot change behaviour
underneath running sessions, and rolling back is retagging.

Path parity between the image and the host is load-bearing — see the section
above before "tidying" any of it.

### Warm pools (prewarm)

Remote providers take 30–45 seconds to hand back a usable sandbox, which is a
long time to stare at a prompt box. The prewarm pool starts one *while you are
still typing*, so the sandbox is ready when you hit send.

```json
"prewarm": { "enabled": true, "ttlMinutes": 10, "maxLive": 2 }
```

`maxLive` is the setting that matters: prewarms are paid compute whether or not
you use them, and an untouched one is destroyed after `ttlMinutes`. Default is
deliberately 2.

Off by default. Docker starts fast enough locally that it does not need this.

### Snapshots

Snapshots capture a *running* sandbox — installed dependencies, warm caches,
container-layer state — so the next start restores rather than rebuilds. Docker
snapshots on idle-stop; the Firecracker MicroVM backend goes further and
restores from a memory snapshot, so a workspace resumes in about a second.

```json
"snapshots": { "enabled": true, "onIdle": true, "maxPerSession": 2 }
```

Master switch is off. Nothing is captured or restored unless you turn it on, and
`maxPerSession` bounds disk growth — snapshots are large, and without a cap they
are the thing that fills a disk quietly.

Daytona has its own notion: an **org snapshot** that sandboxes are created from.
Worth setting, because Daytona's default is 1 vCPU / 1 GB / 3 GiB, which is too
small for a real repository. Note that custom `resources` are rejected when
creating from a snapshot — sizing lives in the snapshot itself.

### Still rough

Honest status, because these are the newest parts:

- **Snapshot restore is best-effort.** A restored workspace can hold stale git
  refs; `refreshRefs` exists for exactly that. If a session starts confused
  about what branch it is on, suspect this first.
- **Prewarm accounting** across restarts is imperfect — orphaned prewarms are
  reaped, but you may briefly pay for a sandbox nobody adopted.
- **The MicroVM backend is experimental** and not certified. It is the fastest
  option and the least proven.
- Only **Docker, Daytona and Modal** are live-certified. The rest are
  implemented and unproven; see the per-provider status below.

If you are starting out: use Docker, leave prewarm and snapshots off, and come
back to them when cold starts actually bother you.

## Config schema — `~/.opensession-sandbox.json`

Read fresh per run (no restart for value changes — but see "What needs a
restart" below). Missing file, invalid JSON, or unknown values all resolve
to `provider: "local"` (today's host behavior). Env override for the path:
`OPENSESSION_SANDBOX_CONFIG` (used by the verify/conformance suites).

```jsonc
{
  // Which SandboxProvider new opted-in sessions get.
  // "local" | "docker" | "daytona" | "e2b" | "box" | "modal" | "microvm" |
  // "lambda-microvm"
  "provider": "docker",

  // ── Docker provider ────────────────────────────────────────────────
  // Container image (default "backstage-runner:latest").
  "image": "backstage-runner:latest",
  // docker stop idle containers after N minutes (default 30); restarted
  // automatically on the session's next turn.
  "idleStopMinutes": 30,
  // Per-container resource limits (docker --cpus / --memory).
  // Defaults: 4 cpus, "8g".
  "cpus": 4,
  "memory": "8g",

  // Workspace mode for NEW docker sandboxes (existing sandboxes keep the
  // mode they were created with — it's sticky in their state file):
  //  "bind"   (default): the host worktree is bind-mounted at its identical
  //           path. Host-side diff/status/push/preview work unchanged.
  //  "volume": the repo is cloned INTO a per-session volume inside the
  //           container; no host worktree exists at all. destroy() (session
  //           delete / archive sweep) DELETES the volume — un-pushed work
  //           is gone. Push your work. Attached repos + sibling chats are
  //           not supported in volume mode.
  "workspace": "bind",

  // Container ports published for previews (docker -p 127.0.0.1::<port> at
  // container create → random loopback host port; preview.ts routes the
  // same Caddy tailnet-HTTPS front at the published port). Default none.
  "previewPorts": [3300],
  // Allow startPreview to launch the dev-server bring-up INSIDE the
  // sandbox. Default false: only port-mapping + Caddy routing are active
  // (the stock image doesn't carry your app's dev toolchain).
  "devServerInSandbox": false,

  // Snapshot-based warm restores (docker only; see docker.ts "Snapshots").
  // On idle-stop the container is `docker commit`ed; a later ensure() for a
  // GONE container starts from that snapshot — preserving container-layer
  // state (apt/global caches), NOT workspace or engine state (those live on
  // volumes/bind mounts). Absent block = disabled.
  "snapshots": {
    "enabled": false,          // master switch (default false)
    "onIdle": true,            // snapshot right before the idle-stop
    "maxPerSession": 2,        // keep at most N snapshot images per session
    "quickSyncOnRestore": true // git fetch + status after a volume restore
  },

  // Per-repo overrides (keys = repo ids from the repos registry).
  "perRepo": {
    "tella-fusion": { "provider": "docker", "image": "backstage-runner:latest" }
  },

  // ── Transport (how the in-sandbox run host talks to backstage) ─────
  //  "socket" (default): unix socket in a bind-mounted run dir. Docker only.
  //  "ws": the sandbox DIALS OUT to backstage's /opensession/run-ws +
  //        /opensession/rpc-ws routes (token-authed, seq/ack replay on
  //        reconnect). Required for remote providers (they force it
  //        regardless of this value); docker can dogfood it.
  "transport": "socket",
  // Base URL sandboxes dial back to for the ws transport. MUST be reachable
  // FROM the sandbox: your Tailscale ts.net URL or a tunnel for remote
  // providers; 127.0.0.1 never works. http(s):// is normalized to ws(s)://.
  // Default derives from the server's HOST:PORT bind.
  "callbackBaseUrl": "ws://100.65.135.7:3850",

  // Isolated PUBLIC dial-back listener for remote providers — see the
  // "Public dial-back ingress" section below. When enabled with a
  // publicBaseUrl, remote providers dial IT back instead of
  // callbackBaseUrl; docker always stays on callbackBaseUrl.
  "publicIngress": {
    "enabled": false,          // start the listener at boot (needs restart)
    "port": 3860,              // listen port (default 3860)
    "host": "127.0.0.1",       // bind (default loopback — front with Caddy/tunnel)
    "publicBaseUrl": "wss://your.domain"  // what sandboxes dial
  },

  // ── Remote providers ────────────────────────────────────────────────
  "daytona": {
    "apiKey": "dtn_…",         // falls back to DAYTONA_API_KEY
    "apiUrl": "…",             // optional (self-hosted Daytona)
    "target": "…"              // optional region/target
  },
  "e2b": {
    "apiKey": "e2b_…",         // falls back to E2B_API_KEY
    "template": "base"         // sandbox template id (default "base")
  },
  "box": {
    "apiKey": "box_…",         // falls back to BOX_API_KEY
    "apiUrl": "…"              // optional (default https://ascii.dev/api/box/v1)
  },
  "modal": {
    "tokenId": "ak-…",        // falls back to MODAL_TOKEN_ID
    "tokenSecret": "as-…",   // falls back to MODAL_TOKEN_SECRET
    "profile": "default",     // alternative: named ~/.modal.toml profile
    "app": "opensession-sandboxes", // optional Modal App name
    "image": "daytonaio/sandbox:0.8.0", // optional registry image
    "environment": "main",   // optional Modal environment
    "region": "us-east",     // optional Modal region
    "cloud": "aws",           // optional cloud placement
    "publicPreviews": false    // opt in to public Modal tunnel URLs
  },
  "awsLambdaMicrovm": {
    "imageIdentifier": "arn:aws:lambda:us-east-1:123456789012:microvm-image:opensession",
    "imageVersion": "1",       // optional; latest active version by default
    "executionRoleArn": "arn:aws:iam::123456789012:role/OpenSessionMicrovm",
    "region": "us-east-1",    // falls back to AGENT_AWS_REGION/AWS_REGION
    "controlPort": 8080,       // must match the image daemon
    "maximumDurationSeconds": 28800, // AWS hard max: eight hours
    // Optional: endpoint-idle suspension. Omit for long-running agents: their
    // outbound WebSocket does not count as endpoint activity.
    "idleSuspendSeconds": 3600,
    "suspendedDurationSeconds": 3600, // only used with idleSuspendSeconds
    "logGroup": "/aws/lambda/microvms/opensession"
  },
  // Local Firecracker. Build this credential-free golden separately from the
  // preview-pool golden; the latter contains an app and may contain app creds.
  "firecrackerMicrovm": {
    "enabled": false,
    "storeDir": "/opt/firecracker/sandbox-store",
    "indexStart": 64,          // 1..63 are reserved for preview-pool clones
    "indexEnd": 127
  },

  // How remote sandboxes authenticate `git clone` (they can't mount host
  // creds). "none" = public clone; "https-token" injects the token into the
  // https URL (GitHub PAT / x-access-token).
  "cloneCredential": { "type": "https-token", "token": "ghp_…" },

  // Warm-on-typing prewarm pool (remote providers; src/server/sandbox/
  // prewarm.ts): typing a new-session prompt with daytona/e2b selected
  // starts the runner bootstrap immediately; the session create ADOPTS the
  // warmed sandbox, cutting first-turn sandbox latency from ~30-45s+ to
  // seconds. Absent block = these defaults, with `enabled` true whenever a
  // remote provider is configured.
  "prewarm": {
    "enabled": true,           // default: true iff daytona/e2b has an API key
    "ttlMinutes": 10,          // destroy an untouched prewarm after N minutes
    "maxLive": 2               // max live prewarms across all repos (paid compute)
  },

  // Remote runner bootstrap. Sandbox-engine models install the full runner +
  // model CLIs. OpenCode models (OpenAI, Claude and other providers) keep
  // their engine/auth on the host and install only Git/Bun/ripgrep/core
  // workspace tools:
  "runnerBundleUrl": null,     // tarball of the runner bundle (preferred)
  "runnerRepoUrl": null,       // git URL fallback (default: this checkout's origin)
  "runnerSha": null            // pinned ref (default: origin default branch)
}
```

### Local Firecracker MicroVM (host engine, guest workspace)

The `microvm` provider is the local version of the brain/hands split. The
OpenCode model loop and provider credentials stay on the OpenSession host;
`opensession-workspace` executes explicit filesystem and command methods
against a per-session Firecracker guest. OpenCode OpenAI and Claude models use
this host-engine path too.

Build the dedicated control-only golden, then enable it:

```sh
sudo -n bash deploy/sandbox/microvm/refresh-sandbox-golden.sh \
  /opt/firecracker/sandbox-store
```

With no image argument, the refresh builds
`deploy/sandbox/microvm/Dockerfile.workspace`: a dedicated credential-free
workspace image with Git, Bun, Node, ripgrep, jq, sqlite3, iproute2, Python and
native-build basics. It deliberately contains no Claude/OpenCode CLI,
OpenSession runner checkout, or model account directories. Passing a second
image argument is an explicit experimental override. Golden publication is
locked against clone creation and rolls back all three artifacts on failure,
so a clone can never observe a disk/memory/vmstate generation mix.

MicroVMs participate in warm-on-typing when sandbox prewarming is enabled.
The first prompt input restores a workspace-only clone and pre-clones the
selected repo; session creation atomically adopts it. This is not a hidden
model runner: dependency installation, OpenCode/Claude, and provider
credentials remain outside the guest. Unused warm clones follow the normal
prewarm TTL and restart-orphan cleanup.

Do not point this provider at `/opt/firecracker/store`: that is the preview
pool's app-specific golden. The sandbox golden starts only the structured
control daemon and contains no seeded app credentials. Clones use COW ext4
disks and transient systemd scopes, so they survive an OpenSession restart.
They do not yet survive a host reboot/Firecracker crash; push work regularly.
Each restored guest is currently 4 vCPU/12 GB, and browser preview ports are
not exposed yet.

## Public dial-back ingress (remote providers)

Remote sandboxes (Daytona/E2B/Box/Modal/Lambda MicroVMs) run on remote compute and must dial back
to backstage's `/opensession/run-ws/<hostId>` and `/opensession/rpc-ws`
WebSocket routes from the **public internet**. The main server binds the
tailnet and carries the whole app — never expose it. Instead,
`src/server/public-ingress.ts` runs a **second, isolated Bun.serve** when
`publicIngress.enabled` is set:

**What it serves — and everything it will ever serve:**

| Path | What |
| --- | --- |
| `/opensession/run-ws/<hostId>` | WS upgrade — the run host's event stream |
| `/opensession/rpc-ws?host=…` | WS upgrade — the michael-* MCP proxy channel |
| `/ingress-health` | bare `200 ok` (monitors/probes) |

Every other path is a **bodyless 404** — no app routes, no API, no frontend,
no route disclosure. Auth is run-ws.ts's own (shared functions, not copies):
per-launch `wsToken`s keyed by hostId, registered only by ws-transport
launches, constant-time compared **before** the upgrade. With no sandboxed
runs in flight the token registry is empty and every upgrade is a 403.
Being internet-facing it additionally rate-limits upgrade attempts
**per client IP: 30/min → 429** (X-Forwarded-For-aware behind a local
reverse proxy; health is exempt). The main :3850 server keeps serving the
same routes for the tailnet path (docker-ws) — the ingress is additive.

The listener binds `127.0.0.1:3860` by default: something must terminate
TLS in front of it and forward ONLY those paths. Two permanent options:

1. **Public IP + DNS + Caddy path routes** (needs :443 open in the security
   group and an A record):

   ```caddyfile
   your.domain {
       handle /opensession/run-ws/* {
           reverse_proxy localhost:3860
       }
       handle /opensession/rpc-ws {
           reverse_proxy localhost:3860
       }
       handle /ingress-health {
           reverse_proxy localhost:3860
       }
       # …whatever else the domain serves stays in its own handle blocks;
       # the ingress paths never reach it.
   }
   ```

   Caddy fetches/renews the certificate itself; set
   `"publicBaseUrl": "wss://your.domain"`.

2. **Named Cloudflare tunnel** (no inbound ports at all): a `cloudflared`
   service with an `ingress` rule mapping a hostname to
   `http://127.0.0.1:3860`, `publicBaseUrl` = that hostname. Survives
   restarts, no security-group changes; adds Cloudflare as a dependency in
   the dial-back path. (For one-off testing, a QUICK tunnel —
   `cloudflared tunnel --url http://127.0.0.1:3860`, ephemeral URL, no
   account — also works: pass it as `SBX_CONF_PUBLIC_BASE` to the
   conformance suite.)

Enabling/disabling the listener or changing its port/host is a **restart**
(it starts once at boot); `publicBaseUrl` is read per launch like the rest
of the config. Hosted-Daytona reminder: the sandbox side of this dial-back
needs **Tier 3 / self-hosted** egress — lower tiers block outbound traffic
so no ingress URL is reachable from inside.

## Known gaps (remote providers)

- **Audit trail**: in-sandbox runs write their `claude_turn_event` audit
  lines to the sandbox's own `~/.opensession-audit` — docker bind-mounts that
  dir so they land in the host stream, but **daytona/e2b sandboxes keep them
  local and they're lost when the sandbox is destroyed**. Host-side you still
  get the launch/journal/run-ws lines; grep the sandbox itself (`exec`) while
  it lives if you need a remote run's turn-level audit. (The persisted
  opencode transcript had the same gap and is now mirrored host-side from the
  dial-back stream — see `withOpencodeTranscriptMirror` in
  `src/server/sandbox/adapters/bootstrap.ts`; audit mirroring is a possible
  follow-up on the same hook.)

## Kill switch

```sh
touch ~/.opensession-chats/disable-sandboxes
```

Checked per run: while the file exists every NEW run goes local regardless
of config — no restart needed. Remove the file to re-enable. Sessions with
**volume** workspaces are the exception to "goes local": their workspace
only exists inside the sandbox, so their prompts are refused with an
explanatory message instead of silently running against a missing dir.

## What needs a restart

The config file's *values* are read fresh per run. Code changes to the sandbox
path are **runner internals** and need a service restart:

- First-time enablement, provider/transport code changes, anything under
  `src/server/sandbox/`, `src/runner-host/`, run-ws/rpc-ws → real
  `systemctl restart opensession`.
- The publicIngress listener starts once at boot: enabling/disabling it or
  changing `port`/`host` → restart (`publicBaseUrl` value tweaks apply to
  the next launch without one).
- Transport flips (`socket` ↔ `ws`) apply to NEW sandbox launches, but the
  transport code itself must already be live (restart once, then flip
  freely).
- Image changes → rebuild the image; running containers keep their old
  image until destroyed (session delete) or GONE + re-ensured.
- Config value tweaks (idleStopMinutes, previewPorts, cpus/memory…) → no
  restart, but mounts/ports/limits are container-create-time: an EXISTING
  sandbox keeps its old ones until it's recreated.

## Provider guides

### Docker (default, certified)

Covered above. Per-session container, engine state (`~/.claude`, `~/.codex`)
on named volumes so session resume survives stop/start/restart; runs are
`docker exec`s of the same runner-host entry the systemd path uses, so
steer/cancel/reattach-after-restart all work. Verify end-to-end with
`bun run deploy/sandbox/verify.ts` (safe next to a live server — everything
is `sbxtest-*` scratch), and keep the conformance matrix green:

```sh
bun run deploy/sandbox/conformance.ts docker-socket docker-ws
```

To certify the external-engine path through the real OpenSession WebSocket
and session lifecycle, run:

```sh
bun run deploy/sandbox/verify-external-engine.ts --provider daytona --provider modal
bun run deploy/sandbox/verify-external-engine.ts --provider microvm --restart
```

This suite accepts OpenCode OpenAI and Claude models: on remote providers and
MicroVMs, the model loop and provider credentials stay on the host while explicit
`opensession-workspace` methods operate the sandbox. It checks all six methods,
file locality, credential/runner absence, persisted placement, provider
reattachment, and cleanup. Use
`deploy/sandbox/external-engine-test-prompt.md` for the equivalent manual UI
smoke test.

### Daytona (implemented, live-certified — full launchRun matrix green 2026-07-09)

Self-hostable sandbox platform (Helm/K8s) with a hosted cloud. The adapter
(`src/server/sandbox/adapters/daytona.ts`) creates sandboxes over the
Daytona API/SDK: volume-style workspace cloned in-sandbox over https
(`cloneCredential`), ws transport always, runner bootstrapped on first
ensure (minutes cold — provider snapshots as a prebaked fast path are a
backlog item). Idle-stop is native (`autoStopInterval`).

- Config: `provider: "daytona"` + the `daytona` block (or `DAYTONA_API_KEY`)
  + a reachable dial-back URL (the `publicIngress` section above — hosted
  Daytona sandboxes are on the public internet, not your tailnet) +
  `cloneCredential` for private repos.
- **Org-tier egress caveat (hosted Daytona):** Tier 1/2 orgs restrict
  sandbox egress, which blocks the WS dial-back entirely — `launchRun`
  needs a **Tier 3 org or self-hosted Daytona**. Workspace clone/exec work
  on lower tiers; runs don't.
- Certify against your own account/deployment:
  `bun run deploy/sandbox/conformance.ts daytona` (needs the API key; runs
  one smallest-size, sbxtest-labeled sandbox and destroys it, then lists
  the org's sandboxes to prove nothing leaked). The full matrix — incl.
  the launchRun round-trip + steer/cancel + mid-run WS drop/redial — went
  27/27 green 2026-07-09 against hosted Daytona (Tier 3) dialing back over
  the public ingress (`SBX_CONF_LISTEN_PORT=3860
  SBX_CONF_PUBLIC_BASE=wss://your.domain`).

### E2B (implemented, NOT yet certified)

Firecracker microVM sandboxes; hosted cloud plus an OSS self-host stack
(Terraform/Nomad, GCP full / AWS beta — heavyweight; we document it, we
don't operate it). The adapter (`src/server/sandbox/adapters/e2b.ts`) is
written to the same contract as Daytona (volume-style workspace, ws
transport, bootstrap on first ensure) but has **not been run against a live
E2B account** — treat it as untested until the conformance suite passes.

- Config: `provider: "e2b"` + the `e2b` block (or `E2B_API_KEY`).
- Lifetime model differs: an E2B sandbox lives on a countdown that activity
  extends — **expiry KILLS the sandbox and its workspace** (vs. Daytona's
  stop/start). Push early.
- To certify: `bun run deploy/sandbox/conformance.ts e2b` with credentials,
  fix what fails, and record the certification in this doc + the plan.

### Box / ascii.dev (implemented, NOT yet certified)

Persistent Ubuntu VMs (box.ascii.dev): 4 vCPU / 8GB fixed size, Docker
inside the VM, per-second billing, EU-hosted. The adapter
(`src/server/sandbox/adapters/box.ts`) speaks the plain HTTP API (no SDK
dep) to the same contract as Daytona/E2B (volume-style workspace, ws
transport, bootstrap on first ensure) but has **not been run against a live
Box account** — treat it as untested until the conformance suite passes.

- Config: `provider: "box"` + the `box` block (or `BOX_API_KEY`).
- Lifetime model: a TTL countdown to **archival** (disk snapshot; resume
  restores it — gentler than E2B's kill). The adapter resets the TTL to
  `idleStopMinutes` on activity; a long fully-idle gap archives the box and
  the next turn resumes it.
- Exec quirk: the commands endpoint caps at 60s per call, so longer
  commands run detached in-VM and are polled (transparent to callers).
- Preview URLs come from the in-box `host <port>` CLI
  (`https://<subdomain>-<port>.on.ascii.dev`, `_token`-protected).
- No prewarm adapter and no Shell-tab remote PTY yet (SSH-key provisioning
  is the follow-up path for the latter).
- To certify: `bun run deploy/sandbox/conformance.ts box` with credentials,
  fix what fails, and record the certification in this doc + the plan.

### Modal (implemented, live-certified 2026-07-17)

Modal sandboxes are ephemeral containers created through the official
Apache-2.0 TypeScript SDK. The adapter (`src/server/sandbox/adapters/modal.ts`)
uses the same volume-style workspace, remote bootstrap, and WebSocket dial-back
contract as the other remote providers.

- Config: `provider: "modal"` + both Modal token credentials in the `modal`
  block, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or credentials in the
  active/named `~/.modal.toml` profile (`modal.profile` / `MODAL_PROFILE`).
- The default registry image is `daytonaio/sandbox:0.8.0`; set `modal.image`
  to a compatible image with git, curl, and passwordless sudo (or a writable
  `/home/ubuntu`).
- `cpus`, `memory`, `idleStopMinutes`, `previewPorts`, `modal.region`, and
  `modal.cloud` are applied when the sandbox is created. CPU and memory are
  hard limits as well as reservations.
- Modal encrypted tunnel URLs are public Internet endpoints. Preview tunnels
  stay disabled unless `modal.publicPreviews` is explicitly `true`; only use
  that option for dev servers that are safe to expose publicly.
- Modal caps a sandbox's lifetime at 24 hours. Idle timeout or lifetime expiry
  terminates the container and deletes its workspace; the next turn creates a
  fresh sandbox, so push code-mode work early.
- No prewarm adapter or Shell-tab remote PTY yet.
- The live conformance pass covered provisioning, bootstrap, git/exec,
  idempotent reuse, previews, and cleanup. Modal's SDK file-upload helper uses
  `ReadableStream.from`, which Bun lacks; the adapter's streamed-stdin fallback
  was separately verified against a disposable live sandbox with read-back.
- Re-run with `bun run deploy/sandbox/conformance.ts modal`; remote dial-back
  requires a public ingress whose token registry belongs to that test process.

### AWS Lambda MicroVMs (experimental, NOT yet certified)

AWS Lambda MicroVMs are Firecracker VMs purpose-built for agent sandboxes. The
adapter (`src/server/sandbox/adapters/lambda-microvm.ts`) uses the AWS SDK
control plane and authenticated HTTP requests to the structured command daemon
in `deploy/sandbox/lambda-microvm/`.

- Build the ARM64 image first using
  `deploy/sandbox/lambda-microvm/README.md`, then set
  `awsLambdaMicrovm.imageIdentifier`. Ambient AWS credentials must allow the
  MicroVM lifecycle/token APIs and `iam:PassRole` when an execution role is set.
- Runtime disk and background processes survive AWS suspend/resume, and the
  adapter wakes a suspended VM before command/restart recovery. Automatic idle
  suspension is disabled by default because an active run's outbound dial-back
  traffic does not count as endpoint activity to AWS; opt in with
  `idleSuspendSeconds` only when that tradeoff is acceptable.
- Every VM has a hard eight-hour lifetime including suspended time. The adapter
  rotates 30 minutes before expiry only after proving the repo is clean and has
  no commits ahead of upstream. Runtime disk and engine state are not durable
  across that rotation, so the next turn starts a fresh engine. EFS-backed
  rollover remains a follow-up for truly persistent sessions.
- The image runs on ARM64 and needs enough baseline memory/disk for the runner
  and target repo. The AWS image configuration, not this per-run adapter,
  controls those resources.
- `executionRoleArn` is optional. If used, it must be a dedicated least-
  privilege role: agent code has root-equivalent control inside the VM and can
  use every permission granted to that role.
- Preview ports intentionally return no URL yet. AWS requires expiring auth
  headers on every request, so browser previews need an OpenSession reverse
  proxy rather than exposing the raw endpoint.
- No prewarm adapter or Shell-tab integration yet.
- To certify: `bun run deploy/sandbox/conformance.ts lambda-microvm` after the
  image and IAM resources exist.

## Licensing notes

- **Daytona** is AGPL-3.0. OpenSession consumes it **over its API** (via the
  Apache-2.0 `@daytonaio/sdk`) and vendors none of its code, so AGPL
  obligations sit with whoever *operates* the Daytona deployment, not with
  OpenSession's codebase. Self-hosters running Daytona themselves take on
  AGPL's network-service obligations for their Daytona instance.
- **E2B**: the JS SDK is MIT; the self-host infra repo is Apache-2.0.
- **Modal**: the official `modal` TypeScript SDK is Apache-2.0.
- **AWS Lambda MicroVMs**: the AWS SDK client is Apache-2.0.
- **Docker provider**: plain `docker` CLI against your own daemon; nothing
  vendored.
- Core imports adapter SDKs only inside `src/server/sandbox/adapters/` —
  a build without those files carries no third-party sandbox code.

## Security posture (what a sandbox does and doesn't isolate)

- Process/env/resource isolation per session; minimal env (no
  `~/.opensession.env` tokens); IMDS blocked (setup-host.sh / the systemd
  `IPAddressDeny` mirror).
- Phase 1 docker mounts carry **interactive-level ambient trust**: `~/.ssh`,
  `~/.gitconfig`, `~/.config/gh` are mounted read-only for push/PR parity.
  That's the same trust host runs have today — but it's why **automation
  sessions are refused** by the docker launcher in this phase; untrusted
  ticket text never runs with those mounts.
- Volume mode removes the host-worktree mount entirely (per-session disk,
  instant cleanup) at the cost of the destroy-deletes-work contract.

## MicroVM preview backend (Firecracker snapshots)

The preview pool's third backend (`backend: "microvm"`, the default since
2026-07-24) restores Firecracker clones from a golden **memory snapshot** —
claims serve in ~2-5s with zero warm RAM. Requires KVM (`/dev/kvm`): on AWS
that means a bare-metal instance or the 8i-generation nested-virt families
(C8i/M8i/R8i). Assets live in `deploy/sandbox/microvm/`:

- `refresh-golden.sh` — docker-golden → `docker export` → ext4 rootfs
  (`build-rootfs.sh` injects `bks-init` as PID 1 plus the control.py agents)
  → boot under Firecracker → warm routes → pause → Full snapshot → kill.
  The canonical store paths and the tap name/guest IP are **load-bearing**:
  the vmstate embeds them. The base disk is frozen at pause time — never
  boot it read-write again.
- `clone.sh create|destroy <idx>` — per-claim: reflink COW disk (the store
  MUST be XFS — `/opt/firecracker/store.img` loop-mounted via fstab), a
  private netns recreating exactly `bkstap0`/172.16.100.2, snapshot load
  (~18ms), guest clock resync via the root agent (SigV4 tolerates <5min
  skew). VMs run in transient scopes (`bks-fc-clone<idx>`) so they survive
  opensession restarts.
- `bks-host-setup.service` — boot oneshot re-arming the docker/guest IMDS
  drop rules. Enable it; nothing else needs manual re-arming after reboot.

Host prereqs: `firecracker` + a CI `vmlinux` under /opt/firecracker, the
service user in the `kvm` group, the XFS store mounted. Known limits: no
jailer isolation yet (previews run our own code; harden before anything
multi-tenant), claims need ~8GB free page cache for comfort (the memory
file is pre-faulted), and un-pushed branches ship to clones via the agent
/files channel (30MB bundle cap).
