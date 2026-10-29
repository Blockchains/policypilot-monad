#!/bin/bash
# Supervisor for the real-time exit keeper on an always-on host (no systemd needed).
# Restarts it on exit (1 s, backing off to 30 s on crash loops) and kills it when its heartbeat (status.json, every 2 s) is older than 20 s.
# Secrets come only from env files on the host (never from the repo, never printed):
#   ~/.policypilot/momentum-keeper.env  MOMENTUM_KEEPER_KEY   (keeper key only — never the deployer key)
#   ~/.policypilot/quicknode.env        QN_HTTP, QN_WSS       (mode 600)
# Usage: setsid nohup web/scripts/momentum-rt-supervisor.sh >/dev/null 2>&1 &     Stop: touch ~/.policypilot/rt-keeper/STOP
unset RPC RPC_WSS DRY_RUN FORCE_TRIGGER_VAULT STATE_URL RT_MAX_SECONDS # a stray fork/test variable must never redirect the service
set -u; cd "$(dirname "$0")/.."
DIR=${RT_DIR:-$HOME/.policypilot/rt-keeper}; mkdir -p "$DIR"; LOG="$DIR/keeper.log"; rm -f "$DIR/STOP"
echo $$ > "$DIR/supervisor.pid"
set -a; . "$HOME/.policypilot/momentum-keeper.env"; . "$HOME/.policypilot/quicknode.env"; set +a
export RT_DIR="$DIR" RT_LIVE=${RT_LIVE:-1}
NODE=${NODE:-$(npx -y node@22 -e "process.stdout.write(process.execPath)")}; back=1 # run node itself (not the npx wrapper) so the watchdog kill reaches the keeper
while [ ! -f "$DIR/STOP" ]; do
  start=$(date +%s)
  setsid "$NODE" --experimental-strip-types --no-warnings ${KEEPER_SCRIPT:-scripts/momentum-rt-keeper.mts} >>"$LOG" 2>&1 & kid=$!
  echo "$(date -u +%FT%TZ) supervisor: keeper pid $kid" >>"$LOG"; sleep 30
  while kill -0 $kid 2>/dev/null; do # watchdog
    sleep 5; age=$(( $(date +%s) - $(stat -c %Y "$DIR/status.json" 2>/dev/null || echo 0) ))
    if [ $age -gt 20 ] || [ -f "$DIR/STOP" ]; then echo "$(date -u +%FT%TZ) supervisor: heartbeat ${age}s old or STOP, restarting" >>"$LOG"; kill -- -$kid 2>/dev/null || kill $kid; sleep 2; kill -9 -- -$kid 2>/dev/null; kill -9 $kid 2>/dev/null; fi
  done
  wait $kid 2>/dev/null
  if [ $(( $(date +%s) - start )) -lt 120 ]; then back=$(( back * 2 > 30 ? 30 : back * 2 )); else back=1; fi
  tail -c 5000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  sleep $back
done
