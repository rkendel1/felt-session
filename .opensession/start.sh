#!/usr/bin/env bash
# Boot a SAFE dev instance of Open Session for an agent-host preview.
#
# This is the repo's lifecycle start script: an Open Session server runs it —
# detached, cwd = this checkout — when someone presses a session's Preview
# button (src/server/preview.ts, resolvePreviewBoot/startPreview). It must
# bring the server up in the FOREGROUND (exec, no backgrounding) so the
# caller's process-group kill can stop it. It is also just a plain script:
# `./.opensession/start.sh` with WEBAPP_PORT set works from any shell.
#
# Environment contract (provided by the preview flow):
#   WEBAPP_PORT          Port the instance must listen on (host previews
#                        allocate 3100-3999). REQUIRED — refused when absent.
#   PREVIEW_URL          Public HTTPS origin fronting that port via Caddy
#                        (https://<host>:<WEBAPP_PORT+6000>). Optional.
#   BACKSTAGE_BOOT_MODE  "fresh" | "snapshot-restore" (informational).
#
# CRITICAL — why every override below is EXPLICIT: when the preview flow runs
# this script, the inherited environment is the calling server's env. On a
# production box that is the systemd service env (EnvironmentFile
# ~/.opensession.env) carrying the production PORT/HOST/WEBHOOK_PORT, live
# ENABLE_* agent toggles and real integration secrets. A `bun run
# opensession.ts` that trusted inheritance would bind production ports, steal
# the live server's run-rpc unix socket, and double-run its agents. So this
# script never inherits an operationally significant variable: each one is
# either overridden or unset, and the instance boots as a demo-mode dev
# server (OPENSESSION_DEV=1 OPENSESSION_DEMO=1) with all state under
# ./.dev-state. See docs/self-development.md for the hazard-by-hazard map.
set -euo pipefail

# cwd is already the checkout when launched by the preview flow; make direct
# human invocations equivalent.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -z "${WEBAPP_PORT:-}" ]; then
	echo "ERROR: WEBAPP_PORT is not set — refusing to boot (PORT would fall back to the production default)." >&2
	exit 1
fi
if [ "$WEBAPP_PORT" = "3850" ]; then
	echo "ERROR: WEBAPP_PORT=3850 is the production Open Session port — refusing to boot." >&2
	exit 1
fi

# The caller's PATH comes from its own service env; a bare shell may lack
# bun. Extend defensively instead of assuming.
case ":$PATH:" in
	*":$HOME/.bun/bin:"*) ;;
	*) export PATH="$HOME/.bun/bin:$PATH" ;;
esac
command -v bun >/dev/null 2>&1 || {
	echo "ERROR: bun not found on PATH ($PATH)" >&2
	exit 1
}

# All instance state (sessions, config, automations, sandbox config, run-rpc
# socket, …) lives here — never in the operator's ~/.opensession-* stores.
STATE_DIR="$PWD/.dev-state"
mkdir -p "$STATE_DIR"

# env -u flags must precede the NAME=VALUE assignments (GNU env argument
# order). What each line neutralizes:
#   -u WEBHOOK_PORT / OPENSESSION_MCP_HTTP_PORT
#       production webhook (3848) / MCP-HTTP (3852) ports ride in via env;
#       the dev boot gate skips both binds when they are unset.
#   -u OPENSESSION_PROFILE
#       a stray local-profile setting must not repoint state to ~/os1.
#   -u OPENSESSION_SESSIONS_DIR / _CONFIG / _RUN_JOURNAL
#       per-store overrides would defeat OPENSESSION_STATE_DIR isolation.
#   PORT/HOST
#       listen where the preview flow told us, loopback only (Caddy dials
#       127.0.0.1:$WEBAPP_PORT).
#   OPENSESSION_DEV=1 OPENSESSION_DEMO=1 OPENSESSION_STATE_DIR
#       dev boot gate (no agents/schedulers/webhooks/adoption) + demo data +
#       isolated state; the run-rpc unix socket lives under the state dir, so
#       this also keeps it away from the live server's socket.
#   OPENSESSION_ENV_FILE=/dev/null
#       nothing re-reads the operator's ~/.opensession.env secrets file (it
#       steers where the web-setup routes read/write; writes fail loudly).
#   NODE_ENV=development
#       the service env pins NODE_ENV=production; this is a dev instance.
#   OPENSESSION_UI_BASE
#       generated links point at the preview origin, not the production UI.
#   OPENSESSION_OC_DETACH=0
#       never spawn detached engine servers from a preview instance.
#   OPENSESSION_GITHUB_AUTH_STORE / _WEB_SESSIONS_STORE / _KEYCHAIN_STORE /
#   _SEARCH_DB
#       belt-and-braces: these stores anchor to $HOME, not the state dir; an
#       ungated writer (e.g. the github-auth token refresher rotating shared
#       refresh tokens) must see empty dev copies, never the live stores.
#   OPENSESSION_OPENCODE_DB / _DB_MAP / _BKS_MAP / _TRANSCRIPTS_DIR
#       the opencode transcript stores default to literal ${HOME}/.opensession-
#       sessions/opencode/* paths that follow NEITHER the sessions-dir env NOR the
#       state dir (opencode-transcript.ts) — the demo replayer writes through
#       recordBksSessionFor, so without these a preview instance would scribble
#       map entries into the live store.
#   ENABLE_*=false
#       the service env sets these to true with real secrets present; only
#       the literal "true" enables an agent, so "false" hard-disables each
#       one even if a boot-gate gap slips through.
exec env \
	-u WEBHOOK_PORT \
	-u OPENSESSION_MCP_HTTP_PORT \
	-u OPENSESSION_PROFILE \
	-u OPENSESSION_SESSIONS_DIR \
	-u OPENSESSION_CONFIG \
	-u OPENSESSION_RUN_JOURNAL \
	PORT="$WEBAPP_PORT" \
	HOST=127.0.0.1 \
	OPENSESSION_DEV=1 \
	OPENSESSION_DEMO=1 \
	OPENSESSION_STATE_DIR="$STATE_DIR" \
	OPENSESSION_ENV_FILE=/dev/null \
	NODE_ENV=development \
	OPENSESSION_UI_BASE="${PREVIEW_URL:-http://127.0.0.1:$WEBAPP_PORT}" \
	OPENSESSION_OC_DETACH=0 \
	OPENSESSION_GITHUB_AUTH_STORE="$STATE_DIR/github-auth.json" \
	OPENSESSION_WEB_SESSIONS_STORE="$STATE_DIR/web-sessions.json" \
	OPENSESSION_KEYCHAIN_STORE="$STATE_DIR/keychain.json" \
	OPENSESSION_SEARCH_DB="$STATE_DIR/search.db" \
	OPENSESSION_OPENCODE_DB="$STATE_DIR/opencode/opencode.db" \
	OPENSESSION_OPENCODE_DB_MAP="$STATE_DIR/opencode/db-map.json" \
	OPENSESSION_OPENCODE_BKS_MAP="$STATE_DIR/opencode/bks-map.json" \
	OPENSESSION_OPENCODE_TRANSCRIPTS_DIR="$STATE_DIR/opencode/transcripts" \
	ENABLE_SLACK_AGENT=false \
	ENABLE_LINEAR_AGENT=false \
	ENABLE_PLAIN_AGENT=false \
	ENABLE_STRIPE_AGENT=false \
	ENABLE_GITHUB_AGENT=false \
	ENABLE_GRAFANA_POLLER=false \
	ENABLE_TELLA_MODULE=false \
	bun run opensession.ts
