#!/usr/bin/env bash
# Scans added lines of the staged diff (or of `git diff <range>`) for PII.
# Generic checks: public IPv4 addresses and email addresses. Private terms
# (hostnames, usernames, tailnet names) come from a denylist kept OUTSIDE the
# repo, one case-insensitive term per line: ${FLEET_PII_DENYLIST:-~/.config/fleet/pii-denylist}.
# Usage: pii-check.sh            # staged changes
#        pii-check.sh <range>    # e.g. origin/main..HEAD
set -euo pipefail
denylist="${FLEET_PII_DENYLIST:-$HOME/.config/fleet/pii-denylist}"
if [ $# -gt 0 ]; then diff=$(git diff "$1" -U0 --no-color); else diff=$(git diff --cached -U0 --no-color); fi
added=$(printf '%s\n' "$diff" | command grep -E '^\+' | command grep -vE '^\+\+\+ ' || true)
[ -z "$added" ] && exit 0
fail=0
report() { echo "pii-check: $1" >&2; printf '%s\n' "$2" | head -5 | sed 's/^/    /' >&2; fail=1; }

# IPv4 outside loopback, private, CGNAT (tailnet), link-local and documentation ranges.
ips=$(printf '%s\n' "$added" | command grep -oE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' | sort -u |
  command grep -vE '^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|255\.|224\.)' |
  awk -F. '$1<=255 && $2<=255 && $3<=255 && $4<=255' || true)
[ -n "$ips" ] && report "public IPv4 address" "$ips"

emails=$(printf '%s\n' "$added" | command grep -oiE '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' | sort -u |
  command grep -viE '@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com|t3\.codes|ping\.gg|localhost)$' |
  command grep -viE '^(noreply|git|me|you|user|test|foo|bar)@' || true)
[ -n "$emails" ] && report "email address" "$emails"

if [ -f "$denylist" ]; then
  while IFS= read -r term; do
    [ -z "$term" ] && continue
    case "$term" in \#*) continue ;; esac
    hits=$(printf '%s\n' "$added" | command grep -iF -- "$term" || true)
    [ -n "$hits" ] && report "denylisted term (from $denylist)" "$hits"
  done <"$denylist"
fi
exit $fail
