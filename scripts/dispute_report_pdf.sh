#!/usr/bin/env bash
#
# dispute_report_pdf.sh — render an HTML dispute report to PDF and upload it
# to a Slack channel. Used by the "Stripe dispute investigation" automation:
# the agent writes a self-contained HTML report (verdict + evidence package +
# a full chronological activity table), then calls this to turn it into a
# readable PDF and attach it in #stripe-disputes.
#
# Usage:
#   dispute_report_pdf.sh --html <file> --channel <id> [options]
#
# Options:
#   --html <file>      Path to a complete, self-contained HTML file (required).
#   --channel <id>     Slack channel ID to upload into, e.g. C0BCLNKE3C7 (required).
#   --title <text>     Title shown for the file in Slack (default: "Dispute report").
#   --comment <text>   Initial message posted alongside the file (optional).
#   --out <file>       Where to write the PDF (default: alongside the HTML, .pdf).
#   --filename <name>  Filename for the uploaded PDF (default: derived from --out).
#
# The Slack bot token is read from $SLACK_BOT_TOKEN, falling back to
# SLACK_BOT_TOKEN in ~/.slack-agent.env. The bot needs the files:write scope.
# Reading the file directly (rather than an env var) is deliberate: automation
# runs get a minimal env with no tokens, so the script sources its own.
#
# The report contains customer PII, so the PDF is written with a private
# (0600) umask. On success prints the permalink of the uploaded file; exits
# non-zero with a clear message on any failure so the automation can surface
# it to a human (and fall back to posting the text report).

set -euo pipefail
umask 077

HTML_FILE=""
CHANNEL=""
TITLE="Dispute report"
COMMENT=""
OUT=""
FILENAME=""

die() { echo "dispute_report_pdf: $*" >&2; exit 1; }

# Slack error bodies can be long; keep diagnostics readable in logs.
trunc() { echo "$1" | head -c 500; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --html) HTML_FILE="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --comment) COMMENT="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --filename) FILENAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/!d; s/^# \{0,1\}//; p}' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$HTML_FILE" ]] || die "missing --html"
[[ -f "$HTML_FILE" ]] || die "HTML file not found: $HTML_FILE"
[[ -n "$CHANNEL" ]] || die "missing --channel"

# Resolve the Slack token, tolerating optional `export`, surrounding quotes,
# and CRLF line endings in the env file.
TOKEN="${SLACK_BOT_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HOME/.slack-agent.env" ]]; then
  # Strip the CR before the quotes so CRLF files still unquote correctly; the
  # `|| true` keeps a no-match grep from aborting before the emptiness check.
  TOKEN=$(grep -m1 -E '^(export )?SLACK_BOT_TOKEN=' "$HOME/.slack-agent.env" \
    | sed -E 's/^[^=]*=//; s/\r$//; s/^["'\'']//; s/["'\'']$//' || true)
fi
[[ -n "$TOKEN" ]] || die "no Slack token (set SLACK_BOT_TOKEN or ~/.slack-agent.env)"

# Resolve a Chrome binary.
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
[[ -n "$CHROME" ]] || die "no Chrome/Chromium binary found for PDF rendering"

[[ -n "$OUT" ]] || OUT="${HTML_FILE%.*}.pdf"
[[ -n "$FILENAME" ]] || FILENAME="$(basename "$OUT")"

# A private per-run profile dir so concurrent dispute runs don't fight over the
# default Chrome profile lock; cleaned up on exit.
PROFILE_DIR=$(mktemp -d)
trap 'rm -rf "$PROFILE_DIR"' EXIT

echo "Rendering $HTML_FILE → $OUT (via $CHROME)..." >&2
# Remove any stale PDF first so the -s check can't pass on a previous render.
rm -f "$OUT"
# --headless=new prints to PDF; the dbus/gpu warnings on a headless VPS are harmless.
"$CHROME" --headless=new --no-sandbox --disable-gpu --no-pdf-header-footer \
  --user-data-dir="$PROFILE_DIR" \
  --print-to-pdf="$OUT" "file://$(realpath "$HTML_FILE")" >/dev/null 2>&1 \
  || echo "dispute_report_pdf: Chrome exited non-zero (continuing if a PDF was written)" >&2

[[ -s "$OUT" ]] || die "Chrome did not produce a PDF at $OUT"
head -c4 "$OUT" | grep -q '%PDF' || die "rendered file at $OUT is not a valid PDF"

SIZE=$(stat -c%s "$OUT")
echo "Rendered ${SIZE} byte PDF. Uploading to Slack channel $CHANNEL..." >&2

# Step 1 — reserve an upload URL. Parse ok + url + file_id in one pass so a
# non-ok response fails here with the body rather than later, confusingly.
# The `|| die` below relies on python printing nothing on failure (it exits
# before any print), so `read` hits EOF and returns non-zero — keep it that way.
UPLOAD_JSON=$(curl -s -G "https://slack.com/api/files.getUploadURLExternal" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "filename=$FILENAME" \
  --data-urlencode "length=$SIZE") || die "getUploadURLExternal request failed (curl exit $?)"

read -r UPLOAD_URL FILE_ID < <(echo "$UPLOAD_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('ok'): sys.exit(1)
print(d['upload_url'], d['file_id'])
") || die "getUploadURLExternal failed: $(trunc "$UPLOAD_JSON")"

# Step 2 — upload the bytes to the reserved URL (returns "OK - <bytecount>").
UPLOAD_RESULT=$(curl -s -F "file=@${OUT};filename=${FILENAME}" "$UPLOAD_URL") \
  || die "file upload POST failed (curl exit $?)"
[[ "$UPLOAD_RESULT" == OK* ]] || die "file upload POST did not return OK: $(trunc "$UPLOAD_RESULT")"

# Step 3 — complete the upload and share it into the channel.
FILES_JSON=$(python3 -c "import json,sys; print(json.dumps([{'id': sys.argv[1], 'title': sys.argv[2]}]))" "$FILE_ID" "$TITLE")
COMPLETE_ARGS=(-s -X POST "https://slack.com/api/files.completeUploadExternal"
  -H "Authorization: Bearer $TOKEN"
  --data-urlencode "files=$FILES_JSON"
  --data-urlencode "channel_id=$CHANNEL")
[[ -n "$COMMENT" ]] && COMPLETE_ARGS+=(--data-urlencode "initial_comment=$COMMENT")

COMPLETE_JSON=$(curl "${COMPLETE_ARGS[@]}") || die "completeUploadExternal request failed (curl exit $?)"
PERMALINK=$(echo "$COMPLETE_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('ok'): sys.exit(1)
fs = d.get('files', [])
print(fs[0].get('permalink', '') if fs else '')
") || die "completeUploadExternal failed: $(trunc "$COMPLETE_JSON")"

echo "Uploaded PDF to Slack: ${PERMALINK:-(no permalink)}"
