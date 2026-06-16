/**
 * Write-event slug-existence guard — v0.2.5 (proposals/slug-existence-guard.md).
 *
 * A `write_event` may only land on a slug that already EXISTS in log-truth —
 * a reserved sink, a slug with ≥1 prior write_event (grandfathered), or a slug
 * a TOPIC_METADATA_SET created WITH a `topic_type`. Any other slug is rejected
 * at the LogWriter admission boundary (`AdmissionError('SLUG_NOT_ADMITTED')`),
 * on ALL sockets including `admin`. New topics are born only via a
 * TOPIC_METADATA_SET (accept_suggestion, import, or `silo topic create`).
 *
 * Content-integrity, orthogonal to access-control. The guard is `write_event`-
 * only; TOPIC_METADATA_SET topic-creation is intentionally NOT gated (the
 * access-control axis, deferred to the multi-user tier layer — spec §4.9/NG2).
 *
 * Pure + unit-testable in isolation: `deriveWriteAdmissible`/`buildAdmissionContext`/
 * `isSlugWriteAdmissible` are side-effect-free; `guardSlugExistence` only mutates
 * the lock-scoped context it is handed and throws AdmissionError. None of them
 * touch the log or the LogWriter instance — the ephemeral context lives only for
 * the duration of one locked append session (spec §4.2, G7).
 */

import { AdmissionError } from '../log/admission-error.js';

/**
 * Reserved sinks — always write-admissible, never require creation (spec §4.4).
 *   - `general`: the catch-all topic (event-log-only, renders no topic file).
 *   - `system` : the cron/backup status sink (silo-curate / silo-detect /
 *                silo-backup --slug=system). Dropping it silently kills cron
 *                health logging — the curate-dead incident shape.
 */
export const RESERVED_SINKS = new Set(['general', 'system']);

/**
 * The write-admissible set from a fresh interpret() State (spec §4.3):
 *
 *   { slug : topic_content has ≥1 entry }          // ≥1 real write_event
 *                                                   //   (incl. CURATED bullets);
 *                                                   //   grandfathers pre-guard orphans
 * ∪ { slug : topic_index slot has topic_type set } // a TOPIC_METADATA_SET WITH type
 *                                                   //   (accepted / created topics)
 *
 * Creation marker = `topic_type` PRESENT (spec §4.3, R3-D5): a type-less
 * TOPIC_METADATA_SET creates a topic_index slot but is NOT write-admissible —
 * which also excludes TOPIC_VERIFIED / TOPIC_CURATED-only slots (the round-2
 * bypass: those set neither topic_content nor topic_type). Reserved sinks are
 * handled separately by `isSlugWriteAdmissible`, NOT folded in here.
 *
 * O(topics), not O(log) — iterates the two already-in-memory Maps once.
 *
 * @param {Object} state - a fresh interpret() State.
 * @returns {Set<string>}
 */
export function deriveWriteAdmissible(state) {
  const admissible = new Set();
  for (const [slug, history] of state.topic_content) {
    if (Array.isArray(history) && history.length > 0) admissible.add(slug);
  }
  for (const [slug, meta] of state.topic_index) {
    if (meta && meta.topic_type !== undefined) admissible.add(slug);
  }
  return admissible;
}

/**
 * Build the ephemeral, lock-scoped admission context for one append session
 * (spec §4.2). Computed ONCE per locked session from a fresh interpret() State
 * — never stored on the LogWriter instance, never caller-passed across the
 * lock boundary. `stateSeq` is the folded tail seq, compared against the
 * physical tail seq for the session-level tail-safety gate.
 *
 * @param {Object} freshState - interpret() State taken under the append flock.
 * @returns {{stateSeq:number, writeAdmissible:Set<string>, stagedAdmissible:Set<string>}}
 */
export function buildAdmissionContext(freshState) {
  return {
    stateSeq: freshState.last_seq,
    writeAdmissible: deriveWriteAdmissible(freshState),
    stagedAdmissible: new Set(),
  };
}

/**
 * Is `slug` admissible for a write_event under this context?
 * slug ∈ {general, system} ∪ writeAdmissible ∪ stagedAdmissible (spec §4.1).
 */
export function isSlugWriteAdmissible(slug, context) {
  return RESERVED_SINKS.has(slug)
    || context.writeAdmissible.has(slug)
    || context.stagedAdmissible.has(slug);
}

/**
 * The per-entry guard, run in `_appendBatchUnlocked`'s admission section
 * (beside the matrix gate). Two responsibilities:
 *
 *   1. STAGE intra-batch admissibility. A TOPIC_METADATA_SET that sets a
 *      `topic_type` (creation) stages its slug so a later same-batch
 *      write_event is admitted (spec §4.2, F3). A type-LESS metadata event
 *      does NOT stage (build-note #6 — only typed creation confers
 *      admissibility). Non-write/non-metadata events are inert here.
 *
 *   2. GUARD write_event. Admit iff `isSlugWriteAdmissible`; else throw
 *      AdmissionError('SLUG_NOT_ADMITTED', {slug, hint}). An admitted
 *      write_event also stages its own slug (grandfathering within the batch).
 *
 * A write_event with NO context is rejected (G2 — airtight; no caller may
 * bypass the guard by omitting the context). Mutates `context.stagedAdmissible`
 * in place; the caller passes the SAME context object across the batch loop so
 * staging accumulates in order.
 *
 * @param {{type:string, payload:Object}} entry
 * @param {Object|null} context - the lock-scoped admission context, or null.
 */
export function guardSlugExistence(entry, context) {
  const { type, payload } = entry;

  if (type === 'TOPIC_METADATA_SET') {
    // Only a TYPED creation stages admissibility (build-note #6). A type-less
    // metadata event mints a slot but leaves it non-write-admissible.
    if (context && payload && payload.type !== undefined
        && typeof payload.topic === 'string') {
      context.stagedAdmissible.add(payload.topic);
    }
    return;
  }

  if (type !== 'write_event') return;

  // write_event is ALWAYS guarded. A missing context is a caller bug, not a
  // bypass — fail loud rather than admit unchecked (G2).
  if (!context) {
    throw new AdmissionError('SLUG_NOT_ADMITTED', {
      slug: payload?.slug ?? null,
      reason: 'admission_context_required',
      hint: 'internal: write_event reached _appendBatchUnlocked without a '
        + 'lock-scoped admission context',
    });
  }

  const slug = payload?.slug;
  if (!isSlugWriteAdmissible(slug, context)) {
    throw new AdmissionError('SLUG_NOT_ADMITTED', {
      slug: slug ?? null,
      hint: `topic "${slug}" is not write-admissible — create it first `
        + `(silo topic create ${slug}) or write to "general"`,
    });
  }

  // Admitted — stage so a later same-slug write in this batch also passes.
  context.stagedAdmissible.add(slug);
}
