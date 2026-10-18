#!/usr/bin/env bash
# Called by runner/showcase-commit.sh after every showcase round: make sure the activity indexer is running
# (GitHub's cron is throttled on this repo). Dispatches activity-index.yml when no run is queued or in progress. Never fails.
set -uo pipefail
[ -n "${GITHUB_REPOSITORY:-}" ] && command -v gh >/dev/null 2>&1 || exit 0
R=$GITHUB_REPOSITORY
n=$(gh run list -R "$R" -w activity-index.yml -L 5 --json status -q '[.[]|select(.status=="in_progress" or .status=="queued" or .status=="pending")]|length' 2>/dev/null) || exit 0
[ "${n:-1}" = 0 ] && gh workflow run activity-index.yml -R "$R" >/dev/null 2>&1 && echo "kick: activity-index dispatched"
exit 0
