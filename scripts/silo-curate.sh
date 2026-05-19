#!/usr/bin/env bash
# Silo-native Layer 2 curation — runs nightly at 05:00 UTC.
# For each curated topic with ≥3 new events in the last 14 days, asks the
# configured LLM (claude-sonnet-4-6 by default) whether new durable bullets
# should be added to Layer 2 — and/or whether existing bullets should be
# retired. Writes via the silo CLI so the operation log stays the single
# source of truth, then regenerates Zone B projections.
#
# Layout — symmetric with silo-detect.sh (Phase 2.2 §9.1):
#   /root/silo-curate.sh           → symlink to /root/silo/scripts/silo-curate.sh
#   /var/lock/silo-curate.lock     bash-level mutex (one cron at a time)
#   /var/log/silo-curate.log       append-only output

set -uo pipefail

SILO_DIR=/root/.silo
CLAWD_V3=/root/clawd-v3
LOCK=/var/lock/silo-curate.lock
LOG=/var/log/silo-curate.log

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) another silo-curate in flight; skipping" >> "$LOG"
  exit 0
fi

set -a
source /root/clawdbot-v3/.env
set +a

echo "=== $(date -u +%FT%TZ) silo-curate start ===" >> "$LOG"

node /root/silo/src/cli/silo.js curate \
  --silo-dir="$SILO_DIR" \
  --days-back=14 \
  --min-events=3 \
  --principal=curator \
  --model=claude-sonnet-4-6 \
  >> "$LOG" 2>&1

# Regen so any new CURATED bullets land in topic files immediately
node /root/silo/src/cli/silo.js regenerate \
  --silo-dir="$SILO_DIR" \
  --to="$CLAWD_V3" >> "$LOG" 2>&1

chown -R 1000:1000 "$CLAWD_V3/topics/" 2>/dev/null || true

echo "=== $(date -u +%FT%TZ) silo-curate end ===" >> "$LOG"
