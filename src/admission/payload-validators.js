/**
 * Admission payload validators — Silo Phase 2.1 hardening.
 *
 * Validates per-event-type payload shape + minimal local sanity (e.g., seq
 * references must be <= the writer's last-known committed seq) at write-time,
 * before the entry is canonicalized or hash-chained.
 *
 * Scope: structural validation + prior-seq sanity. NOT semantic referential
 * validation — "seq exists as a CURATED bullet on the same topic" remains
 * `interpret()`'s responsibility (Group A's state.skipped instrumentation).
 *
 * Design context: this is the first instance of write-time payload validation
 * in Silo. The Phase 2.1 audit (Gemini + ChatGPT + fresh Claude + targeted
 * pushback round) converged on:
 *   - Hand-coded validator (Option B), not a generic JSON Schema layer (A)
 *   - Lives in src/admission/ (not LogWriter, not Matrix, not src/broker/)
 *   - Throws structured AdmissionValidationError, not plain Error
 *   - Validator stays write-only; interpret() retains tolerance via state.skipped
 *
 * Followup task (tracked outside this module): wire Matrix.isAdmissible() as a
 * complete write-time gate combined with this payload validation. Today's
 * validator only enforces payload shape, not type/mode admission.
 */

export const MAX_SUPERSEDED_SEQS = 256;
export const MAX_SUPPORTING_SEQS = 100; // TOPIC_SUGGESTED
export const MAX_DISMISS_BATCH = 50; // TOPIC_SUGGESTION_DISMISSED
export const MAX_TAGS = 20; // TOPIC_METADATA_SET
export const MAX_ENTITIES = 20; // TOPIC_METADATA_SET
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TOPIC_TYPES = new Set([
  'reference', 'project', 'feedback', 'personal', 'archive', 'business', 'hobby',
]);
const TOPIC_STATUSES = new Set([
  'active', 'paused', 'archived', 'reference', 'deferred',
]);

export class AdmissionValidationError extends Error {
  constructor({ code, eventType, field, reason, detail }) {
    super(`${eventType}: ${field} ${reason}`);
    this.name = 'AdmissionValidationError';
    this.code = code; // INVALID_EVENT_PAYLOAD
    this.eventType = eventType; // e.g. TOPIC_BULLETS_RETIRED
    this.field = field; // e.g. superseded_seqs
    this.reason = reason; // e.g. must_be_strictly_ascending
    this.detail = detail || null;
  }
}

/**
 * Validate an entry's payload before LogWriter appends it.
 *
 * Currently only TOPIC_BULLETS_RETIRED has admission-time validation.
 * Other event types pass through unchanged.
 *
 * @param {Object} entry - the entry about to be written. Reads { type, payload }.
 * @param {Object} [ctx] - context from the writer.
 * @param {number} [ctx.maxKnownSeq] - if provided, seq references in payload
 *   must be <= this value (must reference already-committed prior entries).
 *   LogWriter passes `this._tail?.seq ?? 0` so retires cannot reference the
 *   entry being written or any future seq.
 * @throws {AdmissionValidationError} if validation fails.
 */
export function validatePayloadForAppend(entry, ctx = {}) {
  if (!entry || typeof entry !== 'object') return;
  switch (entry.type) {
    case 'TOPIC_BULLETS_RETIRED':
      validateTopicBulletsRetiredPayload(entry.payload, ctx);
      break;
    case 'TOPIC_METADATA_SET':
      validateTopicMetadataSetPayload(entry.payload, ctx);
      break;
    case 'TOPIC_SUGGESTED':
      validateTopicSuggestedPayload(entry.payload, ctx);
      break;
    case 'TOPIC_SUGGESTION_ACCEPTED':
      validateTopicSuggestionAcceptedPayload(entry.payload, ctx);
      break;
    case 'TOPIC_SUGGESTION_DISMISSED':
      validateTopicSuggestionDismissedPayload(entry.payload, ctx);
      break;
    default:
      // Other event types: no admission-time payload validation yet.
      break;
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function presentEntries(payload) {
  // Treat `undefined` values as not-present (JCS canonicalize drops them at
  // serialization time anyway). Null is NOT dropped — explicit null indicates
  // a typed value and must be checked by the field's type rule.
  return Object.entries(payload).filter(([, v]) => v !== undefined);
}

function makeFail(EVT) {
  return (field, reason, detail = null) => {
    throw new AdmissionValidationError({
      code: 'INVALID_EVENT_PAYLOAD',
      eventType: EVT,
      field,
      reason,
      detail,
    });
  };
}

function assertSlugString(value, field, fail) {
  if (typeof value !== 'string') fail(field, 'must_be_string');
  if (value.length < 2 || value.length > 40) {
    fail(field, 'length_out_of_range', { min: 2, max: 40, actual: value.length });
  }
  if (!SLUG_REGEX.test(value)) fail(field, 'slug_regex_mismatch');
}

function assertSingleLineString(value, field, fail, maxLen) {
  if (typeof value !== 'string') fail(field, 'must_be_string');
  if (value.length === 0 || value.trim().length === 0) {
    fail(field, 'must_be_nonblank');
  }
  if (value.length > maxLen) {
    fail(field, 'length_out_of_range', { max: maxLen, actual: value.length });
  }
  if (/[\r\n]/.test(value)) fail(field, 'must_be_single_line');
}

function assertStrictlyAscendingPositiveIntArray(value, field, fail, { min, max, maxKnownSeq }) {
  if (!Array.isArray(value)) fail(field, 'must_be_array');
  if (value.length < min || value.length > max) {
    fail(field, 'length_out_of_range', { min, max, actual: value.length });
  }
  let prev = 0;
  for (const s of value) {
    if (!Number.isSafeInteger(s) || s < 1) {
      fail(field, 'item_must_be_safe_positive_integer', { value: s });
    }
    if (maxKnownSeq !== undefined && s > maxKnownSeq) {
      fail(field, 'future_or_unknown_seq', { value: s, maxKnownSeq });
    }
    if (s <= prev) {
      fail(field, 'must_be_strictly_ascending', { value: s, previous: prev });
    }
    prev = s;
  }
}

// ─── TOPIC_METADATA_SET (§2.4) ───────────────────────────────────────────────

function validateTopicMetadataSetPayload(payload, _ctx) {
  const EVT = 'TOPIC_METADATA_SET';
  const fail = makeFail(EVT);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('payload', 'must_be_object');
  }

  const allowed = new Set([
    'topic', 'type', 'tags', 'entities', 'status', 'sensitivity',
    'created', 'summary', 'summary_trailing_blank',
  ]);
  for (const [key] of presentEntries(payload)) {
    if (!allowed.has(key)) fail(key, 'unknown_field');
  }

  if (payload.topic === undefined) fail('topic', 'required');
  assertSlugString(payload.topic, 'topic', fail);

  if (payload.type !== undefined) {
    if (typeof payload.type !== 'string') fail('type', 'must_be_string');
    if (!TOPIC_TYPES.has(payload.type)) {
      fail('type', 'enum_violation', { allowed: [...TOPIC_TYPES] });
    }
  }
  if (payload.status !== undefined) {
    if (typeof payload.status !== 'string') fail('status', 'must_be_string');
    if (!TOPIC_STATUSES.has(payload.status)) {
      fail('status', 'enum_violation', { allowed: [...TOPIC_STATUSES] });
    }
  }
  if (payload.tags !== undefined) {
    if (!Array.isArray(payload.tags)) fail('tags', 'must_be_array');
    if (payload.tags.length > MAX_TAGS) {
      fail('tags', 'length_out_of_range', { max: MAX_TAGS, actual: payload.tags.length });
    }
    for (const t of payload.tags) {
      if (typeof t !== 'string') fail('tags', 'item_must_be_string');
      if (t.length === 0 || t.length > 30) {
        fail('tags', 'item_length_out_of_range', { max: 30, value: t });
      }
      if (!SLUG_REGEX.test(t)) fail('tags', 'item_slug_regex_mismatch', { value: t });
    }
  }
  if (payload.entities !== undefined) {
    if (!Array.isArray(payload.entities)) fail('entities', 'must_be_array');
    if (payload.entities.length > MAX_ENTITIES) {
      fail('entities', 'length_out_of_range', { max: MAX_ENTITIES, actual: payload.entities.length });
    }
    for (const e of payload.entities) {
      if (typeof e !== 'string') fail('entities', 'item_must_be_string');
      if (e.length === 0 || e.length > 80) {
        fail('entities', 'item_length_out_of_range', { max: 80, value: e });
      }
    }
  }
  if (payload.sensitivity !== undefined) {
    if (typeof payload.sensitivity !== 'string') fail('sensitivity', 'must_be_string');
    if (payload.sensitivity.length > 20) {
      fail('sensitivity', 'length_out_of_range', { max: 20, actual: payload.sensitivity.length });
    }
  }
  if (payload.created !== undefined) {
    if (typeof payload.created !== 'string') fail('created', 'must_be_string');
    if (!ISO_DATE_REGEX.test(payload.created)) {
      fail('created', 'must_be_iso_date_yyyy_mm_dd', { value: payload.created });
    }
  }
  if (payload.summary !== undefined) {
    if (typeof payload.summary !== 'string') fail('summary', 'must_be_string');
    if (payload.summary.length > 1000) {
      fail('summary', 'length_out_of_range', { max: 1000, actual: payload.summary.length });
    }
    if (/\r/.test(payload.summary)) fail('summary', 'must_not_contain_cr');
  }
  if (payload.summary_trailing_blank !== undefined) {
    if (typeof payload.summary_trailing_blank !== 'boolean') {
      fail('summary_trailing_blank', 'must_be_boolean');
    }
  }
}

// ─── TOPIC_SUGGESTED (§2.1) ──────────────────────────────────────────────────

function validateTopicSuggestedPayload(payload, ctx) {
  const EVT = 'TOPIC_SUGGESTED';
  const fail = makeFail(EVT);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('payload', 'must_be_object');
  }

  const allowed = new Set([
    'slug', 'name', 'description', 'supporting_seqs', 'rationale', 'source',
  ]);
  for (const [key] of presentEntries(payload)) {
    if (!allowed.has(key)) fail(key, 'unknown_field');
  }

  if (payload.slug === undefined) fail('slug', 'required');
  assertSlugString(payload.slug, 'slug', fail);

  if (payload.name === undefined) fail('name', 'required');
  assertSingleLineString(payload.name, 'name', fail, 80);

  if (payload.description === undefined) fail('description', 'required');
  assertSingleLineString(payload.description, 'description', fail, 240);

  if (payload.rationale === undefined) fail('rationale', 'required');
  assertSingleLineString(payload.rationale, 'rationale', fail, 500);

  if (payload.supporting_seqs === undefined) fail('supporting_seqs', 'required');
  assertStrictlyAscendingPositiveIntArray(payload.supporting_seqs, 'supporting_seqs', fail, {
    min: 1,
    max: MAX_SUPPORTING_SEQS,
    maxKnownSeq: ctx.maxKnownSeq,
  });

  if (payload.source !== undefined) {
    assertSingleLineString(payload.source, 'source', fail, 60);
  }
}

// ─── TOPIC_SUGGESTION_ACCEPTED (§2.2) ────────────────────────────────────────

function validateTopicSuggestionAcceptedPayload(payload, ctx) {
  const EVT = 'TOPIC_SUGGESTION_ACCEPTED';
  const fail = makeFail(EVT);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('payload', 'must_be_object');
  }

  const allowed = new Set(['suggestion_seq', 'accepted_slug']);
  for (const [key] of presentEntries(payload)) {
    if (!allowed.has(key)) fail(key, 'unknown_field');
  }

  if (payload.suggestion_seq === undefined) fail('suggestion_seq', 'required');
  const seq = payload.suggestion_seq;
  if (!Number.isSafeInteger(seq) || seq < 1) {
    fail('suggestion_seq', 'must_be_safe_positive_integer', { value: seq });
  }
  if (ctx.maxKnownSeq !== undefined && seq > ctx.maxKnownSeq) {
    fail('suggestion_seq', 'future_or_unknown_seq', { value: seq, maxKnownSeq: ctx.maxKnownSeq });
  }

  if (payload.accepted_slug === undefined) fail('accepted_slug', 'required');
  assertSlugString(payload.accepted_slug, 'accepted_slug', fail);
}

// ─── TOPIC_SUGGESTION_DISMISSED (§2.3) ───────────────────────────────────────

function validateTopicSuggestionDismissedPayload(payload, ctx) {
  const EVT = 'TOPIC_SUGGESTION_DISMISSED';
  const fail = makeFail(EVT);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('payload', 'must_be_object');
  }

  const allowed = new Set(['suggestion_seqs', 'cooldown_days', 'reason']);
  for (const [key] of presentEntries(payload)) {
    if (!allowed.has(key)) fail(key, 'unknown_field');
  }

  if (payload.suggestion_seqs === undefined) fail('suggestion_seqs', 'required');
  assertStrictlyAscendingPositiveIntArray(payload.suggestion_seqs, 'suggestion_seqs', fail, {
    min: 1,
    max: MAX_DISMISS_BATCH,
    maxKnownSeq: ctx.maxKnownSeq,
  });

  if (payload.cooldown_days === undefined) fail('cooldown_days', 'required');
  const cd = payload.cooldown_days;
  if (!Number.isInteger(cd) || cd < 1 || cd > 365) {
    fail('cooldown_days', 'out_of_range', { min: 1, max: 365, value: cd });
  }

  if (payload.reason !== undefined) {
    assertSingleLineString(payload.reason, 'reason', fail, 120);
  }
}

function validateTopicBulletsRetiredPayload(payload, ctx) {
  const EVT = 'TOPIC_BULLETS_RETIRED';
  const fail = (field, reason, detail = null) => {
    throw new AdmissionValidationError({
      code: 'INVALID_EVENT_PAYLOAD',
      eventType: EVT,
      field,
      reason,
      detail,
    });
  };

  // Payload must be a non-null, non-array object.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('payload', 'must_be_object');
  }

  // Reject unknown payload fields. Prevents two emitters from producing
  // different JCS hashes for the "same" intent by adding incidental fields.
  const allowed = new Set(['topic', 'superseded_seqs', 'reason', 'source']);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      fail(key, 'unknown_field');
    }
  }

  // topic: non-blank string.
  if (typeof payload.topic !== 'string' || payload.topic.trim().length === 0) {
    fail('topic', 'required_nonblank_string');
  }

  // superseded_seqs: array, 1..MAX_SUPERSEDED_SEQS, strictly ascending,
  // all safe positive integers, each <= maxKnownSeq (if provided).
  const seqs = payload.superseded_seqs;
  if (!Array.isArray(seqs)) {
    fail('superseded_seqs', 'must_be_array');
  }
  if (seqs.length < 1 || seqs.length > MAX_SUPERSEDED_SEQS) {
    fail('superseded_seqs', 'length_out_of_range', {
      min: 1,
      max: MAX_SUPERSEDED_SEQS,
      actual: seqs.length,
    });
  }

  let prev = 0;
  for (const s of seqs) {
    if (!Number.isSafeInteger(s) || s < 1) {
      fail('superseded_seqs', 'item_must_be_safe_positive_integer', { value: s });
    }
    if (ctx.maxKnownSeq !== undefined && s > ctx.maxKnownSeq) {
      // Prior-seq sanity: retires may only reference already-committed entries.
      // Batch-append note: superseded_seqs cannot reference entries staged in
      // the same batch — only entries previously persisted.
      fail('superseded_seqs', 'future_or_unknown_seq', {
        value: s,
        maxKnownSeq: ctx.maxKnownSeq,
      });
    }
    if (s <= prev) {
      fail('superseded_seqs', 'must_be_strictly_ascending', {
        value: s,
        previous: prev,
      });
    }
    prev = s;
  }

  // reason: optional. If present: non-blank string, ≤120 chars, no newlines.
  if (payload.reason !== undefined) {
    if (
      typeof payload.reason !== 'string' ||
      payload.reason.trim().length < 1 ||
      payload.reason.length > 120 ||
      /[\r\n]/.test(payload.reason)
    ) {
      fail('reason', 'must_be_nonblank_one_line_string_lte_120_chars');
    }
  }

  // source: optional. If present, must be string. No further constraint.
  if (payload.source !== undefined && typeof payload.source !== 'string') {
    fail('source', 'must_be_string');
  }
}
