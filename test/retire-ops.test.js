/**
 * `silo retire` ops tests (proposals/retire-primitive.md §8, v0.2.2).
 *
 * The CLI (`silo retire`) and the MCP `retire_bullet` tool both call into
 * src/topic-proposal/retire-ops.js. These tests exercise the shared library so
 * both surfaces inherit correctness. Projection effect is asserted via
 * interpret().retired_curated_seqs (buildLayer2 excludes exactly those seqs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import {
  retireBullet,
  filterActiveCuratedSeqs,
  RetireOpError,
  DEFAULT_PRINCIPAL,
  RETIRE_SOURCE,
} from '../src/topic-proposal/retire-ops.js';
import { seedTopic } from './helpers/seed-topic.js';
import { appendUnsafeForTest } from './helpers/append-unsafe.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-retire-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

// Append N CURATED write_events on `slug`; return their seqs (ascending).
// Creates the topic first (slug-existence guard, v0.2.5) so the CURATED writes
// are admissible. seedTopic is idempotent-safe (latest-wins metadata).
async function seedCurated(writer, { slug, bullets, principal = 'helder' }) {
  await seedTopic(writer, slug);
  const seqs = [];
  for (let i = 0; i < bullets.length; i++) {
    const r = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:seed-${slug}-${i}-${Math.random()}`,
      principal,
      payload: { slug, tag: 'CURATED', content: bullets[i] },
      ts: new Date(Date.parse('2026-04-01T10:00:00Z') + i * 60_000).toISOString(),
    });
    seqs.push(r.seq);
  }
  return seqs;
}

// Append a single write_event with an arbitrary tag; return its seq.
async function seedTagged(writer, { slug, tag, content = 'x', principal = 'helder' }) {
  await seedTopic(writer, slug);
  const r = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: `intent:tag-${slug}-${tag}-${Math.random()}`,
    principal,
    payload: { slug, tag, content },
    ts: '2026-04-01T10:00:00Z',
  });
  return r.seq;
}

const logFilePath = (writer) => join(writer.logDir, writer.tail().logFile);

// ── happy paths ──────────────────────────────────────────────────────────────

test('retire: happy path (single) — retires one bullet, leaves the other', async () => {
  const { writer } = await freshSilo();
  const [s1, s2] = await seedCurated(writer, { slug: 'pets', bullets: ['- a', '- b'] });

  const result = await retireBullet(writer, { slug: 'pets', seqs: [s1] });

  assert.equal(result.retired, true);
  assert.equal(result.count, 1);
  assert.ok(result.retired_seq > s2);
  const state = await interpret(writer);
  assert.ok(state.retired_curated_seqs.has(s1));
  assert.ok(!state.retired_curated_seqs.has(s2));
});

test('retire: emits exactly one TOPIC_BULLETS_RETIRED event', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a', '- b'] });
  const before = writer.tail().seq;

  const result = await retireBullet(writer, { slug: 'pets', seqs: [s1] });

  assert.equal(result.retired_seq, before + 1); // tail advanced by exactly 1
  // Inspect the appended entry.
  let last = null;
  for await (const { entry } of writer.readAll()) last = entry;
  assert.equal(last.type, 'TOPIC_BULLETS_RETIRED');
  assert.deepEqual(last.payload.superseded_seqs, [s1]);
  assert.equal(last.payload.source, 'silo-retire');
  assert.equal(last.payload.source, RETIRE_SOURCE);
});

test('retire: reason carried when present, omitted key when absent', async () => {
  const { writer } = await freshSilo();
  const [s1, s2] = await seedCurated(writer, { slug: 'pets', bullets: ['- a', '- b'] });

  await retireBullet(writer, { slug: 'pets', seqs: [s1], reason: 'wrong fact' });
  await retireBullet(writer, { slug: 'pets', seqs: [s2] });

  const entries = [];
  for await (const { entry } of writer.readAll()) {
    if (entry.type === 'TOPIC_BULLETS_RETIRED') entries.push(entry);
  }
  assert.equal(entries[0].payload.reason, 'wrong fact');
  assert.equal('reason' in entries[1].payload, false);
});

test('retire: multi-seq sorts + dedups into one event', async () => {
  const { writer } = await freshSilo();
  const [s1, s2, s3] = await seedCurated(writer, { slug: 'pets', bullets: ['- a', '- b', '- c'] });

  const result = await retireBullet(writer, { slug: 'pets', seqs: [s3, s1, s1] });

  assert.equal(result.count, 2);
  let last = null;
  for await (const { entry } of writer.readAll()) last = entry;
  assert.deepEqual(last.payload.superseded_seqs, [s1, s3]); // sorted + deduped
  const state = await interpret(writer);
  assert.ok(state.retired_curated_seqs.has(s1) && state.retired_curated_seqs.has(s3));
  assert.ok(!state.retired_curated_seqs.has(s2));
});

test('retire: last active bullet → empty Layer 2 is valid', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- only'] });
  await retireBullet(writer, { slug: 'pets', seqs: [s1] });
  const state = await interpret(writer);
  assert.ok(state.retired_curated_seqs.has(s1));
});

test('retire: import-shaped multiline CURATED section is one retirable event (granularity)', async () => {
  const { writer } = await freshSilo();
  const s = await seedTagged(writer, {
    slug: 'arch', tag: 'CURATED',
    content: '## Architecture\n\n- bullet a\n- bullet b',
  });
  const result = await retireBullet(writer, { slug: 'arch', seqs: [s] });
  assert.equal(result.count, 1);
  const state = await interpret(writer);
  assert.ok(state.retired_curated_seqs.has(s)); // the WHOLE section (one event) is retired
});

// ── referential pre-flight (hard errors, append nothing) ─────────────────────

test('retire: SEQ_NOT_FOUND for a nonexistent seq', async () => {
  const { writer } = await freshSilo();
  await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  const before = writer.tail().seq;
  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [99999] }),
    (e) => e instanceof RetireOpError && e.code === 'SEQ_NOT_FOUND' && /write_event/.test(e.message),
  );
  assert.equal(writer.tail().seq, before); // nothing appended
});

test('retire: SEQ_NOT_FOUND for a non-write_event seq (e.g. metadata)', async () => {
  const { writer } = await freshSilo();
  const meta = await writer.append({
    type: 'TOPIC_METADATA_SET', isStateBearing: true, intentId: 'intent:m',
    principal: 'operator', payload: { topic: 'pets', type: 'reference', status: 'active' },
    ts: '2026-04-01T10:00:00Z',
  });
  await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [meta.seq] }),
    (e) => e instanceof RetireOpError && e.code === 'SEQ_NOT_FOUND',
  );
});

test('retire: SEQ_NOT_ON_TOPIC names the real slug', async () => {
  const { writer } = await freshSilo();
  await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  const [w1] = await seedCurated(writer, { slug: 'work', bullets: ['- w'] });
  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [w1] }),
    (e) => e instanceof RetireOpError && e.code === 'SEQ_NOT_ON_TOPIC' && e.detail.found_slug === 'work',
  );
});

test('retire: SEQ_NOT_CURATED for a non-CURATED tag', async () => {
  const { writer } = await freshSilo();
  const f = await seedTagged(writer, { slug: 'pets', tag: 'FACT', content: 'a fact' });
  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [f] }),
    (e) => e instanceof RetireOpError && e.code === 'SEQ_NOT_CURATED',
  );
});

test('retire: DECISION tag rejected (event-log retire out of scope)', async () => {
  const { writer } = await freshSilo();
  const d = await seedTagged(writer, { slug: 'pets', tag: 'DECISION', content: 'decided' });
  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [d] }),
    (e) => e instanceof RetireOpError && e.code === 'SEQ_NOT_CURATED',
  );
});

test('retire: SEQ_ALREADY_RETIRED is idempotent (tail advances by 1 total)', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  await retireBullet(writer, { slug: 'pets', seqs: [s1] });
  const afterFirst = writer.tail().seq;
  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [s1] }),
    (e) => e instanceof RetireOpError && e.code === 'SEQ_ALREADY_RETIRED',
  );
  assert.equal(writer.tail().seq, afterFirst); // no second event
});

test('retire: all-or-nothing multi-seq (one bad seq aborts the batch)', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  const before = writer.tail().seq;
  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [s1, 99999] }),
    (e) => {
      assert.ok(e instanceof RetireOpError);
      assert.equal(e.code, 'RETIRE_INVALID_SEQS');
      assert.equal(e.detail.invalid[0].seq, 99999);
      assert.equal(e.detail.invalid[0].code, 'SEQ_NOT_FOUND');
      return true;
    },
  );
  assert.equal(writer.tail().seq, before); // nothing appended; s1 NOT retired
  const state = await interpret(writer);
  assert.ok(!state.retired_curated_seqs.has(s1));
});

// ── pre-lock shape validation ────────────────────────────────────────────────

test('retire: INVALID_RETIRE_SEQ for 0 / negative / non-integer', async () => {
  const { writer } = await freshSilo();
  await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  for (const bad of [0, -1, 1.5]) {
    await assert.rejects(
      () => retireBullet(writer, { slug: 'pets', seqs: [bad] }),
      (e) => e instanceof RetireOpError && e.code === 'INVALID_RETIRE_SEQ',
    );
  }
});

test('retire: EMPTY_SEQ_SET when no seqs supplied', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [] }),
    (e) => e instanceof RetireOpError && e.code === 'EMPTY_SEQ_SET',
  );
});

test('retire: INVALID_SLUG for a malformed slug', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => retireBullet(writer, { slug: 'Bad Slug', seqs: [1] }),
    (e) => e instanceof RetireOpError && e.code === 'INVALID_SLUG',
  );
});

test('retire: INVALID_REASON for blank / too-long / multiline reason (pre-lock)', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  const before = writer.tail().seq;
  for (const bad of ['', 'a'.repeat(121), 'line1\nline2']) {
    await assert.rejects(
      () => retireBullet(writer, { slug: 'pets', seqs: [s1], reason: bad }),
      (e) => e instanceof RetireOpError && e.code === 'INVALID_REASON',
    );
  }
  assert.equal(writer.tail().seq, before); // no event appended for any
});

// ── tail-safety gate (changelog #4, option b) ────────────────────────────────

test('retire: tail-gate ALLOWS across a historical MIDDLE break (re-synced tail)', async () => {
  const { writer } = await freshSilo();
  const [s1, s2] = await seedCurated(writer, { slug: 'pets', bullets: ['- a', '- b'] });

  // Capture the valid tail (seed2) BEFORE poking internals.
  const seed2seq = writer.tail().seq;
  const h2 = writer.tail().hash; // canonicalHash(seed2)
  const lf = logFilePath(writer);

  // Insert a broken MIDDLE line (shape-valid, wrong hash_prev → hash_chain_break).
  await fs.appendFile(lf, JSON.stringify({
    seq: seed2seq + 1, type: 'write_event', hash_prev: '0'.repeat(64),
    principal: 'operator', intent_id: 'intent:broken-middle', is_state_bearing: true,
    payload: { slug: 'pets', tag: 'CURATED', content: '- broken middle (skipped)' },
    ts: '2026-04-01T12:00:00Z',
  }) + '\n');

  // Append a re-syncing valid tail that chains back to seed2 (NOT to the broken
  // middle): point _tail at {seq of the broken line, hash of seed2}.
  writer._tail = { seq: seed2seq + 1, hash: h2, logFile: writer.tail().logFile };
  // Build the re-syncing tail via the unsafe helper: it chains onto the
  // manually-set _tail exactly as _appendBatchUnlocked would (same seq + hash),
  // but skips the guard/tail-gate — this line is SCAFFOLDING to forge the
  // re-synced state, not the unit under test (retireBullet's gate is).
  await appendUnsafeForTest(writer, {
    type: 'write_event', isStateBearing: true, intentId: 'intent:resync-tail',
    principal: 'operator', payload: { slug: 'pets', tag: 'CURATED', content: '- resync tail' },
  });

  // Sanity: a break is present but the physical tail is folded.
  const pre = await interpret(writer);
  assert.ok(pre.skipped.some((s) => s.reason === 'hash_chain_break'));
  assert.equal(pre.last_seq, seed2seq + 2); // re-synced tail folded

  // Retire a real bullet → succeeds despite the historical middle break.
  const result = await retireBullet(writer, { slug: 'pets', seqs: [s1] });
  assert.equal(result.retired, true);
  const post = await interpret(writer);
  assert.ok(post.retired_curated_seqs.has(s1));
});

test('retire: tail-gate REFUSES on a broken physical tail (hash_chain_break)', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a', '- b'] });
  const tailSeq = writer.tail().seq;
  await fs.appendFile(logFilePath(writer), JSON.stringify({
    seq: tailSeq + 1, type: 'write_event', hash_prev: '0'.repeat(64),
    principal: 'operator', intent_id: 'intent:bad-tail', is_state_bearing: true,
    payload: { slug: 'pets', tag: 'CURATED', content: '- broken tail' },
    ts: '2026-04-01T12:00:00Z',
  }) + '\n');

  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [s1] }),
    (e) => e instanceof RetireOpError && e.code === 'LOG_INTEGRITY_UNSAFE'
      && e.detail.tail_seq === tailSeq + 1 && e.detail.last_seq === tailSeq,
  );
  const state = await interpret(writer);
  assert.equal(state.retired_curated_seqs.size, 0); // nothing retired
});

test('retire: tail-gate REFUSES on a shape-malformed tail (superset of hash-break check)', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a', '- b'] });
  const tailSeq = writer.tail().seq;
  // Parses + seq>=1 (so _scanTailUnlocked accepts) but MISSING principal (so
  // interpret's validateEntryShape rejects → malformed_entry_shape, never a
  // hash_chain_break). A hash_chain_break-only guard would MISS this; (B) catches it.
  await fs.appendFile(logFilePath(writer), JSON.stringify({
    seq: tailSeq + 1, type: 'write_event', hash_prev: 'a'.repeat(64),
    intent_id: 'intent:malformed-tail', is_state_bearing: true,
    payload: { slug: 'pets', tag: 'CURATED', content: '- malformed tail' },
    ts: '2026-04-01T12:00:00Z',
  }) + '\n');

  await assert.rejects(
    () => retireBullet(writer, { slug: 'pets', seqs: [s1] }),
    (e) => e instanceof RetireOpError && e.code === 'LOG_INTEGRITY_UNSAFE',
  );
});

// ── recovery, atomicity, principal, end-to-end fold ──────────────────────────

test('retire: recovery via re-curate (no UNRETIRE) — a new CURATED write reappears', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  await retireBullet(writer, { slug: 'pets', seqs: [s1] });
  const [s2] = await seedCurated(writer, { slug: 'pets', bullets: ['- a again'] });
  const state = await interpret(writer);
  assert.ok(state.retired_curated_seqs.has(s1));
  assert.ok(!state.retired_curated_seqs.has(s2)); // new seq never retired
});

test('retire: emitted event survives a full interpret() fold (not skipped)', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  const result = await retireBullet(writer, { slug: 'pets', seqs: [s1] });
  const state = await interpret(writer);
  assert.ok(state.retired_curated_seqs.has(s1));
  assert.ok(!state.skipped.some((s) => s.seq === result.retired_seq));
});

test('retire: TOCTOU — concurrent retires on the same seq → exactly one wins', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  const settled = await Promise.allSettled([
    retireBullet(writer, { slug: 'pets', seqs: [s1] }),
    retireBullet(writer, { slug: 'pets', seqs: [s1] }),
  ]);
  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  const rejected = settled.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'SEQ_ALREADY_RETIRED');
});

// ── §B1: cmdCurate no-op-retire suppression (filterActiveCuratedSeqs) ────────

test('§B1 filter: drops already-retired seqs, keeps active, preserves order', async () => {
  const { writer } = await freshSilo();
  const [s1, s2, s3] = await seedCurated(writer, { slug: 'pets', bullets: ['- a', '- b', '- c'] });

  // Simulate the race: a manual retire of s2 lands after curate's pre-lock read.
  await retireBullet(writer, { slug: 'pets', seqs: [s2] });
  const freshState = await interpret(writer);

  // curate's resolved (ascending) supersededSeqs still includes s2.
  assert.deepEqual(filterActiveCuratedSeqs(freshState, 'pets', [s1, s2, s3]), [s1, s3]);
  // A FACT seq (non-CURATED) is also dropped.
  const f = await seedTagged(writer, { slug: 'pets', tag: 'FACT', content: 'x' });
  const fs2 = await interpret(writer);
  assert.deepEqual(filterActiveCuratedSeqs(fs2, 'pets', [s1, f, s3]), [s1, s3]);
});

test('§B1 filter: all candidates already retired → empty (cmdCurate appends nothing)', async () => {
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  await retireBullet(writer, { slug: 'pets', seqs: [s1] });
  const freshState = await interpret(writer);
  assert.deepEqual(filterActiveCuratedSeqs(freshState, 'pets', [s1]), []);
});

test('retire: default principal is "operator" and is applied to the event', async () => {
  assert.equal(DEFAULT_PRINCIPAL, 'operator');
  const { writer } = await freshSilo();
  const [s1] = await seedCurated(writer, { slug: 'pets', bullets: ['- a'] });
  await retireBullet(writer, { slug: 'pets', seqs: [s1] });
  let last = null;
  for await (const { entry } of writer.readAll()) last = entry;
  assert.equal(last.principal, 'operator');
});
