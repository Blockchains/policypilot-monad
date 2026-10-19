#!/usr/bin/env bash
# Commit the Momentum public data. [skip ci] keeps it off the test and Pages workflows; the site reads raw files.
set -uo pipefail
cd "$(dirname "$0")/../.."
DIR=web/public/momentum/143
BRANCH=${BRANCH:-${GITHUB_REF_NAME:-main}}
MSG="momentum: sample ${GITHUB_RUN_NUMBER:-local} [skip ci]"
git config user.name "policypilot-momentum-bot"
git config user.email "momentum-bot@users.noreply.github.com"
git add -- "$DIR"
git diff --cached --quiet && { echo "nothing to commit"; exit 0; }
git commit -q -m "$MSG" || exit 1
for try in 1 2 3 4 5; do
  git fetch -q origin "$BRANCH" || { sleep $((try * 4)); continue; }
  # Only this job writes $DIR, so on a conflict our copy wins.
  if git rebase -q -X theirs "origin/$BRANCH"; then
    git push -q origin "HEAD:$BRANCH" && { echo "pushed: $MSG"; exit 0; }
  else
    git rebase --abort 2>/dev/null || true
    SNAP=$(mktemp -d); cp -r "$DIR" "$SNAP/"
    git reset -q --hard "origin/$BRANCH"
    rm -rf "$DIR"; mkdir -p "$(dirname "$DIR")"; cp -r "$SNAP/143" "$DIR"
    git add -- "$DIR"; git diff --cached --quiet || git commit -q -m "$MSG"
    git push -q origin "HEAD:$BRANCH" && { echo "pushed (reapplied): $MSG"; exit 0; }
  fi
  sleep $((try * 4))
done
echo "push failed after retries"; exit 1
