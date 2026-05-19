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
#
# Status events bookend each run under the `system` slug with
# source=silo-curate. cmdDoctor parses these to surface "Curate status"
# health (last run, last success, consecutive failures) — same approach
# silo-detect.sh uses to populate detector_status.

set -uo pipefail

SILO_DIR="${SILO_DIR:-/root/.silo}"
CLAWD_V3="${SILO_BASE:-/root/clawd-v3}"
SILO_SRC="${SILO_SRC_DIR:-/root/silo}"
LOCK="${SILO_CURATE_LOCK:-/var/lock/silo-curate.lock}"
LOG="${SILO_CURATE_LOG:-/var/log/silo-curate.log}"
ENV_FILE="${SILO_CURATE_ENV:-/root/clawdbot-v3/.env}"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) another silo-curate in flight; skipping" >> "$LOG"
  exit 0
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if command -v uuidgen >/dev/null 2>&1; then
  RUN_ID="$(uuidgen)"
else
  RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
fi

echo "=== $(date -u +%FT%TZ) silo-curate start (run_id=$RUN_ID) ===" >> "$LOG"

# Status: run started — operator-readable + cmdDoctor parses this content
# (matches the silo-detect.sh pattern from Phase 2.2 §9.1).
node "$SILO_SRC/src/cli/silo.js" write \
  --silo-dir="$SILO_DIR" \
  --slug=system \
  --tag=FACT \
  --principal=curator \
  --source=silo-curate \
  --content="silo-curate run started (run_id=$RUN_ID, days_back=14, min_events=3)" \
  >> "$LOG" 2>&1

# Main curate pass.
CURATE_STATUS=0
node "$SILO_SRC/src/cli/silo.js" curate \
  --silo-dir="$SILO_DIR" \
  --days-back=14 \
  --min-events=3 \
  --principal=curator \
  --model=claude-sonnet-4-6 \
  >> "$LOG" 2>&1 || CURATE_STATUS=$?

# Regenerate so any new CURATED bullets land in topic files immediately.
# Run regardless of curate status — if some slugs curated successfully before
# a later failure, the regen still publishes them.
node "$SILO_SRC/src/cli/silo.js" regenerate \
  --silo-dir="$SILO_DIR" \
  --to="$CLAWD_V3" >> "$LOG" 2>&1

if [ "$CURATE_STATUS" -eq 0 ]; then
  STATUS_CONTENT="silo-curate run complete (run_id=$RUN_ID)"
else
  STATUS_CONTENT="silo-curate run failed (run_id=$RUN_ID, exit=$CURATE_STATUS)"
fi

# Status: run complete (or failed).
node "$SILO_SRC/src/cli/silo.js" write \
  --silo-dir="$SILO_DIR" \
  --slug=system \
  --tag=FACT \
  --principal=curator \
  --source=silo-curate \
  --content="$STATUS_CONTENT" \
  >> "$LOG" 2>&1

# OpenClaw container reads /root/clawd-v3/ as uid 1000.
chown -R 1000:1000 "$CLAWD_V3/topics/" 2>/dev/null || true

echo "=== $(date -u +%FT%TZ) silo-curate end (run_id=$RUN_ID, status=$CURATE_STATUS) ===" >> "$LOG"
exit "$CURATE_STATUS"
