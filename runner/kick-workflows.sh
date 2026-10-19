#!/usr/bin/env bash
# PolicyPilot showcase agents (operated by the team). Box-free backup trigger for workflows whose crons GitHub throttles.
# Measured: GitHub's scheduler fires this repo's crons only every few hours (hourly crons ran 3-5 h apart, and the new
# */30 agent-refill cron did not fire at all for hours). The showcase loop is always running, so it dispatches:
#   - agent-refill.yml when its newest run is older than 28 min
#   - daily-sweep.yml once per UTC day after 04:07 UTC (if no real daily-sweep run was created since 04:00 UTC)
#   - ops-watchdog.yml when its newest run is older than 55 min (the watchdog has its own crons too)
#   - momentum-data.yml when none is queued/running and its newest run is older than 30 min (each run loops ~28 min)
#   - momentum-keeper.yml when its newest run is older than 14 min (the job itself obeys MOMENTUM_KEEPER_ENABLED;
#     dispatched runs never set test_force_entry, so they behave exactly like scheduled runs)
# Called from runner/showcase-commit.sh after every round. Needs `actions: write` on GITHUB_TOKEN. Never fails the caller.
set -uo pipefail
[ -n "${GITHUB_REPOSITORY:-}" ] && command -v gh >/dev/null 2>&1 || exit 0
R=$GITHUB_REPOSITORY; now=$(date -u +%s)
age() { # seconds since the newest run of workflow $1 was created; 0 on API error so nothing is dispatched blindly
  local t; t=$(gh run list -R "$R" -w "$1" -L 1 --json createdAt -q '.[0].createdAt // "1970-01-01T00:00:00Z"' 2>/dev/null) || t=""
  [ -n "$t" ] || { echo 0; return; }
  echo $(( now - $(date -u -d "$t" +%s) ))
}
active() { gh run list -R "$R" -w "$1" -L 5 --json status -q '[.[]|select(.status!="completed")]|length' 2>/dev/null || echo 1; }

if [ "$(age agent-refill.yml)" -gt 1680 ]; then
  gh workflow run agent-refill.yml -R "$R" -f kick=true -f dry_run=false >/dev/null 2>&1 && echo "kick: agent-refill dispatched"
fi
if [ "$(date -u +%H%M)" -ge 407 ] 2>/dev/null; then
  since=$(date -u +%Y-%m-%dT04:00:00Z)
  n=$(gh run list -R "$R" -w daily-sweep.yml -L 20 --json createdAt,displayTitle 2>/dev/null | jq --arg s "$since" '[.[]|select(.displayTitle=="daily-sweep" and .createdAt>=$s)]|length' 2>/dev/null) || n=1
  [ "${n:-1}" = 0 ] && gh workflow run daily-sweep.yml -R "$R" -f kick=true -f dry_run=false >/dev/null 2>&1 && echo "kick: daily-sweep dispatched"
fi
if [ "$(age ops-watchdog.yml)" -gt 3300 ]; then
  gh workflow run ops-watchdog.yml -R "$R" -f kick=true >/dev/null 2>&1 && echo "kick: ops-watchdog dispatched"
fi
if [ "$(active momentum-data.yml)" = 0 ] && [ "$(age momentum-data.yml)" -gt 1800 ]; then
  gh workflow run momentum-data.yml -R "$R" >/dev/null 2>&1 && echo "kick: momentum-data dispatched"
fi
if [ "$(age momentum-keeper.yml)" -gt 840 ]; then
  gh workflow run momentum-keeper.yml -R "$R" >/dev/null 2>&1 && echo "kick: momentum-keeper dispatched"
fi
exit 0
