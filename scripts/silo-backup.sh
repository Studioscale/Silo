#!/usr/bin/env bash
# Silo data-dir backup — runs nightly at 03:30 UTC (before silo-detect 04:00
# and silo-curate 05:00, so each night's snapshot captures the log as the
# day's crons left it).
#
# Snapshots the WHOLE silo data dir (operation log + caches) to a dated
# tar.gz, integrity-tests the archive, then rotates by COUNT (keep newest N).
# Count-based rotation is deliberate: age-based `-mtime` deletion would erode
# to zero archives if this cron silently stalled — the exact failure mode
# silo-curate exhibited 2026-05-19..28. With count-based rotation a stalled
# backup cron freezes the archive set instead of draining it.
#
# Hot-copy safety: the operation log is append-only JSONL with replay-safe
# prefix recovery (src/log/append.js — tolerant tail scan drops any torn
# trailing line). A snapshot taken mid-write is therefore still a valid,
# restorable log prefix. No quiescing or lock coordination needed.
#
# Offsite replication (optional): if SILO_OFFSITE_DEST is set, every verified
# local archive is rsync'd to an offsite target right after it is written, so a
# total loss of THIS host does not lose the operation log — the one
# irreplaceable artifact (projections regenerate from it; it regenerates from
# nothing). Pushing from inside this run (not a separate cron) guarantees the
# freshest snapshot ships, and reuses the verify-before-keep discipline below.
# Disabled when SILO_OFFSITE_DEST is empty, so the open-source default is
# unchanged and the VPS supplies creds via env (like SILO_CURATE_ENV).
#
# Layout — symmetric with silo-curate.sh / silo-detect.sh:
#   /root/silo-backup.sh          → symlink to /root/silo/scripts/silo-backup.sh
#   /var/lock/silo-backup.lock    bash-level mutex (one run at a time)
#   /var/log/silo-backup.log      append-only output
#   /root/backups/silo/           archive destination (override: SILO_BACKUP_DIR)
#
# Offsite env (all optional; offsite is skipped unless SILO_OFFSITE_DEST set):
#   SILO_OFFSITE_DEST          rsync dest, e.g. user@host:silo-log-backup/
#   SILO_OFFSITE_SSH_KEY       identity file for the offsite ssh (optional)
#   SILO_OFFSITE_SSH_PORT      offsite ssh port (default 22; Hetzner box = 23)
#   SILO_OFFSITE_SSH_OPTS      extra ssh opts (default: batch, accept-new host key)
#   SILO_OFFSITE_RSYNC_DELETE  1 = mirror with --delete (bounded, mirrors local
#                              rotation); default 0 = accumulate offsite, never
#                              let a local failure propagate a delete offsite
#                              (offsite is the last line of defense; archives
#                              are ~100s of KB, so years of dailies stay cheap).
#
# Status events bookend each run under the `system` slug with
# source=silo-backup (same pattern cmdDoctor parses for curate/detect health).
# A failed offsite push emits its OWN status event so a silent multi-night
# offsite stall is visible to `silo doctor`, without failing the local run.
#
# Restore procedure:
#   tar -xzf /root/backups/silo/silo-backup-<stamp>.tar.gz -C /root
#   (extracts to /root/.silo; run `silo doctor` + `silo regenerate` after)
#   Offsite restore: pull silo-backup-<stamp>.tar.gz back from SILO_OFFSITE_DEST
#   first, then the same tar -xzf.

set -uo pipefail

SILO_DIR="${SILO_DIR:-/root/.silo}"
SILO_SRC="${SILO_SRC_DIR:-/root/silo}"
BACKUP_DIR="${SILO_BACKUP_DIR:-/root/backups/silo}"
KEEP_COUNT="${SILO_BACKUP_KEEP_COUNT:-14}"
LOCK="${SILO_BACKUP_LOCK:-/var/lock/silo-backup.lock}"
LOG="${SILO_BACKUP_LOG:-/var/log/silo-backup.log}"
MIN_ARCHIVE_BYTES=1024

# Offsite replication (optional; skipped entirely unless OFFSITE_DEST is set).
OFFSITE_DEST="${SILO_OFFSITE_DEST:-}"
OFFSITE_SSH_KEY="${SILO_OFFSITE_SSH_KEY:-}"
OFFSITE_SSH_PORT="${SILO_OFFSITE_SSH_PORT:-22}"
OFFSITE_SSH_OPTS="${SILO_OFFSITE_SSH_OPTS:--o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=30}"
OFFSITE_RSYNC_DELETE="${SILO_OFFSITE_RSYNC_DELETE:-0}"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) another silo-backup in flight; skipping" >> "$LOG"
  exit 0
fi

if command -v uuidgen >/dev/null 2>&1; then
  RUN_ID="$(uuidgen)"
else
  RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/silo-backup-$STAMP.tar.gz"

echo "=== $(date -u +%FT%TZ) silo-backup start (run_id=$RUN_ID) ===" >> "$LOG"

write_status() {
  node "$SILO_SRC/src/cli/silo.js" write \
    --silo-dir="$SILO_DIR" \
    --slug=system \
    --tag=FACT \
    --principal=backup \
    --source=silo-backup \
    --content="$1" \
    >> "$LOG" 2>&1
}

fail() {
  local stage="$1"
  echo "$(date -u +%FT%TZ) silo-backup FAILED at $stage" >> "$LOG"
  write_status "silo-backup run failed (run_id=$RUN_ID, stage=$stage)"
  echo "=== $(date -u +%FT%TZ) silo-backup end (run_id=$RUN_ID, status=1) ===" >> "$LOG"
  exit 1
}

write_status "silo-backup run started (run_id=$RUN_ID, keep_count=$KEEP_COUNT)"

mkdir -p "$BACKUP_DIR" || fail "mkdir"

# Snapshot. -C to the parent so the archive contains the dir by basename
# (restores cleanly to any prefix).
tar -czf "$ARCHIVE" -C "$(dirname "$SILO_DIR")" "$(basename "$SILO_DIR")" \
  >> "$LOG" 2>&1 || { rm -f "$ARCHIVE"; fail "tar-create"; }

# Integrity: archive must list cleanly and clear the size floor.
tar -tzf "$ARCHIVE" > /dev/null 2>> "$LOG" || { rm -f "$ARCHIVE"; fail "tar-verify"; }
SIZE_BYTES="$(stat -c%s "$ARCHIVE" 2>/dev/null || echo 0)"
if [ "$SIZE_BYTES" -lt "$MIN_ARCHIVE_BYTES" ]; then
  rm -f "$ARCHIVE"
  fail "size-floor ($SIZE_BYTES bytes < $MIN_ARCHIVE_BYTES)"
fi

# Rotate ONLY after a verified-good new archive: keep the newest KEEP_COUNT.
PRUNED=0
while IFS= read -r old; do
  rm -f "$old" && PRUNED=$((PRUNED + 1))
done < <(ls -1t "$BACKUP_DIR"/silo-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP_COUNT + 1)))

RETAINED="$(ls -1 "$BACKUP_DIR"/silo-backup-*.tar.gz 2>/dev/null | wc -l)"
SIZE_KB=$(( (SIZE_BYTES + 1023) / 1024 ))

# --- Offsite replication: last line of defense against total host loss. ---
# Non-fatal by design. The verified local archive above is already the primary
# guarantee; a network/credential failure here must NOT fail the run or discard
# the good local snapshot. But a SILENT offsite stall would quietly reopen the
# very gap this stage closes, so a failure emits its OWN loud status event that
# `silo doctor` health-parse will surface, distinct from a green run.
OFFSITE_STATUS="disabled"
if [ -n "$OFFSITE_DEST" ]; then
  SSH_CMD="ssh -p $OFFSITE_SSH_PORT $OFFSITE_SSH_OPTS"
  [ -n "$OFFSITE_SSH_KEY" ] && SSH_CMD="$SSH_CMD -i $OFFSITE_SSH_KEY"
  RSYNC_OPTS=(-az -e "$SSH_CMD")
  # Default: accumulate offsite (no --delete) so a local catastrophe can never
  # propagate a delete to the offsite copy. Opt into a bounded mirror with
  # SILO_OFFSITE_RSYNC_DELETE=1.
  [ "$OFFSITE_RSYNC_DELETE" = "1" ] && RSYNC_OPTS+=(--delete)
  echo "$(date -u +%FT%TZ) silo-backup offsite push -> $OFFSITE_DEST (delete=$OFFSITE_RSYNC_DELETE)" >> "$LOG"
  if rsync "${RSYNC_OPTS[@]}" "$BACKUP_DIR"/ "$OFFSITE_DEST" >> "$LOG" 2>&1; then
    OFFSITE_STATUS="ok"
    write_status "silo-backup offsite push OK (run_id=$RUN_ID, dest=$OFFSITE_DEST, archive=silo-backup-$STAMP.tar.gz)"
  else
    OFFSITE_STATUS="FAILED"
    echo "$(date -u +%FT%TZ) silo-backup OFFSITE push FAILED (run_id=$RUN_ID)" >> "$LOG"
    write_status "silo-backup OFFSITE push FAILED (run_id=$RUN_ID, dest=$OFFSITE_DEST) — local archive is SAFE; offsite copy is STALE, investigate before relying on it"
  fi
fi

write_status "silo-backup run complete (run_id=$RUN_ID, archive=silo-backup-$STAMP.tar.gz, size_kb=$SIZE_KB, retained=$RETAINED, pruned=$PRUNED, offsite=$OFFSITE_STATUS)"

echo "=== $(date -u +%FT%TZ) silo-backup end (run_id=$RUN_ID, status=0, archive=$ARCHIVE, size_kb=$SIZE_KB, retained=$RETAINED, offsite=$OFFSITE_STATUS) ===" >> "$LOG"
exit 0
