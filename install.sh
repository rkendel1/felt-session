#!/usr/bin/env bash
#
# OpenSession installer.
#
#   curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
#
# Gets a bare box to a working `opensession` command: installs Bun if needed,
# clones the source, installs dependencies, puts a shim on PATH, and hands off
# to `opensession onboard`.
#
# Safe to re-run — an existing install is fast-forwarded, never clobbered.
#
# Flags (also settable as environment variables):
#   --dir <path>          OPENSESSION_DIR      install location
#   --channel <ref>       OPENSESSION_CHANNEL  branch or tag to track
#   --repo <url>          OPENSESSION_REPO     source repository
#   --no-modify-path      NO_MODIFY_PATH=1     do not touch shell profiles
#   --no-onboard          NO_ONBOARD=1         install only, skip the wizard
#   --no-engine           NO_ENGINE=1          do not install the OpenCode engine
#   --no-tailscale        NO_TAILSCALE=1       do not install Tailscale
#   --yes                 NO_PROMPT=1          accept defaults, never prompt
#   --uninstall                                remove the install
#
# Tailscale is installed but not joined to a network — joining needs your
# account. Set TS_AUTHKEY to have the installer do that part too.
#
set -euo pipefail

OPENSESSION_HOME="${OPENSESSION_HOME:-$HOME/.opensession}"
DIR="${OPENSESSION_DIR:-$OPENSESSION_HOME/src}"
BIN_DIR="$OPENSESSION_HOME/bin"
REPO="${OPENSESSION_REPO:-https://github.com/tellahq/opensession.git}"
CHANNEL="${OPENSESSION_CHANNEL:-}"
NO_MODIFY_PATH="${NO_MODIFY_PATH:-0}"
NO_ONBOARD="${NO_ONBOARD:-0}"
NO_ENGINE="${NO_ENGINE:-0}"
NO_TAILSCALE="${NO_TAILSCALE:-0}"
NO_PROMPT="${NO_PROMPT:-0}"
DO_UNINSTALL=0
OS="$(uname -s)"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --no-modify-path) NO_MODIFY_PATH=1; shift ;;
    --no-onboard) NO_ONBOARD=1; shift ;;
    --no-engine) NO_ENGINE=1; shift ;;
    --no-tailscale) NO_TAILSCALE=1; shift ;;
    --yes|-y) NO_PROMPT=1; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    # Print the header comment, stopping at the first line that is not one, so
    # this does not need re-pointing every time the header grows.
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── output ──────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; D=""; G=""; Y=""; R=""; N=""
fi

step() { printf '%s\n' "${B}$1${N}"; }
# Strip credentials out of a URL before printing it. A tokenised clone URL in
# terminal scrollback or CI logs is a leaked credential.
redact() { printf '%s' "$1" | sed -E 's#(://)[^/@]*@#\1***@#'; }
info() { printf '  %s\n' "$1"; }
muted() { printf '  %s%s%s\n' "$D" "$1" "$N"; }
good() { printf '  %sok%s      %s\n' "$G" "$N" "$1"; }
warn() { printf '  %swarn%s    %s\n' "$Y" "$N" "$1"; }
die() { printf '  %serror%s   %s\n' "$R" "$N" "$1" >&2; exit 1; }

# ── uninstall ───────────────────────────────────────────────────────────────

if [ "$DO_UNINSTALL" = "1" ]; then
  step "Uninstalling OpenSession"
  if [ "$OS" = "Darwin" ]; then
    plist="$HOME/Library/LaunchAgents/dev.opensession.server.plist"
    if [ -f "$plist" ]; then
      launchctl bootout "gui/$(id -u)/dev.opensession.server" 2>/dev/null || true
      rm -f "$plist"
      good "LaunchAgent removed"
    fi
  elif [ -f /etc/systemd/system/opensession.service ]; then
    sudo systemctl disable --now opensession 2>/dev/null || true
    sudo rm -f /etc/systemd/system/opensession.service
    sudo systemctl daemon-reload 2>/dev/null || true
    good "service removed"
  fi
  rm -rf "$BIN_DIR"
  good "shim removed from $BIN_DIR"
  muted "left in place (delete by hand if you mean it):"
  muted "  $DIR            the checkout"
  muted "  $OPENSESSION_HOME/config.json   your configuration"
  muted "  $HOME/.opensession.env          your secrets"
  muted "  $HOME/.opensession-chats        your sessions"
  # Tailscale is a system daemon that may now be carrying your SSH access.
  # Removing it as a side effect of uninstalling OpenSession would be hostile.
  if command -v tailscale >/dev/null 2>&1; then
    muted "  tailscale                       still installed ('sudo tailscale down' to leave)"
  fi
  exit 0
fi

# ── prompting ───────────────────────────────────────────────────────────────
#
# Under `curl | bash` stdin is the script itself, so anything interactive must
# be re-attached to the terminal. Test stdin (-t 0), never stdout: redirecting
# output would otherwise silently turn an interactive install into a
# defaults-only one.

STDIN_PATH=""
if [ "$NO_PROMPT" = "1" ]; then
  STDIN_PATH=/dev/null
elif [ ! -t 0 ]; then
  if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    STDIN_PATH=/dev/tty
  else
    STDIN_PATH=/dev/null
  fi
fi

# Run a command with stdin pointed somewhere it can actually prompt from.
run_interactive() {
  if [ -n "$STDIN_PATH" ]; then "$@" <"$STDIN_PATH"; else "$@"; fi
}

# ── plan ────────────────────────────────────────────────────────────────────

printf '\n'
step "OpenSession"
muted "source      $(redact "$REPO")${CHANNEL:+ ($CHANNEL)}"
muted "install to  $DIR"
muted "command     $BIN_DIR/opensession"
printf '\n'

# ── prerequisites ───────────────────────────────────────────────────────────

step "Prerequisites"

# Install a missing system package. Minimal cloud images (the Ubuntu EC2 AMI
# among them) ship without unzip, which Bun's own installer requires — so
# without this the very first install on a fresh box fails.
install_package() {
  pkg="$1"
  # Homebrew installs as the invoking user — no sudo, and asking for it is
  # actively wrong on macOS.
  if [ "$OS" = "Darwin" ]; then
    command -v brew >/dev/null 2>&1 || return 1
    brew install --quiet "$pkg" >/dev/null 2>&1
    return $?
  fi
  if ! sudo -n true 2>/dev/null; then
    return 1
  fi
  if command -v apt-get >/dev/null 2>&1; then
    sudo -n apt-get update -qq >/dev/null 2>&1
    sudo -n apt-get install -y -qq "$pkg" >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    sudo -n dnf install -y -q "$pkg" >/dev/null 2>&1
  elif command -v apk >/dev/null 2>&1; then
    sudo -n apk add --quiet "$pkg" >/dev/null 2>&1
  else
    return 1
  fi
}

# cmd -> package name, when they differ
require_tool() {
  cmd="$1"; pkg="${2:-$1}"; why="$3"
  command -v "$cmd" >/dev/null 2>&1 && return 0
  muted "installing $pkg ($why) ..."
  if install_package "$pkg" && command -v "$cmd" >/dev/null 2>&1; then
    good "$pkg installed"
  else
    die "$cmd is required ($why). Install $pkg and re-run."
  fi
}

require_tool curl curl "downloading Bun"
require_tool git git "cloning the source"
good "git $(git --version | awk '{print $3}')"

# Bun's own installer shells out to unzip. On a box with neither unzip nor
# passwordless sudo (minimal containers, locked-down hosts, an EC2 image whose
# default user was overridden) that is a dead end — so fall back to Python's
# zipfile module, which is present on essentially every Linux image.
install_bun_via_python() {
  command -v python3 >/dev/null 2>&1 || return 1
  case "$OS" in
    Darwin) plat="darwin" ;;
    Linux)  plat="linux" ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) target="bun-${plat}-x64" ;;
    aarch64|arm64) target="bun-${plat}-aarch64" ;;
    *) return 1 ;;
  esac

  tmp="$(mktemp -d)"
  url="https://github.com/oven-sh/bun/releases/latest/download/${target}.zip"
  curl -fsSL "$url" -o "$tmp/bun.zip" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  python3 -m zipfile -e "$tmp/bun.zip" "$tmp" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
  mkdir -p "$HOME/.bun/bin"
  mv "$tmp/$target/bun" "$HOME/.bun/bin/bun" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  chmod +x "$HOME/.bun/bin/bun"
  rm -rf "$tmp"

  # Pre-AVX2 CPUs need the baseline build; the normal one dies with SIGILL.
  # Only x64 has a baseline variant.
  if ! "$HOME/.bun/bin/bun" --version >/dev/null 2>&1 && [ "${target%-x64}" != "$target" ]; then
    tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/${target}-baseline.zip" \
      -o "$tmp/bun.zip" 2>/dev/null || { rm -rf "$tmp"; return 1; }
    python3 -m zipfile -e "$tmp/bun.zip" "$tmp" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
    mv "$tmp/${target}-baseline/bun" "$HOME/.bun/bin/bun" 2>/dev/null || { rm -rf "$tmp"; return 1; }
    chmod +x "$HOME/.bun/bin/bun"
    rm -rf "$tmp"
  fi
  "$HOME/.bun/bin/bun" --version >/dev/null 2>&1
}

if ! command -v bun >/dev/null 2>&1; then
  muted "installing Bun ..."
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"

  if command -v unzip >/dev/null 2>&1 || install_package unzip; then
    bun_log="$(mktemp)"
    if ! curl -fsSL https://bun.sh/install | bash >"$bun_log" 2>&1; then
      # Never swallow this: a hidden installer error is undiagnosable.
      warn "Bun's installer failed:"
      sed 's/^/    /' "$bun_log" | tail -20
      rm -f "$bun_log"
      die "could not install Bun — see https://bun.sh"
    fi
    rm -f "$bun_log"
  elif install_bun_via_python; then
    muted "(unzip unavailable — extracted with python3)"
  else
    die "could not install Bun — install unzip and re-run, or see https://bun.sh"
  fi

  # Bun's installer appends to a shell profile this non-interactive shell has
  # not sourced, so put it on PATH for the rest of this run explicitly.
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "Bun installed but not on PATH — open a new shell and re-run"
fi
good "bun $(bun --version)"

# ── source ──────────────────────────────────────────────────────────────────

step "Source"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin
  target="${CHANNEL:-$(git -C "$DIR" rev-parse --abbrev-ref HEAD)}"
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    warn "local changes present — leaving the checkout alone"
  elif git -C "$DIR" merge --ff-only --quiet "origin/$target" 2>/dev/null; then
    good "updated to $(git -C "$DIR" rev-parse --short HEAD)"
  else
    warn "could not fast-forward — leaving the checkout alone"
  fi
else
  [ -e "$DIR" ] && die "$DIR exists but is not a git checkout — move it or pass --dir"
  mkdir -p "$(dirname "$DIR")"
  clone_log="$(mktemp)"
  clone_args="--quiet"
  [ -n "$CHANNEL" ] && clone_args="$clone_args --branch $CHANNEL"
  # shellcheck disable=SC2086
  if ! git clone $clone_args "$REPO" "$DIR" >"$clone_log" 2>&1; then
    warn "clone failed:"
    # git echoes the remote URL on failure, which may carry a token.
    redact "$(sed 's/^/    /' "$clone_log" | tail -10)"; printf '\n'
    rm -f "$clone_log"
    die "could not clone $(redact "$REPO")"
  fi
  rm -f "$clone_log"
  good "cloned to $DIR"
fi

# Cloning a private fork with a tokenised URL leaves that token in
# .git/config, which is a file people paste into bug reports and which
# `opensession update` would keep using forever. Move it into git's own
# credential store (0600) and point the remote at the clean URL.
if git -C "$DIR" remote get-url origin 2>/dev/null | grep -q '://[^/@]*@'; then
  full_url="$(git -C "$DIR" remote get-url origin)"
  clean_url="$(printf '%s' "$full_url" | sed -E 's#(://)[^/@]*@#\1#')"
  cred_file="$HOME/.git-credentials"
  touch "$cred_file"; chmod 600 "$cred_file"
  grep -qxF "$full_url" "$cred_file" 2>/dev/null || printf '%s\n' "$full_url" >>"$cred_file"
  git -C "$DIR" remote set-url origin "$clean_url"
  git -C "$DIR" config credential.helper store
  good "clone credentials moved to ~/.git-credentials (0600)"
fi

step "Dependencies"
(cd "$DIR" && bun install --silent) || die "bun install failed"
good "installed"

# ── engine ──────────────────────────────────────────────────────────────────
#
# OpenCode is the engine that actually runs agent turns. Without it the server
# starts, the UI loads, and every session fails — so install it by default
# rather than leaving a fresh box in that state.

step "Engine"
if command -v opencode >/dev/null 2>&1; then
  good "opencode $(opencode --version 2>/dev/null || echo present)"
elif [ "$NO_ENGINE" = "1" ]; then
  muted "skipped (--no-engine)"
else
  muted "installing OpenCode ..."
  engine_log="$(mktemp)"
  if curl -fsSL https://opencode.ai/install | bash >"$engine_log" 2>&1; then
    export PATH="$HOME/.opencode/bin:$PATH"
    good "opencode $(opencode --version 2>/dev/null || echo installed)"
  else
    warn "could not install OpenCode automatically:"
    sed 's/^/    /' "$engine_log" | tail -10
    muted "install it later: curl -fsSL https://opencode.ai/install | bash"
  fi
  rm -f "$engine_log"
fi

# ── network ─────────────────────────────────────────────────────────────────
#
# OpenSession has no authentication and trusts everyone who can reach the
# address it binds to, so a private network is not a nice-to-have — it is the
# access control. Installing Tailscale here means `opensession onboard` can
# offer the tailnet address as the bind default, instead of the usual outcome:
# 127.0.0.1, discovering later that nobody else can reach it, and reaching for
# HOST=0.0.0.0.
#
# Installing the client is not joining a network. `tailscale up` needs your
# account, and under `curl | bash` there is often no terminal to authenticate
# from — so joining happens only with an auth key, or later by hand.

step "Network"
tailnet_ip() { command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1; }

if [ "$NO_TAILSCALE" = "1" ]; then
  muted "skipped (--no-tailscale)"
elif [ -n "$(tailnet_ip)" ]; then
  good "tailscale $(tailnet_ip)"
else
  if ! command -v tailscale >/dev/null 2>&1; then
    if [ "$OS" = "Darwin" ]; then
      muted "install Tailscale from https://tailscale.com/download/mac"
    elif ! sudo -n true 2>/dev/null; then
      muted "skipped (needs sudo) — curl -fsSL https://tailscale.com/install.sh | sh"
    else
      muted "installing Tailscale ..."
      ts_log="$(mktemp)"
      # Redirect the whole pipeline, not the sudo: the log belongs to us, and
      # a redirect on `sudo` is applied by this shell anyway (shellcheck SC2024).
      if { curl -fsSL https://tailscale.com/install.sh | sudo -n sh; } >"$ts_log" 2>&1; then
        good "tailscale $(tailscale version 2>/dev/null | head -1 || echo installed)"
      else
        warn "could not install Tailscale automatically:"
        sed 's/^/    /' "$ts_log" | tail -10
        muted "install it later: curl -fsSL https://tailscale.com/install.sh | sh"
      fi
      rm -f "$ts_log"
    fi
  fi

  if command -v tailscale >/dev/null 2>&1 && [ -z "$(tailnet_ip)" ]; then
    if [ -n "${TS_AUTHKEY:-}" ]; then
      muted "joining the tailnet ..."
      if sudo -n tailscale up --authkey="$TS_AUTHKEY" >/dev/null 2>&1; then
        good "joined as $(tailnet_ip)"
      else
        warn "tailscale up failed — check TS_AUTHKEY has not expired"
      fi
    else
      muted "not joined to a network yet. To finish:"
      muted "  sudo tailscale up"
      muted "then re-run 'opensession onboard --force' to bind to the tailnet IP"
    fi
  fi
fi

# ── shim ────────────────────────────────────────────────────────────────────

# gh is only needed for pull-request operations and needs its own `gh auth
# login` regardless, so this is best-effort and never fatal.
if ! command -v gh >/dev/null 2>&1 && [ "$NO_ENGINE" != "1" ]; then
  if install_package gh >/dev/null 2>&1 && command -v gh >/dev/null 2>&1; then
    good "gh $(gh --version | head -1 | awk '{print $3}')"
  else
    muted "gh not installed (needed only for pull requests) — https://cli.github.com"
  fi
fi

step "Command"
mkdir -p "$BIN_DIR"
BUN_BIN="$(command -v bun)"
cat >"$BIN_DIR/opensession" <<EOF
#!/usr/bin/env bash
# Generated by the OpenSession installer. Safe to delete; re-run install.sh.
BUN="$BUN_BIN"
[ -x "\$BUN" ] || BUN="\$(command -v bun 2>/dev/null)" || {
  echo "opensession: bun not found — see https://bun.sh" >&2; exit 1; }

# Put the user-local bins on PATH before handing off. Without this, a shim
# invoked from a non-login shell (ssh, cron, systemd) runs with a PATH that
# lacks bun and opencode — and the server resolves the engine through
# Bun.which(), so it would silently find no engine at all.
export PATH="\$(dirname "\$BUN"):\$HOME/.opencode/bin:\$HOME/.local/bin:\$PATH"
exec "\$BUN" "$DIR/scripts/cli.ts" "\$@"
EOF
chmod +x "$BIN_DIR/opensession"
good "opensession -> $DIR/scripts/cli.ts"

# ── PATH ────────────────────────────────────────────────────────────────────

add_to_path() {
  config_file="$1"; line="$2"
  if grep -Fxq "$line" "$config_file" 2>/dev/null; then
    good "PATH already set in $config_file"
  elif [ -w "$config_file" ] || [ ! -e "$config_file" ]; then
    printf '\n# opensession\n%s\n' "$line" >>"$config_file"
    good "added to PATH in $config_file"
  else
    warn "add this to $config_file by hand:"
    muted "  $line"
  fi
}

# Write to more than one file on purpose.
#
# Ubuntu's stock ~/.bashrc begins with an "if not running interactively, return"
# guard, so a line appended to the END of it is invisible to non-interactive
# shells — which is what ssh commands, cron jobs and scripts use. Appending only
# there produces an install where `opensession` works when you type it and
# "command not found" the moment anything automated runs it.
#
# So: the interactive file AND the one login/non-interactive shells read.
if [ "$NO_MODIFY_PATH" != "1" ]; then
  case "$(basename "${SHELL:-bash}")" in
    fish)
      profiles="$HOME/.config/fish/config.fish"
      line="fish_add_path $BIN_DIR"
      mkdir -p "$HOME/.config/fish"
      ;;
    zsh)
      # .zshenv is read by every zsh invocation; .zshrc only by interactive ones.
      profiles="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv"
      line="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    *)
      profiles="$HOME/.bashrc $HOME/.profile"
      line="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
  for profile in $profiles; do
    add_to_path "$profile" "$line"
  done
fi
export PATH="$BIN_DIR:$PATH"

# GitHub Actions needs PATH additions written to a file rather than exported.
[ -n "${GITHUB_PATH:-}" ] && echo "$BIN_DIR" >>"$GITHUB_PATH"

# ── onboard ─────────────────────────────────────────────────────────────────

if [ "$NO_ONBOARD" = "1" ]; then
  printf '\n'
  step "Installed"
  info "Next: ${B}opensession onboard${N}"
  exit 0
fi

printf '\n'
if [ "$STDIN_PATH" = "/dev/null" ] && [ "$NO_PROMPT" != "1" ]; then
  warn "no terminal available — onboarding with defaults"
  muted "re-run 'opensession onboard --force' interactively to change them"
fi
run_interactive "$BIN_DIR/opensession" onboard || true

printf '\n'
step "Done"
info "opensession start     ${D}run the server${N}"
info "opensession doctor    ${D}check the install${N}"
info "opensession --help    ${D}everything else${N}"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) muted "open a new shell (or source your profile) to get 'opensession' on PATH" ;;
esac
printf '\n'
