/**
 * Admission payload validators — Silo Phase 2.1 hardening + Phase 2.2 extensions.
 *
 * Validates per-event-type payload shape + minimal local sanity (e.g., seq
 * references must be <= the writer's last-known committed seq) at write-time,
 * before the entry is canonicalized or hash-chained.
 *
 * Currently validated event types (each with its own per-type validator
 * dispatched from the switch in validatePayloadForAppend below):
 *   - TOPIC_BULLETS_RETIRED          (Phase 2.1)
 *   - TOPIC_METADATA_SET             (Phase 2.2)
 *   - TOPIC_SUGGESTED                (Phase 2.2)
 *   - TOPIC_SUGGESTION_ACCEPTED      (Phase 2.2)
 *   - TOPIC_SUGGESTION_DISMISSED     (Phase 2.2)
 *
 * Other event types pass through admission without payload validation today
 * (write_event, TOPIC_VERIFIED, TOPIC_CURATED, principal/feature/ACL events,
 * install / recovery / matrix-meta events). The roadmap follow-up below
 * tracks the broader gate.
 *
 * Scope: structural validation + prior-seq sanity. NOT semantic referential
 * validation — "seq exists as a CURATED bullet on the same topic" remains
 * `interpret()`'s responsibility (Group A's state.skipped instrumentation).
 *
 * Design context: this is the first instance of write-time payload validation
 * in Silo. The Phase 2.1 audit (Gemini + ChatGPT + fresh Claude + targeted
 * pushback round) converged on:
 *   - Hand-coded validators (Option B), not a generic JSON Schema layer (A)
 *   - Live in src/admission/ (not LogWriter, not Matrix, not src/broker/)
 *   - Throw structured AdmissionValidationError, not plain Error
 *   - Validator stays write-only; interpret() retains tolerance via state.skipped
 *
 * Followup task (tracked outside this module): wire Matrix.isAdmissible() as a
 * complete write-time gate combined with this payload validation. Today's
 * validators enforce payload shape only, not (type, socket, mode) admission.
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
    super(formatAdmissionMessage({ eventType, field, reason, detail }));
    this.name = 'AdmissionValidationError';
    this.code = code; // INVALID_EVENT_PAYLOAD
    this.eventType = eventType; // e.g. TOPIC_BULLETS_RETIRED
    this.field = field; // e.g. superseded_seqs
    this.reason = reason; // e.g. must_be_strictly_ascending
    this.detail = detail || null;
  }
}

/**
 * Build a human-readable error string. Detail numerics are inlined so the
 * `.message` is actionable on its own (catching `err.detail.max` works for
 * machine consumers, but the message-text-only path is what most operators
 * actually see in logs). Specific reason+field combinations also get a
 * one-line hint pointing at the right workaround.
 *
 * Audit follow-up (Pedro's report): `write_event: content length_out_of_range`
 * used to be the entire .message — the 500/50000/200000 cap wasn't surfaced
 * until you opened the detail object. Now it's in the text + the
 * tag-specific hint about CURATED/SOURCE for long-form content.
 */
function formatAdmissionMessage({ eventType, field, reason, detail }) {
  let msg = `${eventType}: ${field} ${reason}`;
  if (detail) {
    if (detail.max !== undefined && detail.actual !== undefined) {
      msg += ` (actual=${detail.actual}, max=${detail.max}`;
      if (detail.tag) msg += `, tag=${detail.tag}`;
      msg += ')';
    } else if (detail.value !== undefined) {
      msg += ` (value=${JSON.stringify(detail.value)})`;
    }
  }
  // Field-specific actionable hints.
  if (
    eventType === 'write_event' &&
    field === 'content' &&
    reason === 'length_out_of_range'
  ) {
    msg +=
      `. For long-form content, use tag=CURATED (max 50_000) or tag=SOURCE ` +
      `(max 200_000); event-log tags cap at 500 chars by design.`;
  }
  if (
    eventType === 'write_event' &&
    field === 'content' &&
    reason === 'must_be_single_line_for_tag'
  ) {
    msg +=
      `. Event-log tags render as one markdown row; multi-line content ` +
      `must use tag=CURATED or tag=SOURCE instead.`;
  }
  return msg;
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
    case 'write_event':
      validateWriteEventPayload(entry.payload, ctx);
      break;
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

// ─── write_event (audit-found extension) ─────────────────────────────────────
//
// write_event is the user-facing primitive. Until this audit, it had no
// admission validator at all — any payload shape was accepted. That meant:
//   - a slug like `team_member` (allowed by the older parse.js regex,
//     not by the canonical) could land in the log via write_event, then
//     be stranded when later TOPIC_METADATA_SET / TOPIC_SUGGESTED for
//     the same slug rejected it
//   - multi-line content survived into the operation log but was
//     silently truncated to first line by the event-log projection
//     (regenerate-event-log.js:reconstructEventLine), losing data in
//     the human-readable .md files
//
// The validator below enforces:
//   - slug matches canonical regex + length 2..40
//   - tag is one of the recognized event-log tags OR matches an
//     extraction/curation tag (CURATED, SOURCE) — both are permitted
//   - content is a non-empty string ≤500 chars
//   - for tags whose projection is a single-line markdown row
//     (FACT, DECISION, CHANGED, PROCEDURE, TODO, EVENT, CURATED),
//     content must not contain \r or \n
//   - for tag=SOURCE (Layer-3 imported blockquote material), multi-line
//     is allowed — that's the point of Layer 3
//   - confidence (optional) is one of CONFIRMED/TENTATIVE/CONTEXT
//   - source, auto_extracted, curated_at — typed but otherwise loose
//   - imported (optional) — the import-jarvis round-trip metadata
//     object. Allowed to carry arbitrary keys (it's already-on-disk
//     data we're preserving), but must be an object if present.

// Event-log tags rendered as a single markdown row. Includes SECURITY and
// CURATION which the MCP parser recognizes and which appear in real Jarvis
// production fixtures.
const WRITE_EVENT_EVENT_TAGS = new Set([
  'FACT', 'DECISION', 'CHANGED', 'PROCEDURE', 'TODO', 'EVENT',
  'SECURITY', 'CURATION',
]);
const WRITE_EVENT_INTERNAL_TAGS = new Set(['CURATED', 'SOURCE']);
const WRITE_EVENT_CONFIDENCES = new Set(['CONFIRMED', 'TENTATIVE', 'CONTEXT']);
// Only event-log tags require single-line content — that's the format
// regenerate-event-log.js renders. CURATED is multi-line in practice:
//   - cron silo-curate emits `- bullet text` per write (single-line, fine)
//   - import-jarvis emits whole Layer-2 sections (`## heading\n\nbody...`)
//     as a single event so the section stays a coherent unit
// SOURCE is Layer-3 blockquote material; multi-line by definition.
const WRITE_EVENT_SINGLE_LINE_TAGS = new Set([...WRITE_EVENT_EVENT_TAGS]);
// Event-log tags render as one markdown row; cap content to keep them
// scannable + match the MCP write_event zod schema (z.string().max(500)).
// CURATED is multi-line (whole Layer-2 sections); SOURCE is Layer-3
// blockquote material that can be substantial. Both keep a high but
// finite cap to bound DoS surface.
const WRITE_EVENT_MAX_CONTENT_EVENTLOG = 500;
const WRITE_EVENT_MAX_CONTENT_CURATED = 50_000;
const WRITE_EVENT_MAX_CONTENT_SOURCE = 200_000;
const WRITE_EVENT_MAX_SOURCE = 60;

function validateWriteEventPayload(payload, _ctx) {
  const EVT = 'write_event';
  const fail = makeFail(EVT);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('payload', 'must_be_object');
  }

  // Allowed fields. `imported` is a free-form object preserved from the
  // import-jarvis migration; we permit any sub-keys.
  const allowed = new Set([
    'slug', 'tag', 'content', 'confidence', 'source',
    'auto_extracted', 'curated_at', 'imported',
  ]);
  for (const [key] of presentEntries(payload)) {
    if (!allowed.has(key)) fail(key, 'unknown_field');
  }

  if (payload.slug === undefined) fail('slug', 'required');
  assertSlugString(payload.slug, 'slug', fail);

  if (payload.content === undefined) fail('content', 'required');
  if (typeof payload.content !== 'string') fail('content', 'must_be_string');
  if (payload.content.length === 0) fail('content', 'must_be_nonblank');

  // Tag is optional — caller defaults to FACT when omitted. If present,
  // it must be a known event-log or internal tag.
  if (payload.tag !== undefined) {
    if (typeof payload.tag !== 'string') fail('tag', 'must_be_string');
    if (!WRITE_EVENT_EVENT_TAGS.has(payload.tag)
        && !WRITE_EVENT_INTERNAL_TAGS.has(payload.tag)) {
      fail('tag', 'unknown_tag', { value: payload.tag });
    }
  }
  const effectiveTag = payload.tag ?? 'FACT';

  // Length cap is per-tag: event-log tags are scannable one-liners,
  // CURATED is Layer-2 sections, SOURCE is Layer-3 blockquotes.
  const maxLen = effectiveTag === 'SOURCE'
    ? WRITE_EVENT_MAX_CONTENT_SOURCE
    : effectiveTag === 'CURATED'
    ? WRITE_EVENT_MAX_CONTENT_CURATED
    : WRITE_EVENT_MAX_CONTENT_EVENTLOG;
  if (payload.content.length > maxLen) {
    fail('content', 'length_out_of_range', {
      max: maxLen,
      actual: payload.content.length,
      tag: effectiveTag,
    });
  }

  // Single-line enforcement only for tags whose projection renders one
  // row of markdown — i.e. event-log tags. CURATED + SOURCE preserve
  // their structure as written.
  //
  // CARVE-OUT for imported events: regenerate-event-log.js skips entries
  // with `payload.imported.field` set (they project to the topic file, not
  // the event log). Mirror that here — those events never appear as a
  // single-row event-log entry, so the single-line constraint isn't
  // meaningful for them. Real example: Jarvis topic-file YAML summaries
  // can be multi-line folded scalars, emitted as FACT events with
  // imported.field='summary'.
  const isProjectedToEventLog = !payload.imported?.field;
  if (isProjectedToEventLog && WRITE_EVENT_SINGLE_LINE_TAGS.has(effectiveTag)) {
    if (/[\r\n]/.test(payload.content)) {
      fail('content', 'must_be_single_line_for_tag', { tag: effectiveTag });
    }
  }

  if (payload.confidence !== undefined) {
    if (typeof payload.confidence !== 'string') fail('confidence', 'must_be_string');
    if (!WRITE_EVENT_CONFIDENCES.has(payload.confidence)) {
      fail('confidence', 'enum_violation', { allowed: [...WRITE_EVENT_CONFIDENCES] });
    }
  }

  if (payload.source !== undefined) {
    if (typeof payload.source !== 'string') fail('source', 'must_be_string');
    if (payload.source.length > WRITE_EVENT_MAX_SOURCE) {
      fail('source', 'length_out_of_range', {
        max: WRITE_EVENT_MAX_SOURCE,
        actual: payload.source.length,
      });
    }
  }

  if (payload.auto_extracted !== undefined
      && typeof payload.auto_extracted !== 'boolean') {
    fail('auto_extracted', 'must_be_boolean');
  }

  if (payload.curated_at !== undefined && typeof payload.curated_at !== 'string') {
    fail('curated_at', 'must_be_string');
  }

  if (payload.imported !== undefined) {
    if (typeof payload.imported !== 'object' || Array.isArray(payload.imported) || payload.imported === null) {
      fail('imported', 'must_be_object');
    }
  }
}

export {
  WRITE_EVENT_MAX_CONTENT_EVENTLOG,
  WRITE_EVENT_MAX_CONTENT_CURATED,
  WRITE_EVENT_MAX_CONTENT_SOURCE,
  WRITE_EVENT_SINGLE_LINE_TAGS,
  WRITE_EVENT_EVENT_TAGS,
  WRITE_EVENT_INTERNAL_TAGS,
};
