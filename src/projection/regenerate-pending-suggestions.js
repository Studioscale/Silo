/**
 * Pending-suggestions projection — Phase 2.2 §6.
 *
 * Produces the JSON envelope `PENDING-SUGGESTIONS.json` that the MCP
 * server reads (with mtime caching) to surface pending topic suggestions
 * via the `list_pending_suggestions` tool and the `_silo_notices` array
 * on read tools.
 *
 * Pure builder: takes the interpret() state + a wall-clock `now`, returns
 * the envelope object. Atomic writing happens in projection/index.js
 * alongside the other regen targets.
 *
 * Envelope shape:
 *   { schema_version, generated_at, suggestions, count,
 *     oldest_pending_age_days, cap, cap_reached, detector_status }
 *
 * Suggestions sorted oldest-first by ts. When the count of pending
 * suggestions exceeds CAP, the envelope returns the CAP oldest and sets
 * cap_reached: true.
 */

const SCHEMA_VERSION = 1;
const PENDING_CAP = 10;

/**
 * Build the envelope. Pure given (state, now).
 *
 * @param {Object} state - interpret() output
 * @param {Date|number} [now] - wall-clock anchor (test seam). Defaults to Date.now().
 * @returns {Object} envelope ready for JSON.stringify
 */
export function buildPendingSuggestionsEnvelope(state, now = Date.now()) {
  const nowMs = typeof now === 'number' ? now : now.getTime();

  const pendingSeqs = [...state.pending_topic_suggestion_seqs];
  const records = pendingSeqs
    .map((seq) => state.topic_suggestions.get(seq))
    .filter(Boolean);

  // Sort by ts ascending (oldest first). Stable tiebreak on seq.
  records.sort((a, b) => {
    const ta = a.ts ?? '';
    const tb = b.ts ?? '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return a.seq - b.seq;
  });

  const totalPending = records.length;
  const visible = records.slice(0, PENDING_CAP);

  const suggestions = visible.map((r) => ({
    seq: r.seq,
    slug: r.slug,
    name: r.name,
    description: r.description,
    supporting_seqs: r.supporting_seqs,
    rationale: r.rationale,
    ts: r.ts,
    age_days: ageDays(r.ts, nowMs),
  }));

  const oldestAge = visible.length > 0 ? ageDays(visible[0].ts, nowMs) : 0;

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date(nowMs).toISOString(),
    suggestions,
    count: visible.length,
    oldest_pending_age_days: oldestAge,
    cap: PENDING_CAP,
    cap_reached: totalPending > PENDING_CAP,
    detector_status: deriveDetectorStatus(state),
  };
}

function ageDays(ts, nowMs) {
  if (!ts) return 0;
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return 0;
  const diff = nowMs - tsMs;
  if (diff <= 0) return 0;
  return Math.floor(diff / 86400000);
}

/**
 * Derive detector health from system-slug events the detector cron emits
 * (per spec §9.1). Format the detector uses today:
 *   "silo-detect run started (run_id=..., scope=..., days_back=...)"
 *   "silo-detect run complete (run_id=..., N suggested, M skipped, K validated)"
 *   "silo-detect first run deferred (...)"
 *   "silo-detect: insufficient events, no clusters"
 *
 * Returns null-zero-false defaults when the detector has never run.
 *
 * Failure model: a "run started" without a matching "run complete" counts
 * as an in-progress run (not a failure) UNTIL another run started lands —
 * the earlier one is then considered failed and consecutive_failures
 * increments. We treat the latest event for consecutive_failures based on
 * whether the most recent two cron runs both ended in completed events.
 *
 * Note: this is content-parsing — the detector module (§15 step 7) owns
 * the format. If the format changes, this function changes alongside it.
 */
function deriveDetectorStatus(state) {
  const events = state.topic_content.get('system') ?? [];
  const detectorEvents = events.filter(
    (e) => typeof e.content === 'string' && e.content.startsWith('silo-detect'),
  );

  let lastRunAt = null;
  let lastSuccessAt = null;
  let firstRunDeferred = false;
  let consecutiveFailures = 0;

  for (const e of detectorEvents) {
    if (e.content.includes('run started')) {
      lastRunAt = e.ts;
    } else if (e.content.includes('run complete')) {
      lastRunAt = e.ts;
      lastSuccessAt = e.ts;
      consecutiveFailures = 0;
    } else if (e.content.includes('run failed')) {
      // silo-detect.sh emits "silo-detect run failed (run_id=..., exit=N)"
      // when DETECT_STATUS != 0 — count it explicitly.
      lastRunAt = e.ts;
      consecutiveFailures += 1;
    } else if (e.content.includes('first run deferred')) {
      lastRunAt = e.ts;
      firstRunDeferred = true;
    } else if (e.content.includes('insufficient events')) {
      // No-op run — counts as a successful "nothing to do" tick.
      lastRunAt = e.ts;
      lastSuccessAt = e.ts;
      consecutiveFailures = 0;
    }
  }

  if (!lastRunAt) {
    return {
      last_run_at: null,
      last_success_at: null,
      consecutive_failures: 0,
      first_run_deferred: false,
    };
  }

  return {
    last_run_at: lastRunAt,
    last_success_at: lastSuccessAt,
    consecutive_failures: consecutiveFailures,
    first_run_deferred: firstRunDeferred,
  };
}

export { PENDING_CAP, SCHEMA_VERSION };
