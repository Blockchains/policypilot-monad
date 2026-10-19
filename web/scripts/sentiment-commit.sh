#!/usr/bin/env bash
# Commits a new sentiment snapshot to main from a dedicated worktree (never touches other checkouts). gitleaks runs first; aborts on any finding.
# Usage: sentiment-commit.sh plan      -> refreshes the worktree and prints the 9 X tool calls for this hour
#        sentiment-commit.sh <rawDir>  -> builds the snapshot from <rawDir>/<key>.txt and pushes it to main
set -euo pipefail
RAW="${1:?usage: plan | <rawDir>}"; REPO="${PP_REPO:-/workspace/pp-momentum/repo}"; WT="${PP_SENT_WT:-/workspace/pp-momentum/sentiment-wt}"
{ # setup output goes to stderr so `plan` prints clean JSON on stdout
  [ -d "$WT/.git" ] || [ -f "$WT/.git" ] || git -C "$REPO" worktree add -q --detach "$WT" origin/main
  cd "$WT"; git fetch -q origin main; git checkout -q --detach origin/main; git reset -q --hard origin/main
} 1>&2
cd "$WT"
git config user.name "Blockchain Lab"; git config user.email ismail.malik@gmail.com
NODE="npx -y node@22 --experimental-strip-types --no-warnings"
[ "$RAW" = plan ] && exec $NODE web/scripts/sentiment-plan.mts
SENT_OUT="$WT/web/public/momentum/sentiment-143" $NODE web/scripts/sentiment-snapshot.mts "$RAW"
git add web/public/momentum/sentiment-143
git diff --cached --quiet && { echo "no change"; exit 0; }
git commit -q -m "sentiment: X snapshot $(date -u +%Y-%m-%dT%H:%MZ) [skip ci]"
gitleaks git --no-banner --redact --log-opts="origin/main..HEAD" >/dev/null || { echo "gitleaks finding: not pushing"; git reset -q --hard origin/main; exit 1; }
for i in 1 2 3; do git push -q origin HEAD:main && { echo "pushed $(git rev-parse --short HEAD)"; exit 0; }; git fetch -q origin main; git rebase -q origin/main; done
echo "push failed"; exit 1
