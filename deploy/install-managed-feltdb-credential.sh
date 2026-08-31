#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

env_path="${1:?managed FeltDB source environment is required}"
token_path="${2:-/etc/opensession/managed-feltdb-token}"
token_dir="$(dirname "$token_path")"
[ -r "$env_path" ] || { echo "managed FeltDB source environment is unreadable" >&2; exit 2; }
[ ! -L "$token_dir" ] || { echo "managed FeltDB credential directory cannot be a symlink" >&2; exit 2; }
install -d -o root -g root -m 0700 "$token_dir"
[ ! -L "$token_path" ] || { echo "managed FeltDB credential cannot be a symlink" >&2; exit 2; }
if [ -e "$token_path" ]; then
  [ -f "$token_path" ] && [ "$(stat -c %h "$token_path")" = "1" ] || {
    echo "unsafe managed FeltDB credential destination" >&2
    exit 2
  }
fi

value=""
for name in OPENSESSION_FELTDB_API_KEY FELTDB_MANAGED_API_KEY VITE_FELTDB_MANAGED_API_KEY FELTDB_TOKEN; do
  value="$(sed -n "s/^${name}=//p" "$env_path" | tail -n 1)"
  [ -z "$value" ] || break
done
case "$value" in
  \"*\") value="${value#\"}"; value="${value%\"}" ;;
  \'*\') value="${value#\'}"; value="${value%\'}" ;;
esac
[ -n "$value" ] || { echo "managed FeltDB API key is missing" >&2; exit 2; }

umask 077
tmp="$(mktemp "$token_dir/.managed-feltdb-token.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$value" > "$tmp"
install -o root -g root -m 0600 "$tmp" "$token_path"
