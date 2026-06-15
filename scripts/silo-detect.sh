#!/usr/bin/env bash
# silo-detect.sh — Phase 2.2 §9.1 detection cron wrapper.
#
# Daily 04:00 UTC (mirror of silo-curate.sh at 05:00 UTC). For each run:
#   1. Acquire a BASH-level flock at /var/lock/silo-detect.lock to prevent
#      two cron instances overlapping. This is SEPARATE from the
#      operation-log flock the Node CLI acquires (.locks/operation-log.lock
#      under SILO_DIR); the bash mutex prevents two writer processes from
#      even starting, the Node flock serializes appends once running.
#   2. Bookend the run with [FACT] system events emitted via `silo write`
#      so the projection's detector_status field reflects health.
#   3. Run `silo suggest --run-now` which emits TOPIC_SUGGESTED events for
#      validated clusters and writes any in-progress status events
#      (insufficient_events, sampled, first_run_deferred) inline.
#   4. Regenerate projections so PENDING-SUGGESTIONS.json + topic files
#      reflect the new state.
#
# Install (one-time, as root on VPS):
#   ln -sf /root/silo/scripts/silo-detect.sh /root/silo-detect.sh
#   chmod +x /root/silo/scripts/silo-detect.sh
#   ( crontab -l 2>/dev/null; echo '0 4 * * * /root/silo-detect.sh' ) | crontab -

set -uo pipefail

SILO_DIR="${SILO_DIR:-/root/.silo}"
CLAWD_V3="${SILO_BASE:-/root/clawd-v3}"
SILO_SRC="${SILO_SRC_DIR:-/root/silo}"
LOCK="${SILO_DETECT_LOCK:-/var/lock/silo-detect.lock}"
LOG="${SILO_DETECT_LOG:-/var/log/silo-detect.log}"
ENV_FILE="${SILO_DETECT_ENV:-/root/clawdbot-v3/.env}"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) another silo-detect in flight; skipping" >> "$LOG"
  exit 0
fi

# Load API keys (ANTHROPIC_API_KEY / OPENAI_API_KEY) the detector LLM needs.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Curate-liveness check — runs OUT-OF-BAND from silo-curate so a curate outage
# is detectable even when curate's own heartbeat is dead (detect kept running
# through the entire 10-day curate outage). A `trap … EXIT` (not a trailing
# line) so even an early `exit` still refreshes the cache. Registered after the
# flock so a flock-fail early-exit does NOT fire it — the instance already
# running writes the status. Non-fatal (`|| true`). See SPEC-curate-liveness
# §4/§5.3.
trap 'node "$SILO_SRC/src/cli/silo.js" curate-status --silo-dir="$SILO_DIR" >> "$LOG" 2>&1 || true' EXIT

# uuidgen may live in `uuid-runtime` (Debian/Ubuntu) — fall back to /proc if absent.
if command -v uuidgen >/dev/null 2>&1; then
  RUN_ID="$(uuidgen)"
else
  RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
fi

echo "=== $(date -u +%FT%TZ) silo-detect start (run_id=$RUN_ID) ===" >> "$LOG"

# Status: run started — operator-readable + projection's detector_status
# parses this content (see src/projection/regenerate-pending-suggestions.js).
node "$SILO_SRC/src/cli/silo.js" write \
  --silo-dir="$SILO_DIR" \
  --slug=system \
  --tag=FACT \
  --principal=topic-detector \
  --source=silo-topic-detector \
  --content="silo-detect run started (run_id=$RUN_ID, scope=general, days_back=30)" \
  >> "$LOG" 2>&1

# Main detection pass. --run-now respects first-run deferral; use --bulk-scan
# manually (and only once) to onboard a fresh deployment that already has
# enough `general` events to qualify for deferral.
DETECT_STATUS=0
node "$SILO_SRC/src/cli/silo.js" suggest --run-now \
  --silo-dir="$SILO_DIR" \
  --run-id="$RUN_ID" \
  --principal=topic-detector \
  --to="$CLAWD_V3" \
  --model=claude-sonnet-4-6 \
  >> "$LOG" 2>&1 || DETECT_STATUS=$?

if [ "$DETECT_STATUS" -eq 0 ]; then
  STATUS_CONTENT="silo-detect run complete (run_id=$RUN_ID)"
else
  STATUS_CONTENT="silo-detect run failed (run_id=$RUN_ID, exit=$DETECT_STATUS)"
fi

# Status: run complete (or failed).
node "$SILO_SRC/src/cli/silo.js" write \
  --silo-dir="$SILO_DIR" \
  --slug=system \
  --tag=FACT \
  --principal=topic-detector \
  --source=silo-topic-detector \
  --content="$STATUS_CONTENT" \
  >> "$LOG" 2>&1

# Make sure regeneration owns the projection tree even if --to= didn't fire
# (e.g. the run was deferred and no projection update happened inside the
# CLI). Idempotent.
node "$SILO_SRC/src/cli/silo.js" regenerate \
  --silo-dir="$SILO_DIR" \
  --to="$CLAWD_V3" \
  >> "$LOG" 2>&1

# OpenClaw container reads /root/clawd-v3/ as uid 1000. Preserve ownership.
chown -R 1000:1000 "$CLAWD_V3/" 2>/dev/null || true

echo "=== $(date -u +%FT%TZ) silo-detect end (run_id=$RUN_ID, status=$DETECT_STATUS) ===" >> "$LOG"
exit "$DETECT_STATUS"
