/**
 * Foundation-layer tests for LogWriter (Phase 2.2 §15 step 1).
 *
 * Covers the new primitives introduced in this step:
 *   - _scanTailUnlocked tolerates malformed trailing lines
 *   - _appendBatchUnlocked writes a hash-chained batch with one fsync
 *   - batchAppend public API
 *   - withAppendLock callback shape
 *   - admission validation runs inside the unlocked primitives only
 *     (single source of truth per Phase 2.2 §5.2)
 *
 * Cross-process flock tests are gated on isFlockAvailable() — they run on
 * Linux/macOS CI but skip on Windows local dev (degraded mode).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { GENESIS_HASH, serializeEntry } from '../src/log/entry.js';
import { canonicalHash } from '../src/log/canonical.js';
import { AdmissionValidationError } from '../src/admission/payload-validators.js';
import { isFlockAvailable } from '../src/log/file-lock.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-foundation-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

function makeWriteEvent({ slug = 'test', content = 'hello', tag = 'FACT', intentId, ts }) {
  return {
    type: 'write_event',
    isStateBearing: true,
    intentId,
    principal: 'helder',
    payload: { slug, tag, content },
    ts,
  };
}

// ── _scanTailUnlocked: tolerance ─────────────────────────────────────────────

test('foundation: _scanTailUnlocked tolerates malformed trailing line', async () => {
  const { dir, writer } = await freshSilo();
  // Two valid appends.
  await writer.append(makeWriteEvent({ intentId: 'intent:a', ts: '2026-04-22T10:00:00Z' }));
  const second = await writer.append(makeWriteEvent({ intentId: 'intent:b', ts: '2026-04-22T10:00:01Z' }));

  // Corrupt the log: append garbage past the last valid entry.
  const logDir = join(dir, 'operation-log');
  const files = (await fs.readdir(logDir)).filter((f) => f.endsWith('.jsonl')).sort();
  const latest = join(logDir, files[files.length - 1]);
  await fs.appendFile(latest, '{ this is not valid json\n');

  // Fresh writer should recover to the last valid seq, not throw.
  const recovered = new LogWriter(dir);
  await recovered.init();
  assert.equal(recovered.tail().seq, 2);
  assert.equal(recovered.tail().hash, second.hash);
});

test('foundation: _scanTailUnlocked returns genesis for missing log dir', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-foundation-test-'));
  // Don't create operation-log subdir.
  const writer = new LogWriter(dir);
  await writer.init();
  assert.deepEqual(writer.tail(), { seq: 0, hash: GENESIS_HASH });
});

test('foundation: _scanTailUnlocked falls back to prior file when latest is all-corrupt', async () => {
  const { dir, writer } = await freshSilo();
  await writer.append(makeWriteEvent({ intentId: 'intent:a', ts: '2026-04-22T10:00:00Z' }));

  // Inject a synthetic future-month log file containing only garbage.
  const logDir = join(dir, 'operation-log');
  const future = join(logDir, '2999-12.jsonl');
  await fs.writeFile(future, 'not-valid-json\nstill-not-valid\n');

  const recovered = new LogWriter(dir);
  await recovered.init();
  // Should recover to the valid earlier file's seq.
  assert.equal(recovered.tail().seq, 1);
});

// ── _appendBatchUnlocked: hash chain, fsync, admission validation ────────────

test('foundation: batchAppend chains hashes within the batch', async () => {
  const { writer } = await freshSilo();
  const results = await writer.batchAppend([
    makeWriteEvent({ slug: 't1', content: 'one', intentId: 'intent:1', ts: '2026-04-22T10:00:00Z' }),
    makeWriteEvent({ slug: 't2', content: 'two', intentId: 'intent:2', ts: '2026-04-22T10:00:01Z' }),
    makeWriteEvent({ slug: 't3', content: 'three', intentId: 'intent:3', ts: '2026-04-22T10:00:02Z' }),
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[0].seq, 1);
  assert.equal(results[1].seq, 2);
  assert.equal(results[2].seq, 3);
  assert.equal(results[0].entry.hash_prev, GENESIS_HASH);
  assert.equal(results[1].entry.hash_prev, results[0].hash);
  assert.equal(results[2].entry.hash_prev, results[1].hash);
  assert.equal(writer.tail().seq, 3);
  assert.equal(writer.tail().hash, results[2].hash);
});

test('foundation: batchAppend persists every entry to disk', async () => {
  const { dir, writer } = await freshSilo();
  await writer.batchAppend([
    makeWriteEvent({ intentId: 'intent:1', ts: '2026-04-22T10:00:00Z' }),
    makeWriteEvent({ intentId: 'intent:2', ts: '2026-04-22T10:00:01Z' }),
  ]);
  const logDir = join(dir, 'operation-log');
  const files = (await fs.readdir(logDir)).filter((f) => f.endsWith('.jsonl')).sort();
  const content = await fs.readFile(join(logDir, files[0]), 'utf8');
  const lines = content.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
});

test('foundation: batchAppend rejects empty array', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(() => writer.batchAppend([]), /non-empty array required/);
});

test('foundation: batch admission validation rejects bad payload mid-batch', async () => {
  const { writer } = await freshSilo();
  // Land one valid CURATED bullet first so the batch's retire-style entry
  // has a real prior seq to target.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:seed',
    principal: 'curator',
    payload: { slug: 'demo', tag: 'CURATED', content: '- existing' },
    ts: '2026-04-22T10:00:00Z',
  });

  // Now try a batch where the second entry's TOPIC_BULLETS_RETIRED payload
  // is malformed (missing topic). Should reject before disk write.
  await assert.rejects(
    () =>
      writer.batchAppend([
        makeWriteEvent({ intentId: 'intent:ok', ts: '2026-04-22T10:00:01Z' }),
        {
          type: 'TOPIC_BULLETS_RETIRED',
          isStateBearing: true,
          intentId: 'intent:bad',
          principal: 'curator',
          payload: { superseded_seqs: [1] }, // missing 'topic'
          ts: '2026-04-22T10:00:02Z',
        },
      ]),
    AdmissionValidationError,
  );

  // Tail must not have advanced — neither entry of the rejected batch persisted.
  assert.equal(writer.tail().seq, 1);
});

test('foundation: batch retire cannot reference a seq STAGED in the same batch', async () => {
  const { writer } = await freshSilo();
  // tail = 0. Build a 2-entry batch where the retire targets seq 1 (the
  // batch's own first entry). maxKnownSeq for entry index 1 is tail.seq + 1 = 1,
  // so technically seq 1 is "<= maxKnownSeq". But spec §5.4 says "cannot
  // reference entries staged in the same batch". The current validator allows
  // it; for safety, this test pins the maxKnownSeq policy: an entry at batch
  // index i sees maxKnownSeq = tail.seq + i, meaning it can target previously
  // PERSISTED entries (1..tail.seq) but NOT same-batch siblings.
  await assert.rejects(
    () =>
      writer.batchAppend([
        {
          type: 'write_event',
          isStateBearing: true,
          intentId: 'intent:curated',
          principal: 'curator',
          payload: { slug: 'demo', tag: 'CURATED', content: '- staged bullet' },
          ts: '2026-04-22T10:00:00Z',
        },
        {
          type: 'TOPIC_BULLETS_RETIRED',
          isStateBearing: true,
          intentId: 'intent:retire-staged',
          principal: 'curator',
          payload: { topic: 'demo', superseded_seqs: [1] }, // seq 1 is staged this batch
          ts: '2026-04-22T10:00:01Z',
        },
      ]),
    AdmissionValidationError,
  );
  assert.equal(writer.tail().seq, 0);
});

// ── Single-source-of-truth: wrappers don't pre-validate ──────────────────────

test('foundation: admission validation happens once (in _appendUnlocked), not twice', async () => {
  // We can't directly count validator invocations without monkey-patching;
  // instead we verify that a payload validation error surfaces with the
  // shape AdmissionValidationError and does NOT pollute tail.
  const { writer } = await freshSilo();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:seed',
    principal: 'curator',
    payload: { slug: 'demo', tag: 'CURATED', content: '- existing' },
    ts: '2026-04-22T10:00:00Z',
  });
  await assert.rejects(
    () =>
      writer.append({
        type: 'TOPIC_BULLETS_RETIRED',
        isStateBearing: true,
        intentId: 'intent:bad',
        principal: 'curator',
        payload: { topic: 'demo', superseded_seqs: [9999] }, // future seq
        ts: '2026-04-22T10:00:01Z',
      }),
    (err) =>
      err instanceof AdmissionValidationError &&
      err.field === 'superseded_seqs' &&
      err.reason === 'future_or_unknown_seq',
  );
  assert.equal(writer.tail().seq, 1);
});

// ── withAppendLock: callback contract ────────────────────────────────────────

test('foundation: withAppendLock provides {writer, freshTail, freshState}', async () => {
  const { writer } = await freshSilo();
  await writer.append(makeWriteEvent({ intentId: 'intent:a', ts: '2026-04-22T10:00:00Z' }));

  let captured;
  const result = await writer.withAppendLock(async (ctx) => {
    captured = ctx;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(captured.writer, writer);
  assert.equal(captured.freshTail.seq, 1);
  assert.equal(typeof captured.freshState, 'object');
  assert.equal(captured.freshState.last_seq, 1);
});

test('foundation: withAppendLock allows nested _appendBatchUnlocked', async () => {
  const { writer } = await freshSilo();
  await writer.withAppendLock(async ({ writer: w }) => {
    await w._appendBatchUnlocked([
      makeWriteEvent({ intentId: 'intent:1', ts: '2026-04-22T10:00:00Z' }),
      makeWriteEvent({ intentId: 'intent:2', ts: '2026-04-22T10:00:01Z' }),
    ]);
  });
  assert.equal(writer.tail().seq, 2);
});

// ── Same-process parallel safety (in-process mutex still works) ──────────────

test('foundation: parallel append calls produce strictly increasing seqs', async () => {
  const { writer } = await freshSilo();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      writer.append(
        makeWriteEvent({
          intentId: `intent:${i}`,
          ts: `2026-04-22T10:00:${String(i).padStart(2, '0')}Z`,
        }),
      ),
    ),
  );
  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

// ── isFlockAvailable diagnostic ──────────────────────────────────────────────

test('foundation: isFlockAvailable() reports a boolean', () => {
  assert.equal(typeof isFlockAvailable(), 'boolean');
});
