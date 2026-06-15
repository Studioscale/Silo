/**
 * Retire operation — `silo retire` (v0.2.2, proposals/retire-primitive.md).
 *
 * Deliberate, audited retirement of one-or-more currently-active CURATED
 * (Layer-2) bullets on a single topic, riding the existing
 * TOPIC_BULLETS_RETIRED event type. Mirrors suggestion-ops.js: shared business
 * logic so both surfaces (CLI `silo retire`, MCP `retire_bullet`) inherit
 * correctness.
 *
 * Central invariant: NEVER append a no-op TOPIC_BULLETS_RETIRED event. Every
 * seq is re-validated against the lock-scoped fresh state as a currently-active
 * CURATED bullet on the named topic BEFORE the append; any failure throws and
 * appends nothing (all-or-nothing for multi-seq).
 *
 * Does NOT regenerate projections — the caller does (CLI: --to; MCP:
 * regenerateAfterWrite() after the lock releases).
 */

import { v7 as uuidv7 } from 'uuid';
import { isValidSlug } from '../admission/slug.js';

const DEFAULT_PRINCIPAL = 'operator'; // matches GLOBAL_OPTIONS + suggestion-ops.js
const RETIRE_SOURCE = 'silo-retire';

/**
 * Structured error for the retire flow. Callers pattern-match on .code to
 * translate into CLI exit codes / MCP error results.
 */
export class RetireOpError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'RetireOpError';
    this.code = code;
    this.detail = detail;
  }
}

// Mirror the admission validator's reason rule (payload-validators.js
// must_be_nonblank_one_line_string_lte_120_chars) so we reject pre-lock with a
// friendly code instead of letting the backstop fire.
function validateReason(reason) {
  if (reason === undefined) return;
  if (typeof reason !== 'string' || reason.trim().length < 1
      || reason.length > 120 || /[\r\n]/.test(reason)) {
    throw new RetireOpError('INVALID_REASON',
      'reason must be a non-blank single-line string <=120 chars');
  }
}

/**
 * Retire one-or-more active CURATED bullets on a single topic.
 *
 * @param {LogWriter} writer
 * @param {Object} input
 * @param {string} input.slug
 * @param {number|number[]} input.seqs - seq(s) of active CURATED write_events
 * @param {string} [input.reason]      - <=120 chars, single line, non-blank
 * @param {string} [input.principal]   - defaults to 'operator'
 * @returns {Promise<{retired:true, slug, seqs, count, retired_seq}>}
 */
/**
 * §B1 (proposals/retire-primitive.md §4.6): from a LOCK-SCOPED freshState,
 * return the subset of `candidateSeqs` that are STILL active CURATED bullets on
 * `slug` (CURATED in topic_content AND not already retired). `cmdCurate` uses
 * this to avoid emitting a no-op TOPIC_BULLETS_RETIRED when a manual `silo
 * retire` raced its pre-lock interpret(). Order-preserving — the caller's
 * ascending+deduped sort is kept, so the validator's strictly-ascending check
 * still holds.
 */
export function filterActiveCuratedSeqs(freshState, slug, candidateSeqs) {
  const hist = freshState.topic_content.get(slug) || [];
  const active = new Set(
    hist.filter((h) => h.tag === 'CURATED' && !freshState.retired_curated_seqs.has(h.seq))
      .map((h) => h.seq),
  );
  return candidateSeqs.filter((s) => active.has(s));
}

export async function retireBullet(writer, input) {
  const { slug, reason } = input;

  // ── Cheap, pre-lock shape validation (no lock taken for a doomed request) ──
  const rawSeqs = Array.isArray(input.seqs) ? input.seqs : [input.seqs];
  for (const s of rawSeqs) {
    if (!Number.isSafeInteger(s) || s < 1) {
      throw new RetireOpError('INVALID_RETIRE_SEQ',
        'every seq must be a safe positive integer', { value: s });
    }
  }
  // Dedup + sort ascending — same as cmdCurate and dismissSuggestions. The
  // admission validator hard-rejects non-ascending / duplicate-violating arrays.
  const seqs = [...new Set(rawSeqs)].sort((a, b) => a - b);
  if (seqs.length === 0) {
    throw new RetireOpError('EMPTY_SEQ_SET', 'no seqs supplied');
  }
  if (!isValidSlug(slug)) {
    throw new RetireOpError('INVALID_SLUG', `slug "${slug}" fails regex/length validation`);
  }
  validateReason(reason);
  const principal = input.principal ?? DEFAULT_PRINCIPAL;

  let result;
  await writer.withAppendLock(async ({ writer: w, freshTail, freshState }) => {
    // ── TAIL-SAFETY GATE (proposals/retire-primitive.md §4.5). ──
    // _scanTailUnlocked is hash-chain-BLIND: it returns the last
    // syntactically-valid line as the tail without verifying hash_prev, and a
    // new append chains onto THAT physical tail. If the physical tail is itself
    // broken/malformed, interpret() skips it AND skips our new append (which
    // chains onto the skipped tail) — silently orphaning the retire while we
    // return {retired:true}. freshState.last_seq is the last FOLDED seq;
    // freshTail.seq is the physical tail seq. They are equal iff the physical
    // tail was accepted by interpret. They differ ONLY when the tail is
    // broken/malformed — never on historical MIDDLE breaks (those re-sync, the
    // tail stays folded). Strict superset of a hash_chain_break-only check
    // (also catches a shape-malformed tail). Refuse in that case.
    // (Seq-compare, NOT hash-compare: tail_hash inits null vs GENESIS_HASH on
    // an empty log, so the hash form would false-positive at genesis; the
    // integer form degrades to 0 === 0. Do NOT "tidy" this into a hash check.)
    if (freshState.last_seq !== freshTail.seq) {
      throw new RetireOpError('LOG_INTEGRITY_UNSAFE',
        `operation-log TAIL is unsafe (last folded seq ${freshState.last_seq} `
        + `!= physical tail seq ${freshTail.seq}); a new append would chain onto a `
        + 'broken/unfolded tail and be silently orphaned — recover the log first',
        { last_seq: freshState.last_seq, tail_seq: freshTail.seq });
    }

    // ── 1. Reconstruct the ACTIVE-CURATED set EXACTLY as interpret()'s
    //       TOPIC_BULLETS_RETIRED handler does: CURATED seqs in topic_content
    //       MINUS already-retired seqs. ──
    const history = freshState.topic_content.get(slug) || [];
    const bySeq = new Map(history.map((h) => [h.seq, h]));

    // ── 2. All-or-nothing referential pre-flight (collect every offender) ──
    const invalid = [];
    for (const seq of seqs) {
      const rec = bySeq.get(seq);
      if (!rec) {
        // seq absent from this topic's write_event history. Could be a wrong
        // slug or a non-write/non-existent seq. Disambiguate via seq_to_event,
        // which ONLY indexes write_events.
        const ev = freshState.seq_to_event.get(seq);
        if (!ev) {
          invalid.push({ seq, code: 'SEQ_NOT_FOUND',
            reason: `no CURATED write_event at seq ${seq} (may be a non-write event)` });
        } else {
          invalid.push({ seq, code: 'SEQ_NOT_ON_TOPIC',
            reason: `seq ${seq} belongs to slug "${ev.slug}", not "${slug}"`,
            found_slug: ev.slug });
        }
        continue;
      }
      if (rec.tag !== 'CURATED') {
        invalid.push({ seq, code: 'SEQ_NOT_CURATED',
          reason: `seq ${seq} on "${slug}" is tag=${rec.tag ?? 'null'}, not CURATED`,
          tag: rec.tag ?? null });
        continue;
      }
      if (freshState.retired_curated_seqs.has(seq)) {
        invalid.push({ seq, code: 'SEQ_ALREADY_RETIRED',
          reason: `seq ${seq} is already retired` });
      }
    }
    if (invalid.length > 0) {
      // Single-seq: surface that seq's specific code (ergonomic + matches the
      // per-code tests). Multi-seq: a batch code with offenders in detail
      // (mirrors dismissSuggestions' DISMISS_INVALID_SEQS).
      if (seqs.length === 1) {
        const only = invalid[0];
        throw new RetireOpError(only.code, only.reason, only);
      }
      throw new RetireOpError('RETIRE_INVALID_SEQS',
        `${invalid.length} of ${seqs.length} seqs are not active CURATED bullets on "${slug}"`,
        { invalid });
    }

    // ── 3. Commit ONE event under the same lock (no re-entrancy) ──
    const payload = { topic: slug, superseded_seqs: seqs, source: RETIRE_SOURCE };
    if (reason) payload.reason = reason;
    const [appended] = await w._appendBatchUnlocked([{
      type: 'TOPIC_BULLETS_RETIRED',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal,
      payload,
    }]);
    result = { retired: true, slug, seqs, count: seqs.length, retired_seq: appended.seq };
  });

  return result;
}

export { DEFAULT_PRINCIPAL, RETIRE_SOURCE };
