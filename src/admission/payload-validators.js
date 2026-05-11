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
  if (entry.type === 'TOPIC_BULLETS_RETIRED') {
    validateTopicBulletsRetiredPayload(entry.payload, ctx);
  }
  // Other event types: no admission-time payload validation yet.
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
