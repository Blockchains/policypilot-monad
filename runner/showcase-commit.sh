#!/usr/bin/env bash
# Commit the ledger + public snapshot with [skip ci] and push, rebasing safely on top of the remote branch.
#   - ledger (append-only JSONL): union-merged on conflict (.gitattributes merge=union), so no round is ever lost
#   - JSON snapshot: on conflict the freshly generated file wins (-X theirs during a rebase = our replayed commit)
#   - if the rebase still fails: reset to origin, re-append the local ledger lines, rebuild the snapshot, commit again
set -uo pipefail
cd "$(dirname "$0")/.."
# box-free trigger for agent-refill / daily-sweep (GitHub cron is throttled on this repo); never blocks the commit
[ -f runner/kick-workflows.sh ] && timeout 60 bash runner/kick-workflows.sh || true
# keep the Activity tab's history index running (activity-index.yml); never blocks the commit
[ -f runner/kick-activity.sh ] && timeout 30 bash runner/kick-activity.sh || true
LEDGER=${LEDGER:-runner/ledger/showcase-143.jsonl}; PUBLIC_OUT=${PUBLIC_OUT:-web/public/showcase-agents-143.json}
BRANCH=${BRANCH:-${GITHUB_REF_NAME:-main}}; N=${1:-0}; MSG="showcase: agent round ${GITHUB_RUN_NUMBER:-local}.${N} [skip ci]"
git config user.name "policypilot-showcase-bot"; git config user.email "showcase-bot@users.noreply.github.com"
git add -- "$LEDGER" "$PUBLIC_OUT"
git diff --cached --quiet && { echo "nothing to commit"; exit 0; }
git commit -q -m "$MSG" || exit 1
for try in 1 2 3 4 5; do
  git fetch -q origin "$BRANCH" || { sleep $((try * 4)); continue; }
  git show HEAD:"$LEDGER" > /tmp/showcase-ledger.local.jsonl 2>/dev/null || : > /tmp/showcase-ledger.local.jsonl
  if git rebase -q -X theirs "origin/$BRANCH"; then
    git push -q origin "HEAD:$BRANCH" && { echo "pushed: $MSG"; exit 0; }
  else
    echo "rebase conflict: regenerating on top of origin/$BRANCH"
    git rebase --abort 2>/dev/null || true
    git reset -q --hard "origin/$BRANCH"
    mkdir -p "$(dirname "$LEDGER")"; touch "$LEDGER"
    awk 'NR==FNR { seen[$0]; next } !($0 in seen)' "$LEDGER" /tmp/showcase-ledger.local.jsonl >> "$LEDGER"
    AGENTS_ONLY=1 node runner/showcase-agents.mjs publish || echo "snapshot rebuild failed; committing the merged ledger only"
    git add -- "$LEDGER" "$PUBLIC_OUT"; git diff --cached --quiet || git commit -q -m "$MSG"
    git push -q origin "HEAD:$BRANCH" && { echo "pushed (regenerated): $MSG"; exit 0; }
  fi
  sleep $((try * 4))
done
echo "push failed after retries"; exit 1
