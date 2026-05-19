/**
 * Phase 2.2 §15 step 3 — admission validators for 4 new event types.
 *
 * Pure-function tests against validatePayloadForAppend; no LogWriter needed.
 * (Integration tests via the writer are covered in log-foundation.test.js
 *  and topic-proposal-interpret.test.js already.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePayloadForAppend,
  AdmissionValidationError,
  MAX_SUPPORTING_SEQS,
  MAX_DISMISS_BATCH,
  MAX_TAGS,
  MAX_ENTITIES,
} from '../src/admission/payload-validators.js';

function expectReject(entry, ctx, expectedField, expectedReason) {
  assert.throws(
    () => validatePayloadForAppend(entry, ctx),
    (err) => {
      assert.ok(err instanceof AdmissionValidationError);
      assert.equal(err.code, 'INVALID_EVENT_PAYLOAD');
      assert.equal(err.eventType, entry.type);
      assert.equal(err.field, expectedField);
      assert.equal(err.reason, expectedReason);
      return true;
    },
  );
}

// ─── TOPIC_METADATA_SET ──────────────────────────────────────────────────────

const VALID_METADATA = {
  topic: 'project-alpha',
  type: 'project',
  tags: ['flask', 'crm'],
  entities: ['Ana'],
  status: 'active',
  sensitivity: 'private',
  created: '2026-04-22',
  summary: 'CRM project',
};

test('TOPIC_METADATA_SET: valid minimal payload passes', () => {
  validatePayloadForAppend(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'demo' } },
    {},
  );
});

test('TOPIC_METADATA_SET: valid full payload passes', () => {
  validatePayloadForAppend(
    { type: 'TOPIC_METADATA_SET', payload: VALID_METADATA },
    {},
  );
});

test('TOPIC_METADATA_SET: unknown field rejected', () => {
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { ...VALID_METADATA, extra: 'oops' } },
    {},
    'extra',
    'unknown_field',
  );
});

test('TOPIC_METADATA_SET: missing topic rejected', () => {
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { type: 'project' } },
    {},
    'topic',
    'required',
  );
});

test('TOPIC_METADATA_SET: invalid slug rejected', () => {
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'Bad_Slug' } },
    {},
    'topic',
    'slug_regex_mismatch',
  );
});

test('TOPIC_METADATA_SET: bad type enum rejected', () => {
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'demo', type: 'whatever' } },
    {},
    'type',
    'enum_violation',
  );
});

test('TOPIC_METADATA_SET: bad status enum rejected', () => {
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'demo', status: 'frozen' } },
    {},
    'status',
    'enum_violation',
  );
});

test('TOPIC_METADATA_SET: too many tags rejected', () => {
  const tags = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'demo', tags } },
    {},
    'tags',
    'length_out_of_range',
  );
});

test('TOPIC_METADATA_SET: too-long entity rejected', () => {
  expectReject(
    {
      type: 'TOPIC_METADATA_SET',
      payload: { topic: 'demo', entities: ['x'.repeat(81)] },
    },
    {},
    'entities',
    'item_length_out_of_range',
  );
});

test('TOPIC_METADATA_SET: too many entities rejected', () => {
  const entities = Array.from({ length: MAX_ENTITIES + 1 }, (_, i) => `e${i}`);
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'demo', entities } },
    {},
    'entities',
    'length_out_of_range',
  );
});

test('TOPIC_METADATA_SET: invalid date format rejected', () => {
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'demo', created: '04/22/2026' } },
    {},
    'created',
    'must_be_iso_date_yyyy_mm_dd',
  );
});

test('TOPIC_METADATA_SET: summary with CR rejected', () => {
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'demo', summary: 'foo\rbar' } },
    {},
    'summary',
    'must_not_contain_cr',
  );
});

test('TOPIC_METADATA_SET: summary > 1000 chars rejected', () => {
  expectReject(
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'demo', summary: 'x'.repeat(1001) } },
    {},
    'summary',
    'length_out_of_range',
  );
});

test('TOPIC_METADATA_SET: summary_trailing_blank must be boolean', () => {
  expectReject(
    {
      type: 'TOPIC_METADATA_SET',
      payload: { topic: 'demo', summary_trailing_blank: 'yes' },
    },
    {},
    'summary_trailing_blank',
    'must_be_boolean',
  );
});

test('TOPIC_METADATA_SET: undefined optional fields ignored (no false-unknown rejection)', () => {
  // Construct a payload with all-undefined optionals — same shape import-jarvis
  // emits when frontmatter omits a field. Must NOT fail.
  validatePayloadForAppend(
    {
      type: 'TOPIC_METADATA_SET',
      payload: {
        topic: 'demo',
        type: undefined,
        tags: undefined,
        entities: undefined,
        status: undefined,
        sensitivity: undefined,
        created: undefined,
        summary: undefined,
        summary_trailing_blank: undefined,
      },
    },
    {},
  );
});

// ─── TOPIC_SUGGESTED ─────────────────────────────────────────────────────────

const VALID_SUGGESTED = {
  slug: 'pets',
  name: 'Pets',
  description: 'Health and routine for pets',
  supporting_seqs: [10, 11, 12],
  rationale: 'three events about Rover',
  source: 'silo-topic-detector',
};

test('TOPIC_SUGGESTED: valid payload passes', () => {
  validatePayloadForAppend(
    { type: 'TOPIC_SUGGESTED', payload: VALID_SUGGESTED },
    { maxKnownSeq: 100 },
  );
});

test('TOPIC_SUGGESTED: unknown field rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { ...VALID_SUGGESTED, bogus: 1 },
    },
    { maxKnownSeq: 100 },
    'bogus',
    'unknown_field',
  );
});

test('TOPIC_SUGGESTED: missing required field rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { slug: 'pets', name: 'Pets', description: 'd', supporting_seqs: [1], /* missing rationale */ },
    },
    { maxKnownSeq: 100 },
    'rationale',
    'required',
  );
});

test('TOPIC_SUGGESTED: supporting_seqs > maxKnownSeq rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { ...VALID_SUGGESTED, supporting_seqs: [10, 11, 9999] },
    },
    { maxKnownSeq: 100 },
    'supporting_seqs',
    'future_or_unknown_seq',
  );
});

test('TOPIC_SUGGESTED: supporting_seqs not strictly ascending rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { ...VALID_SUGGESTED, supporting_seqs: [10, 10, 11] },
    },
    { maxKnownSeq: 100 },
    'supporting_seqs',
    'must_be_strictly_ascending',
  );
});

test('TOPIC_SUGGESTED: supporting_seqs > MAX rejected', () => {
  const seqs = Array.from({ length: MAX_SUPPORTING_SEQS + 1 }, (_, i) => i + 1);
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { ...VALID_SUGGESTED, supporting_seqs: seqs },
    },
    { maxKnownSeq: 10_000 },
    'supporting_seqs',
    'length_out_of_range',
  );
});

test('TOPIC_SUGGESTED: name > 80 chars rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { ...VALID_SUGGESTED, name: 'x'.repeat(81) },
    },
    { maxKnownSeq: 100 },
    'name',
    'length_out_of_range',
  );
});

test('TOPIC_SUGGESTED: description with newline rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { ...VALID_SUGGESTED, description: 'line1\nline2' },
    },
    { maxKnownSeq: 100 },
    'description',
    'must_be_single_line',
  );
});

test('TOPIC_SUGGESTED: blank rationale rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { ...VALID_SUGGESTED, rationale: '   ' },
    },
    { maxKnownSeq: 100 },
    'rationale',
    'must_be_nonblank',
  );
});

test('TOPIC_SUGGESTED: source > 60 chars rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTED',
      payload: { ...VALID_SUGGESTED, source: 'x'.repeat(61) },
    },
    { maxKnownSeq: 100 },
    'source',
    'length_out_of_range',
  );
});

// ─── TOPIC_SUGGESTION_ACCEPTED ───────────────────────────────────────────────

test('TOPIC_SUGGESTION_ACCEPTED: valid payload passes', () => {
  validatePayloadForAppend(
    {
      type: 'TOPIC_SUGGESTION_ACCEPTED',
      payload: { suggestion_seq: 42, accepted_slug: 'pets' },
    },
    { maxKnownSeq: 100 },
  );
});

test('TOPIC_SUGGESTION_ACCEPTED: unknown field rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_ACCEPTED',
      payload: { suggestion_seq: 42, accepted_slug: 'pets', why: 'because' },
    },
    { maxKnownSeq: 100 },
    'why',
    'unknown_field',
  );
});

test('TOPIC_SUGGESTION_ACCEPTED: suggestion_seq > maxKnownSeq rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_ACCEPTED',
      payload: { suggestion_seq: 999, accepted_slug: 'pets' },
    },
    { maxKnownSeq: 100 },
    'suggestion_seq',
    'future_or_unknown_seq',
  );
});

test('TOPIC_SUGGESTION_ACCEPTED: invalid accepted_slug rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_ACCEPTED',
      payload: { suggestion_seq: 1, accepted_slug: 'BadSlug' },
    },
    { maxKnownSeq: 100 },
    'accepted_slug',
    'slug_regex_mismatch',
  );
});

test('TOPIC_SUGGESTION_ACCEPTED: zero suggestion_seq rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_ACCEPTED',
      payload: { suggestion_seq: 0, accepted_slug: 'pets' },
    },
    { maxKnownSeq: 100 },
    'suggestion_seq',
    'must_be_safe_positive_integer',
  );
});

// ─── TOPIC_SUGGESTION_DISMISSED ──────────────────────────────────────────────

test('TOPIC_SUGGESTION_DISMISSED: valid payload passes', () => {
  validatePayloadForAppend(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: [1, 2, 3], cooldown_days: 90 },
    },
    { maxKnownSeq: 100 },
  );
});

test('TOPIC_SUGGESTION_DISMISSED: unknown field rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: [1], cooldown_days: 90, foo: 'bar' },
    },
    { maxKnownSeq: 100 },
    'foo',
    'unknown_field',
  );
});

test('TOPIC_SUGGESTION_DISMISSED: cooldown_days < 1 rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: [1], cooldown_days: 0 },
    },
    { maxKnownSeq: 100 },
    'cooldown_days',
    'out_of_range',
  );
});

test('TOPIC_SUGGESTION_DISMISSED: cooldown_days > 365 rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: [1], cooldown_days: 400 },
    },
    { maxKnownSeq: 100 },
    'cooldown_days',
    'out_of_range',
  );
});

test('TOPIC_SUGGESTION_DISMISSED: cooldown_days non-integer rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: [1], cooldown_days: 1.5 },
    },
    { maxKnownSeq: 100 },
    'cooldown_days',
    'out_of_range',
  );
});

test('TOPIC_SUGGESTION_DISMISSED: batch > 50 rejected', () => {
  const seqs = Array.from({ length: MAX_DISMISS_BATCH + 1 }, (_, i) => i + 1);
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: seqs, cooldown_days: 90 },
    },
    { maxKnownSeq: 10_000 },
    'suggestion_seqs',
    'length_out_of_range',
  );
});

test('TOPIC_SUGGESTION_DISMISSED: reason too long rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: [1], cooldown_days: 90, reason: 'x'.repeat(121) },
    },
    { maxKnownSeq: 100 },
    'reason',
    'length_out_of_range',
  );
});

test('TOPIC_SUGGESTION_DISMISSED: reason with newline rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: [1], cooldown_days: 90, reason: 'a\nb' },
    },
    { maxKnownSeq: 100 },
    'reason',
    'must_be_single_line',
  );
});

// ─── write_event (audit follow-up) ───────────────────────────────────────────

test('write_event: valid minimal payload passes', () => {
  validatePayloadForAppend(
    { type: 'write_event', payload: { slug: 'pets', tag: 'FACT', content: 'rover loves walks' } },
    {},
  );
});

test('write_event: rejects unknown field', () => {
  expectReject(
    { type: 'write_event', payload: { slug: 'pets', tag: 'FACT', content: 'x', bogus: 1 } },
    {},
    'bogus',
    'unknown_field',
  );
});

test('write_event: rejects missing slug', () => {
  expectReject(
    { type: 'write_event', payload: { tag: 'FACT', content: 'orphan' } },
    {},
    'slug',
    'required',
  );
});

test('write_event: rejects invalid slug', () => {
  expectReject(
    { type: 'write_event', payload: { slug: 'BadSlug', tag: 'FACT', content: 'x' } },
    {},
    'slug',
    'slug_regex_mismatch',
  );
});

test('write_event: rejects missing content', () => {
  expectReject(
    { type: 'write_event', payload: { slug: 'pets', tag: 'FACT' } },
    {},
    'content',
    'required',
  );
});

test('write_event: rejects unknown tag', () => {
  expectReject(
    { type: 'write_event', payload: { slug: 'pets', tag: 'INVENTED', content: 'x' } },
    {},
    'tag',
    'unknown_tag',
  );
});

test('write_event: accepts SECURITY + CURATION tags (Jarvis fixtures use them)', () => {
  validatePayloadForAppend(
    { type: 'write_event', payload: { slug: 'pets', tag: 'SECURITY', content: 'audit note' } },
    {},
  );
  validatePayloadForAppend(
    { type: 'write_event', payload: { slug: 'pets', tag: 'CURATION', content: 'curate note' } },
    {},
  );
});

test('write_event: rejects multi-line content for event-log tags', () => {
  expectReject(
    { type: 'write_event', payload: { slug: 'pets', tag: 'FACT', content: 'line 1\nline 2' } },
    {},
    'content',
    'must_be_single_line_for_tag',
  );
  expectReject(
    { type: 'write_event', payload: { slug: 'pets', tag: 'DECISION', content: 'a\rb' } },
    {},
    'content',
    'must_be_single_line_for_tag',
  );
});

test('write_event: accepts multi-line content for CURATED + SOURCE', () => {
  // CURATED can be a whole Layer-2 section (heading + body).
  validatePayloadForAppend(
    {
      type: 'write_event',
      payload: { slug: 'pets', tag: 'CURATED', content: '## Heading\n\nbody line 1\nbody line 2' },
    },
    {},
  );
  // SOURCE is Layer-3 blockquote material.
  validatePayloadForAppend(
    {
      type: 'write_event',
      payload: { slug: 'pets', tag: 'SOURCE', content: '### 2026-05-19 — Title\n> quote\nmore text' },
    },
    {},
  );
});

test('write_event: imported.field carve-out lets multi-line FACT through (Jarvis YAML summaries)', () => {
  // The summary write from import-jarvis emits FACT content that can be a
  // multi-line YAML folded scalar. regenerate-event-log.js skips imported
  // entries, so single-line enforcement doesn't apply.
  validatePayloadForAppend(
    {
      type: 'write_event',
      payload: {
        slug: 'pets',
        tag: 'FACT',
        content: 'first line\nsecond line of folded YAML',
        imported: { source_file: 'x.md', field: 'summary' },
      },
    },
    {},
  );
});

test('write_event: rejects content over the per-tag length cap', () => {
  // Event-log tags: max 500.
  expectReject(
    { type: 'write_event', payload: { slug: 'pets', tag: 'FACT', content: 'x'.repeat(501) } },
    {},
    'content',
    'length_out_of_range',
  );
  // CURATED: max 50000.
  expectReject(
    { type: 'write_event', payload: { slug: 'pets', tag: 'CURATED', content: 'x'.repeat(50_001) } },
    {},
    'content',
    'length_out_of_range',
  );
});

test('write_event: confidence enum enforced', () => {
  validatePayloadForAppend(
    { type: 'write_event', payload: { slug: 'pets', tag: 'FACT', content: 'x', confidence: 'CONFIRMED' } },
    {},
  );
  expectReject(
    { type: 'write_event', payload: { slug: 'pets', tag: 'FACT', content: 'x', confidence: 'MAYBE' } },
    {},
    'confidence',
    'enum_violation',
  );
});

test('TOPIC_SUGGESTION_DISMISSED: seq beyond maxKnownSeq rejected', () => {
  expectReject(
    {
      type: 'TOPIC_SUGGESTION_DISMISSED',
      payload: { suggestion_seqs: [1, 200], cooldown_days: 90 },
    },
    { maxKnownSeq: 100 },
    'suggestion_seqs',
    'future_or_unknown_seq',
  );
});
