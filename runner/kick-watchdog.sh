#!/usr/bin/env bash
# Mutual watch: other self-chaining jobs call this so the meta-watchdog's own chain can never die silently.
# Dispatches ops-watchdog.yml when nothing is queued/running and its newest run is older than 40 min. Never fails.
set -uo pipefail
[ -n "${GITHUB_REPOSITORY:-}" ] && command -v gh >/dev/null 2>&1 || exit 0
R=$GITHUB_REPOSITORY; now=$(date -u +%s)
J=$(gh run list -R "$R" -w ops-watchdog.yml -L 5 --json status,createdAt 2>/dev/null) || exit 0
act=$(jq '[.[]|select(.status!="completed")]|length' <<<"$J"); t=$(jq -r '.[0].createdAt // "1970-01-01T00:00:00Z"' <<<"$J")
if [ "$act" = 0 ] && [ $(( now - $(date -u -d "$t" +%s) )) -gt 2400 ]; then
  gh workflow run ops-watchdog.yml -R "$R" --ref main -f kick=true >/dev/null 2>&1 && echo "kick: ops-watchdog dispatched (newest run $t)"
fi
exit 0
