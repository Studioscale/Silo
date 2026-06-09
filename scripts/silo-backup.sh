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
# Layout — symmetric with silo-curate.sh / silo-detect.sh:
#   /root/silo-backup.sh          → symlink to /root/silo/scripts/silo-backup.sh
#   /var/lock/silo-backup.lock    bash-level mutex (one run at a time)
#   /var/log/silo-backup.log      append-only output
#   /root/backups/silo/           archive destination (override: SILO_BACKUP_DIR)
#
# Status events bookend each run under the `system` slug with
# source=silo-backup (same pattern cmdDoctor parses for curate/detect health).
#
# Restore procedure:
#   tar -xzf /root/backups/silo/silo-backup-<stamp>.tar.gz -C /root
#   (extracts to /root/.silo; run `silo doctor` + `silo regenerate` after)

set -uo pipefail

SILO_DIR="${SILO_DIR:-/root/.silo}"
SILO_SRC="${SILO_SRC_DIR:-/root/silo}"
BACKUP_DIR="${SILO_BACKUP_DIR:-/root/backups/silo}"
KEEP_COUNT="${SILO_BACKUP_KEEP_COUNT:-14}"
LOCK="${SILO_BACKUP_LOCK:-/var/lock/silo-backup.lock}"
LOG="${SILO_BACKUP_LOG:-/var/log/silo-backup.log}"
MIN_ARCHIVE_BYTES=1024

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

write_status "silo-backup run complete (run_id=$RUN_ID, archive=silo-backup-$STAMP.tar.gz, size_kb=$SIZE_KB, retained=$RETAINED, pruned=$PRUNED)"

echo "=== $(date -u +%FT%TZ) silo-backup end (run_id=$RUN_ID, status=0, archive=$ARCHIVE, size_kb=$SIZE_KB, retained=$RETAINED) ===" >> "$LOG"
exit 0
