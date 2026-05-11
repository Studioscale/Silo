import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validatePayloadForAppend,
  AdmissionValidationError,
  MAX_SUPERSEDED_SEQS,
} from '../src/admission/payload-validators.js';
import { LogWriter } from '../src/log/append.js';
import { appendUnsafeForTest } from './helpers/append-unsafe.js';

const VALID_PAYLOAD = {
  topic: 'project-alpha',
  superseded_seqs: [10, 20, 30],
  reason: 'consolidated duplicates',
  source: 'silo-curate',
};

// Helper — assert validator rejects with a specific reason code.
function assertRejects(entry, ctx, expectedField, expectedReason) {
  assert.throws(
    () => validatePayloadForAppend(entry, ctx),
    (err) => {
      assert.ok(err instanceof AdmissionValidationError, `expected AdmissionValidationError, got ${err?.constructor?.name}`);
      assert.equal(err.code, 'INVALID_EVENT_PAYLOAD');
      assert.equal(err.eventType, entry.type);
      assert.equal(err.field, expectedField, `field mismatch: ${err.field}`);
      assert.equal(err.reason, expectedReason, `reason mismatch: ${err.reason}`);
      return true;
    },
  );
}

// ─── Pass-through: other event types are not validated ────────────────────

test('admission: non-TOPIC_BULLETS_RETIRED entries pass through unchanged', () => {
  validatePayloadForAppend({ type: 'write_event', payload: { slug: 'x', tag: 'FACT', content: 'hello' } });
  validatePayloadForAppend({ type: 'TOPIC_VERIFIED', payload: { topic: 'x' } });
  validatePayloadForAppend({ type: 'PRINCIPAL_DECLARED', payload: { principal: 'foo' } });
  // No throw = pass.
});

test('admission: null or non-object entry no-ops', () => {
  validatePayloadForAppend(null);
  validatePayloadForAppend(undefined);
  validatePayloadForAppend('string');
  validatePayloadForAppend(42);
  // No throw = pass.
});

// ─── Payload-shape rejects ─────────────────────────────────────────────────

test('admission: TOPIC_BULLETS_RETIRED with null payload rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: null },
    {},
    'payload',
    'must_be_object',
  );
});

test('admission: TOPIC_BULLETS_RETIRED with array payload rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: [] },
    {},
    'payload',
    'must_be_object',
  );
});

test('admission: TOPIC_BULLETS_RETIRED with unknown field rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { ...VALID_PAYLOAD, surprise: 'foo' } },
    {},
    'surprise',
    'unknown_field',
  );
});

// ─── topic ──────────────────────────────────────────────────────────────────

test('admission: missing topic rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { superseded_seqs: [1] } },
    {},
    'topic',
    'required_nonblank_string',
  );
});

test('admission: whitespace-only topic rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: '   ', superseded_seqs: [1] } },
    {},
    'topic',
    'required_nonblank_string',
  );
});

test('admission: non-string topic rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 123, superseded_seqs: [1] } },
    {},
    'topic',
    'required_nonblank_string',
  );
});

// ─── superseded_seqs structural ─────────────────────────────────────────────

test('admission: non-array superseded_seqs rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: 'not-array' } },
    {},
    'superseded_seqs',
    'must_be_array',
  );
});

test('admission: empty superseded_seqs rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [] } },
    {},
    'superseded_seqs',
    'length_out_of_range',
  );
});

test('admission: oversize superseded_seqs (MAX+1) rejects', () => {
  const huge = Array.from({ length: MAX_SUPERSEDED_SEQS + 1 }, (_, i) => i + 1);
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: huge } },
    {},
    'superseded_seqs',
    'length_out_of_range',
  );
});

test('admission: exactly MAX_SUPERSEDED_SEQS items (boundary) passes', () => {
  const max = Array.from({ length: MAX_SUPERSEDED_SEQS }, (_, i) => i + 1);
  validatePayloadForAppend(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: max } },
    { maxKnownSeq: MAX_SUPERSEDED_SEQS },
  );
  // No throw = pass.
});

// ─── superseded_seqs items ──────────────────────────────────────────────────

test('admission: float item rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1.5] } },
    {},
    'superseded_seqs',
    'item_must_be_safe_positive_integer',
  );
});

test('admission: string item rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: ['1'] } },
    {},
    'superseded_seqs',
    'item_must_be_safe_positive_integer',
  );
});

test('admission: zero item rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [0] } },
    {},
    'superseded_seqs',
    'item_must_be_safe_positive_integer',
  );
});

test('admission: negative item rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [-1] } },
    {},
    'superseded_seqs',
    'item_must_be_safe_positive_integer',
  );
});

test('admission: unsafe-integer item rejects', () => {
  // Number.isInteger(1e20) is true; Number.isSafeInteger(1e20) is false.
  // Phase 2.1 (Claude Finding 1, ChatGPT Finding 4): JCS canonicalization can
  // silently lose precision on unsafe ints, breaking hash-chain integrity.
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1e20] } },
    {},
    'superseded_seqs',
    'item_must_be_safe_positive_integer',
  );
});

test('admission: NaN item rejects', () => {
  // NaN is not a safe integer.
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [NaN] } },
    {},
    'superseded_seqs',
    'item_must_be_safe_positive_integer',
  );
});

// ─── superseded_seqs ordering ───────────────────────────────────────────────

test('admission: duplicate adjacent items rejects', () => {
  // Tests strict-ascending separately from uniqueness — duplicate seqs
  // violate strict ascending (s <= prev fails on equal).
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [5, 5] } },
    {},
    'superseded_seqs',
    'must_be_strictly_ascending',
  );
});

test('admission: non-adjacent duplicate rejects', () => {
  // Duplicate non-adjacent — e.g., [1, 5, 3, 5]: 3 < 5 fails ascending first.
  // Use [1, 3, 5, 3] — 3 after 5 violates ascending.
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1, 3, 5, 3] } },
    {},
    'superseded_seqs',
    'must_be_strictly_ascending',
  );
});

test('admission: out-of-order distinct items rejects', () => {
  // [3, 1, 2]: 1 after 3 fails ascending (s=1 <= prev=3).
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [3, 1, 2] } },
    {},
    'superseded_seqs',
    'must_be_strictly_ascending',
  );
});

// ─── maxKnownSeq (prior-seq sanity) ─────────────────────────────────────────

test('admission: superseded_seqs item > maxKnownSeq rejects', () => {
  // Phase 2.1: retire cannot reference future/uncommitted seqs.
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [10, 100] } },
    { maxKnownSeq: 50 },
    'superseded_seqs',
    'future_or_unknown_seq',
  );
});

test('admission: superseded_seqs all <= maxKnownSeq passes', () => {
  validatePayloadForAppend(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1, 2, 50] } },
    { maxKnownSeq: 50 },
  );
  // No throw = pass.
});

test('admission: maxKnownSeq omitted skips the prior-seq check', () => {
  // If ctx.maxKnownSeq is undefined, the future-seq check is skipped.
  // (Useful for emitters that can't easily know the writer's tail.)
  validatePayloadForAppend(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [999999] } },
    {},
  );
});

// ─── reason ─────────────────────────────────────────────────────────────────

test('admission: missing reason passes (optional)', () => {
  validatePayloadForAppend(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1] } },
    { maxKnownSeq: 1 },
  );
});

test('admission: empty-string reason rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1], reason: '' } },
    { maxKnownSeq: 1 },
    'reason',
    'must_be_nonblank_one_line_string_lte_120_chars',
  );
});

test('admission: whitespace-only reason rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1], reason: '   \t  ' } },
    { maxKnownSeq: 1 },
    'reason',
    'must_be_nonblank_one_line_string_lte_120_chars',
  );
});

test('admission: too-long reason rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1], reason: 'a'.repeat(121) } },
    { maxKnownSeq: 1 },
    'reason',
    'must_be_nonblank_one_line_string_lte_120_chars',
  );
});

test('admission: multi-line reason rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1], reason: 'a\nb' } },
    { maxKnownSeq: 1 },
    'reason',
    'must_be_nonblank_one_line_string_lte_120_chars',
  );
});

test('admission: carriage-return in reason rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1], reason: 'a\rb' } },
    { maxKnownSeq: 1 },
    'reason',
    'must_be_nonblank_one_line_string_lte_120_chars',
  );
});

test('admission: valid one-line reason passes', () => {
  validatePayloadForAppend(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1], reason: 'port changed to 9090' } },
    { maxKnownSeq: 1 },
  );
});

// ─── source field ───────────────────────────────────────────────────────────

test('admission: non-string source rejects', () => {
  assertRejects(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1], source: 123 } },
    { maxKnownSeq: 1 },
    'source',
    'must_be_string',
  );
});

test('admission: valid source passes', () => {
  validatePayloadForAppend(
    { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [1], source: 'silo-curate' } },
    { maxKnownSeq: 1 },
  );
});

// ─── Full valid payload ────────────────────────────────────────────────────

test('admission: valid full payload passes', () => {
  validatePayloadForAppend(
    { type: 'TOPIC_BULLETS_RETIRED', payload: VALID_PAYLOAD },
    { maxKnownSeq: 30 },
  );
});

// ─── Integration with LogWriter ────────────────────────────────────────────

test('admission: LogWriter.append rejects invalid TOPIC_BULLETS_RETIRED', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-admit-'));
  const writer = new LogWriter(dir);
  await writer.init();

  await assert.rejects(
    writer.append({
      type: 'TOPIC_BULLETS_RETIRED',
      isStateBearing: true,
      intentId: 'intent:bad',
      principal: 'curator',
      payload: { topic: 'x', superseded_seqs: [] }, // empty array
      ts: '2026-04-22T10:00:00Z',
    }),
    (err) => {
      assert.ok(err instanceof AdmissionValidationError);
      assert.equal(err.field, 'superseded_seqs');
      assert.equal(err.reason, 'length_out_of_range');
      return true;
    },
  );
});

test('admission: LogWriter.append accepts valid TOPIC_BULLETS_RETIRED', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-admit-'));
  const writer = new LogWriter(dir);
  await writer.init();

  // Seed a CURATED write_event first so superseded_seqs has a valid target.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:w1',
    principal: 'curator',
    payload: { slug: 'project-alpha', tag: 'CURATED', content: '- bullet' },
    ts: '2026-04-22T10:00:00Z',
  });

  const result = await writer.append({
    type: 'TOPIC_BULLETS_RETIRED',
    isStateBearing: true,
    intentId: 'intent:r1',
    principal: 'curator',
    payload: { topic: 'project-alpha', superseded_seqs: [1], reason: 'test' },
    ts: '2026-04-22T10:01:00Z',
  });
  assert.equal(result.seq, 2);
});

test('admission: LogWriter rejects retire referencing future seq', async () => {
  // Phase 2.1: a retire event's superseded_seqs cannot reference the entry
  // being written or any future seq. Pass maxKnownSeq from the writer's tail.
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-admit-'));
  const writer = new LogWriter(dir);
  await writer.init();

  await assert.rejects(
    writer.append({
      type: 'TOPIC_BULLETS_RETIRED',
      isStateBearing: true,
      intentId: 'intent:future',
      principal: 'curator',
      payload: { topic: 'x', superseded_seqs: [9999] }, // log is empty, tail.seq = 0
      ts: '2026-04-22T10:00:00Z',
    }),
    (err) => {
      assert.equal(err.field, 'superseded_seqs');
      assert.equal(err.reason, 'future_or_unknown_seq');
      return true;
    },
  );
});

test('admission: appendUnsafeForTest bypasses validation', async () => {
  // Test-only path: malformed retire events can still be appended via the
  // test helper. This is required because pre-Phase-2.1 logs may already
  // contain malformed entries, and interpret() must remain tolerant.
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-admit-'));
  const writer = new LogWriter(dir);
  await writer.init();

  const result = await appendUnsafeForTest(writer, {
    type: 'TOPIC_BULLETS_RETIRED',
    isStateBearing: true,
    intentId: 'intent:unsafe',
    principal: 'curator',
    payload: { topic: 'x', superseded_seqs: [] }, // would normally be rejected
    ts: '2026-04-22T10:00:00Z',
  });
  assert.equal(result.seq, 1);
});

// ─── Error shape ────────────────────────────────────────────────────────────

test('admission: AdmissionValidationError carries structured fields', () => {
  try {
    validatePayloadForAppend(
      { type: 'TOPIC_BULLETS_RETIRED', payload: { topic: 'x', superseded_seqs: [5, 3] } },
      { maxKnownSeq: 10 },
    );
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof AdmissionValidationError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'AdmissionValidationError');
    assert.equal(err.code, 'INVALID_EVENT_PAYLOAD');
    assert.equal(err.eventType, 'TOPIC_BULLETS_RETIRED');
    assert.equal(err.field, 'superseded_seqs');
    assert.equal(err.reason, 'must_be_strictly_ascending');
    assert.deepEqual(err.detail, { value: 3, previous: 5 });
  }
});
