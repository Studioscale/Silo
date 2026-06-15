/**
 * Curate-liveness core — SPEC-curate-liveness §5.
 *
 * The passive "check-engine light" for the nightly curation job. Pre-computes a
 * staleness verdict into `<silo-dir>/curate-status.json` on a cron cadence; the
 * MCP read path (`silo-mcp/notices.js`) reads that cache and raises a rare,
 * hysteresis-guarded `_silo_notices` warning when curate hasn't *succeeded* in
 * ~3 days. Mirrors `src/util/update-check.js` (the cache-file + passive-notice
 * pattern) — that file is the analogue for every piece here.
 *
 * Pieces:
 *   - deriveCuratorStatus: parse `silo-curate` heartbeat events into raw facts.
 *     Moved here from cmdDoctor's module so cmdCurateStatus + the unit tests can
 *     reuse it (cmdDoctor still renders from it live). Returns null when there
 *     are no curate events. R2-Live-3: now also reports `last_event_kind` (the
 *     MOST RECENT event's kind) so in-progress is detected by event ORDER, not
 *     by the preserved `last_failure_msg`.
 *   - foldLiveness: pure verdict fn — hysteresis (STALE_DAYS/CLEAR_DAYS),
 *     first-run grace anchor (`first_observed_at`), in-progress branch. Returns
 *     the whole persisted object minus `schema_version` (writeCurateStatus
 *     stamps that). Carries NO `last_emitted_at` — the emit cooldown lives in a
 *     separate `curate-emit.json` written only by the read path (§5.5; the
 *     dual-writer-race fix).
 *   - readCurateStatus / writeCurateStatus: cache I/O at
 *     `<silo-dir>/curate-status.json`. Atomic unique-tmp + rename, cloned from
 *     update-check.js readCache/writeCache. Malformed-prior → null (so the next
 *     write self-heals; the MCP read path raises the corrupt-file notice
 *     separately, §5.8).
 *
 * Pure-fs only — no MCP/CLI imports — so the test runner exercises it directly.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// ── Constants ────────────────────────────────────────────────────────────────
// Hysteresis thresholds live here (mirroring how HEALTHY_FAILURE_THRESHOLD is a
// constant in update-check.js). The read-path cooldown / grace / monitor-stale
// constants live in silo-mcp/notices.js instead — they gate *emission*, not the
// verdict, and the bridge is a separate package (see notices.js).
export const SCHEMA_VERSION = 1;
export const STATUS_FILENAME = 'curate-status.json';
// Asymmetric on purpose (§5.4): STALE_DAYS=3 tolerates ~2 missed nights before
// lighting; CLEAR_DAYS=1 only clears on a genuinely fresh success. The 2-day
// dead band between them is a Schmitt trigger — the verdict cannot flap
// night-to-night around a single boundary.
export const STALE_DAYS = 3;
export const CLEAR_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── deriveCuratorStatus (raw facts from the heartbeat events) ─────────────────

/**
 * Derive curate health from `system`-slug events with source=silo-curate.
 * Same pattern as deriveDetectorStatus in regenerate-pending-suggestions.js
 * (which parses source=silo-topic-detector events for detector_status).
 *
 * Content prefixes the cron wrapper emits:
 *   "silo-curate run started (run_id=...)"
 *   "silo-curate run complete (run_id=...)"
 *   "silo-curate run failed (run_id=..., exit=N)"
 *
 * @returns {null | {last_run_at, last_success_at, consecutive_failures,
 *                    last_failure_msg, last_event_kind}}
 *   null when there are no silo-curate events at all. `last_event_kind` is the
 *   kind ('started'|'complete'|'failed') of the MOST RECENT curate event — the
 *   R2-Live-3 in-progress discriminator. Unlike `last_failure_msg` (preserved
 *   across a later 'run started' until the next 'run complete'), it reflects
 *   actual event ordering, so a post-failure started-with-no-terminal is
 *   correctly identified as in-progress rather than failed.
 */
export function deriveCuratorStatus(state) {
  const events = state.topic_content.get('system') ?? [];
  const curateEvents = events.filter((e) => {
    if (typeof e.content !== 'string') return false;
    if (!e.content.startsWith('silo-curate')) return false;
    const src = state.seq_to_event.get(e.seq)?.source;
    return src === 'silo-curate';
  });

  let lastRunAt = null;
  let lastSuccessAt = null;
  let lastFailureMsg = null;
  let consecutiveFailures = 0;
  let lastEventKind = null;

  for (const e of curateEvents) {
    if (e.content.includes('run started')) {
      lastRunAt = e.ts;
      lastEventKind = 'started';
    } else if (e.content.includes('run complete')) {
      lastRunAt = e.ts;
      lastSuccessAt = e.ts;
      lastFailureMsg = null;
      consecutiveFailures = 0;
      lastEventKind = 'complete';
    } else if (e.content.includes('run failed')) {
      lastRunAt = e.ts;
      lastFailureMsg = e.content;
      consecutiveFailures += 1;
      lastEventKind = 'failed';
    }
  }

  if (!lastRunAt) return null;
  return {
    last_run_at: lastRunAt,
    last_success_at: lastSuccessAt,
    consecutive_failures: consecutiveFailures,
    last_failure_msg: lastFailureMsg,
    last_event_kind: lastEventKind,
  };
}

// ── foldLiveness (pure verdict fold, §5.4) ────────────────────────────────────

/**
 * Resolve the persisted liveness verdict from the raw facts + the prior cache.
 *
 * @param {Object} opts
 * @param {Object|null} opts.raw        - deriveCuratorStatus(state) result (may be null)
 * @param {Object|null} [opts.prior]    - prior curate-status.json contents (may be null)
 * @param {number}      opts.now        - wall-clock ms (test seam)
 * @param {number}      [opts.staleDays] - dark→lit threshold (default STALE_DAYS)
 * @param {number}      [opts.clearDays] - lit→dark threshold (default CLEAR_DAYS)
 * @returns {Object} the WHOLE of curate-status.json minus schema_version (which
 *   writeCurateStatus stamps) and minus last_emitted_at (which lives in
 *   curate-emit.json — §5.5).
 */
export function foldLiveness({
  raw,
  prior = null,
  now,
  staleDays = STALE_DAYS,
  clearDays = CLEAR_DAYS,
} = {}) {
  const nowIso = new Date(now).toISOString();

  const lastRunAt = raw?.last_run_at ?? null;
  const lastSuccessAt = raw?.last_success_at ?? null;
  const consecutiveFailures = raw?.consecutive_failures ?? 0;
  const lastFailureMsg = raw?.last_failure_msg ?? null;
  const lastEventKind = raw?.last_event_kind ?? null;

  // In-progress keys off event ORDERING (most recent event is 'started'), NOT
  // `last_failure_msg == null` (R2-Live-3). A success→failure→started(no
  // terminal) history is in_progress even though last_failure_msg still carries
  // the stale failure text — last_event_kind reflects the real ordering.
  const inProgress = lastEventKind === 'started';

  // Days since last success (null when never succeeded — Date.parse of null
  // yields NaN, which we map back to null).
  const successMs = lastSuccessAt == null ? NaN : Date.parse(lastSuccessAt);
  const daysSinceSuccess = Number.isFinite(successMs)
    ? (now - successMs) / DAY_MS
    : null;

  // Hysteresis (Schmitt trigger): branch on the PRIOR verdict so set(3) and
  // clear(1) differ → a 2-day dead band the verdict can't flap inside.
  let isStale;
  if (daysSinceSuccess == null) {
    // Never succeeded → the hysteresis light stays OFF here. The
    // never-succeeded notice is a SEPARATE read-path branch gated on
    // first_observed_at age (F4 / §5.7), not this verdict.
    isStale = false;
  } else if (daysSinceSuccess < 0) {
    // Success timestamped in the future (clock skew) → fail-safe toward silence.
    isStale = false;
  } else if (prior?.is_stale) {
    isStale = daysSinceSuccess > clearDays; // stay lit until a fresh success
  } else {
    isStale = daysSinceSuccess > staleDays; // light only after sustained silence
  }

  return {
    last_run_at: lastRunAt,
    last_success_at: lastSuccessAt,
    consecutive_failures: consecutiveFailures,
    last_failure_msg: lastFailureMsg,
    last_event_kind: lastEventKind,
    in_progress: inProgress,
    computed_at: nowIso,
    days_since_success: daysSinceSuccess,
    is_stale: isStale,
    // Persisted and carried forward forever — anchors the never-succeeded grace
    // window so a brand-new silo stays dark for the grace period (§5.4 / F4).
    first_observed_at: prior?.first_observed_at ?? nowIso,
  };
}

// ── Cache I/O (clone of update-check.js readCache/writeCache) ─────────────────

const statusPath = (siloDir) => join(siloDir, STATUS_FILENAME);

export async function readCurateStatus(siloDir) {
  try {
    const raw = await fs.readFile(statusPath(siloDir), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // Malformed-prior → treat as missing so the NEXT write self-heals it
    // (mirrors update-check.js readCache). The MCP read path raises the
    // corrupt-file notice separately — §5.8.
    return null;
  }
}

export async function writeCurateStatus(siloDir, status) {
  await fs.mkdir(siloDir, { recursive: true });
  const finalPath = statusPath(siloDir);
  // writeCurateStatus stamps schema_version (§5.4) — the one deliberate
  // divergence from writeCache, which writes its argument as-is. Keeps
  // foldLiveness a pure verdict fn that doesn't know about the persistence
  // schema version.
  const stamped = { schema_version: SCHEMA_VERSION, ...status };
  // Unique tmp per writer + atomic rename so the MCP read path's mtime-cached
  // read never observes a torn file, and the two crons (detect 04:00, curate
  // 05:00) can't interleave a partial write. Mirrors writeCache.
  const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, finalPath);
}
