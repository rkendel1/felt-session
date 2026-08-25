#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

token_path="${1:-/etc/opensession/session-kernel-token}"
token_dir="$(dirname "$token_path")"
[ ! -L "$token_dir" ] || { echo "session kernel credential directory cannot be a symlink" >&2; exit 2; }
install -d -o root -g root -m 0700 "$token_dir"
[ ! -L "$token_path" ] || { echo "session kernel credential cannot be a symlink" >&2; exit 2; }
if [ -e "$token_path" ]; then
  [ -f "$token_path" ] && [ "$(stat -c %h "$token_path")" = "1" ] || {
    echo "unsafe session kernel credential destination" >&2
    exit 2
  }
fi
if [ ! -s "$token_path" ]; then
  umask 077
  tmp="$(mktemp "$token_dir/.session-kernel-token.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$tmp"
  install -o root -g root -m 0600 "$tmp" "$token_path"
fi
chown root:root "$token_path"
chmod 0600 "$token_path"
