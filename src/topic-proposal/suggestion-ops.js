/**
 * Suggestion lifecycle operations — Phase 2.2 §8.
 *
 * Accept and dismiss are the user-driven verbs for resolving pending
 * TOPIC_SUGGESTED events. Both run under `writer.withAppendLock` so the
 * lock-scoped fresh state catches retries, races, and supporting-seq
 * revalidation atomically.
 *
 * Used by:
 *   - CLI: `silo suggest --accept <seq>` / `--dismiss <seq>`
 *   - MCP: `accept_suggestion` / `dismiss_suggestion` tools
 *
 * Both functions return structured results; they do NOT regenerate the
 * Zone B projections — the caller is responsible for that step (CLI:
 * inline call to regenerateProjections; MCP: spawn `silo regenerate`
 * subprocess after the lock releases).
 */

import { v7 as uuidv7 } from 'uuid';
import { isValidSlug } from '../admission/slug.js';

const DEFAULT_PRINCIPAL = 'operator';
const DEFAULT_SCAN_SLUGS = ['general'];
const DEFAULT_DISMISS_COOLDOWN_DAYS = 90;
const DETECTOR_SOURCE = 'silo-topic-detector';

/**
 * Structured error for accept/dismiss flows. Callers can pattern-match on
 * .code to translate into HTTP/CLI exit codes.
 */
export class SuggestionOpError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'SuggestionOpError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Shared topic-creation collision guard (reused by acceptSuggestion AND
 * `silo topic create` so the semantics stay identical, not duplicated). A slug
 * that already carries a `topic_type` is an existing topic; minting it again is
 * a SLUG_COLLISION. Must be called against a LOCK-SCOPED freshState.
 */
export function assertSlugHasNoTopic(freshState, slug) {
  const existingMeta = freshState.topic_index.get(slug);
  if (existingMeta?.topic_type) {
    throw new SuggestionOpError('SLUG_COLLISION', `slug "${slug}" already has a topic file`);
  }
}

/**
 * Accept a pending TOPIC_SUGGESTED — emits a batched
 * (TOPIC_METADATA_SET, TOPIC_SUGGESTION_ACCEPTED) pair atomically.
 *
 * @param {LogWriter} writer
 * @param {Object} input
 * @param {number} input.suggestion_seq
 * @param {string} [input.slug]         - override the suggestion's slug
 * @param {string} [input.name]         - reserved for future (not in TOPIC_METADATA_SET schema)
 * @param {string} [input.description]  - becomes the TOPIC_METADATA_SET summary
 * @param {string} [input.type]         - defaults to 'reference' (CRITICAL — without, regen skips the slug)
 * @param {string} [input.status]       - defaults to 'active' (CRITICAL — same reason)
 * @param {Array<string>} [input.tags]
 * @param {string} [input.principal]    - defaults to 'operator'
 * @param {string} [input.intent_id]    - if present, used as a prefix for both batch entries
 * @param {Array<string>} [input.scan_slugs] - for supporting-seq revalidation
 * @returns {Promise<{accepted: true, suggestion_seq, accepted_seq, metadata_seq, slug}>}
 */
export async function acceptSuggestion(writer, input) {
  if (!Number.isSafeInteger(input?.suggestion_seq) || input.suggestion_seq < 1) {
    throw new SuggestionOpError('INVALID_SUGGESTION_SEQ', 'suggestion_seq must be a safe positive integer');
  }
  const scanSlugs = input.scan_slugs ?? DEFAULT_SCAN_SLUGS;
  const principal = input.principal ?? DEFAULT_PRINCIPAL;

  let result;
  await writer.withAppendLock(async ({ writer: w, freshState, admissionContext }) => {
    // 1. Validate suggestion under lock — catches retries + concurrent state.
    const suggestion = freshState.topic_suggestions.get(input.suggestion_seq);
    if (!suggestion) {
      throw new SuggestionOpError('SUGGESTION_NOT_FOUND', `suggestion seq ${input.suggestion_seq} not found`);
    }
    if (suggestion.status !== 'pending') {
      throw new SuggestionOpError('SUGGESTION_NOT_PENDING', `suggestion seq ${input.suggestion_seq} is ${suggestion.status}`);
    }

    // 2. Resolve final slug (override or suggestion's) + collision check.
    const finalSlug = input.slug ?? suggestion.slug;
    if (!isValidSlug(finalSlug)) {
      throw new SuggestionOpError('INVALID_SLUG', `slug "${finalSlug}" fails regex/length validation`);
    }
    assertSlugHasNoTopic(freshState, finalSlug);

    // 3. Accept-time semantic re-validation of supporting_seqs (§8 step 2).
    for (const seq of suggestion.supporting_seqs) {
      const ev = freshState.seq_to_event.get(seq);
      if (!ev) {
        throw new SuggestionOpError('SUPPORTING_SEQ_NOT_FOUND', `supporting_seq ${seq} not found`, { seq });
      }
      if (ev.source === DETECTOR_SOURCE) {
        throw new SuggestionOpError('SUPPORTING_SEQ_INVALID_SOURCE',
          `supporting_seq ${seq} was emitted by the detector itself`, { seq, source: ev.source });
      }
      if (!scanSlugs.includes(ev.slug)) {
        throw new SuggestionOpError('SUPPORTING_SEQ_WRONG_SLUG',
          `supporting_seq ${seq} belongs to slug "${ev.slug}" outside scan_slugs`,
          { seq, found_slug: ev.slug, scan_slugs: scanSlugs });
      }
    }

    // 4. Build the batch — CRITICAL defaults per §1.1 round-5 F1: without
    //    type/status defaults, the topic file silently never appears
    //    because regenerateAllTopicFiles filters by meta.topic_type.
    const metadataIntentId = input.intent_id
      ? `intent:${input.intent_id}:metadata`
      : `intent:accept-metadata:${uuidv7()}`;
    const acceptIntentId = input.intent_id
      ? `intent:${input.intent_id}:accept`
      : `intent:accept-lifecycle:${uuidv7()}`;

    const metadataPayload = {
      topic: finalSlug,
      type: input.type ?? 'reference',
      status: input.status ?? 'active',
      summary: input.description ?? suggestion.description,
    };
    if (input.tags !== undefined) metadataPayload.tags = input.tags;

    const acceptedPayload = {
      suggestion_seq: input.suggestion_seq,
      accepted_slug: finalSlug,
    };

    // 5. Atomic batch append — single fs.write + fsync.
    const appended = await w._appendBatchUnlocked([
      {
        type: 'TOPIC_METADATA_SET',
        isStateBearing: true,
        intentId: metadataIntentId,
        principal,
        payload: metadataPayload,
      },
      {
        type: 'TOPIC_SUGGESTION_ACCEPTED',
        isStateBearing: true,
        intentId: acceptIntentId,
        principal,
        payload: acceptedPayload,
      },
    ], admissionContext);
    result = {
      accepted: true,
      suggestion_seq: input.suggestion_seq,
      metadata_seq: appended[0].seq,
      accepted_seq: appended[1].seq,
      slug: finalSlug,
    };
  });

  return result;
}

/**
 * Dismiss one-or-more pending TOPIC_SUGGESTED. All-or-nothing — any invalid
 * seq in the batch rejects the whole call with a structured error listing
 * the offenders.
 *
 * @param {LogWriter} writer
 * @param {Object} input
 * @param {Array<number>} input.suggestion_seqs
 * @param {number} [input.cooldown_days]
 * @param {string} [input.reason]
 * @param {string} [input.principal]
 * @returns {Promise<{dismissed: true, dismissed_seq, count, cooldown_days}>}
 */
export async function dismissSuggestions(writer, input) {
  if (!Array.isArray(input?.suggestion_seqs) || input.suggestion_seqs.length === 0) {
    throw new SuggestionOpError('INVALID_SUGGESTION_SEQS', 'suggestion_seqs must be a non-empty array');
  }
  const principal = input.principal ?? DEFAULT_PRINCIPAL;
  const cooldownDays = input.cooldown_days ?? DEFAULT_DISMISS_COOLDOWN_DAYS;

  // Validator wants strictly-ascending unique seqs — sort + dedup defensively.
  const seqs = [...new Set(input.suggestion_seqs)].sort((a, b) => a - b);

  let result;
  await writer.withAppendLock(async ({ writer: w, freshState, admissionContext }) => {
    // All-or-nothing pre-check: collect invalid seqs.
    const invalid = [];
    for (const seq of seqs) {
      const suggestion = freshState.topic_suggestions.get(seq);
      if (!suggestion) {
        invalid.push({ seq, reason: 'not_found' });
        continue;
      }
      if (suggestion.status !== 'pending') {
        invalid.push({ seq, reason: `not_pending_${suggestion.status}` });
      }
    }
    if (invalid.length > 0) {
      throw new SuggestionOpError('DISMISS_INVALID_SEQS',
        `${invalid.length} of ${seqs.length} suggestion_seqs are invalid`,
        { invalid });
    }

    const payload = {
      suggestion_seqs: seqs,
      cooldown_days: cooldownDays,
    };
    if (input.reason) payload.reason = input.reason;

    const [appended] = await w._appendBatchUnlocked([
      {
        type: 'TOPIC_SUGGESTION_DISMISSED',
        isStateBearing: true,
        intentId: `intent:dismiss:${uuidv7()}`,
        principal,
        payload,
      },
    ], admissionContext);
    result = {
      dismissed: true,
      dismissed_seq: appended.seq,
      count: seqs.length,
      cooldown_days: cooldownDays,
    };
  });

  return result;
}

export { DEFAULT_PRINCIPAL, DEFAULT_SCAN_SLUGS, DEFAULT_DISMISS_COOLDOWN_DAYS };
