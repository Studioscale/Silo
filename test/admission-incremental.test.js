/**
 * Incremental admission-context equivalence (perf prereq).
 *
 * LogWriter._freshAdmissionState() advances a cached folded State by the new
 * tail entries instead of re-running full interpret() on every append (the
 * O(writes × log-size) trap). These tests pin the correctness contract:
 *
 *   - the incremental path's { last_seq, write-admissible set } is ALWAYS
 *     identical to a full interpret() — across single appends, batches, and
 *     writes from a second (external) process;
 *   - the fast path is genuinely taken (the cached State object is advanced in
 *     place, not rebuilt) when the tail is healthy;
 *   - on a broken / diverged physical tail the path falls back to the
 *     authoritative full fold and the §4.2 tail-safety gate trips exactly as it
 *     would have without the cache.
 *
 * The equivalence is also structural: the advance reuses interpret()'s own
 * per-entry fold (foldStream), so it can't drift from the full fold by
 * construction. These tests guard the wiring (sealed-projection reuse vs
 * rebuild, active-month re-fold, restore/rewrite detection) around it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { deriveWriteAdmissible } from '../src/admission/slug-existence.js';
import { createTopic } from '../src/topic-proposal/topic-ops.js';
import { buildEntry, serializeEntry, GENESIS_HASH } from '../src/log/entry.js';
import { canonicalHash } from '../src/log/canonical.js';
import { AdmissionError } from '../src/log/admission-error.js';

async function freshSilo(prefix = 'silo-adm-incr-') {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

const writeEvent = (slug, content = 'x') => ({
  type: 'write_event',
  isStateBearing: true,
  intentId: `intent:we-${slug}-${Math.random()}`,
  principal: 'helder',
  payload: { slug, tag: 'FACT', content },
});

function admView(state) {
  return {
    last_seq: state.last_seq,
    admissible: [...deriveWriteAdmissible(state)].sort(),
  };
}

// The incremental path (refresh tail first, like the real locked append path),
// compared against an independent full fold of the same log.
async function assertEquivalent(writer, label) {
  writer._tail = await writer._scanTailUnlocked();
  const incremental = await writer._freshAdmissionState();
  const full = await interpret(writer);
  assert.deepEqual(admView(incremental), admView(full), `incremental ≠ full fold: ${label}`);
}

test('incremental admission == full fold across sequential appends', async () => {
  const { writer } = await freshSilo();
  await assertEquivalent(writer, 'empty');

  await writer.append(writeEvent('general', 'one'));
  await assertEquivalent(writer, 'after 1st write to general');

  await createTopic(writer, { slug: 'pets', type: 'reference' });
  await assertEquivalent(writer, 'after topic create');

  await writer.append(writeEvent('pets', '- a pet fact'));
  await assertEquivalent(writer, 'after write to created topic');

  await createTopic(writer, { slug: 'novel', type: 'project' });
  await writer.append(writeEvent('novel', '- chapter idea'));
  await writer.append(writeEvent('system', 'cron status'));
  await assertEquivalent(writer, 'after more topics + writes');
});

test('fast path reuses the sealed projection (no full re-fold) when sealed months are stable', async () => {
  const { writer } = await freshSilo();
  await writer.append(writeEvent('general', 'seed'));
  // First admission build seeds the sealed projection.
  writer._tail = await writer._scanTailUnlocked();
  const first = await writer._freshAdmissionState();
  const sealed = writer._admSealed;
  assert.ok(sealed, 'sealed projection built');
  assert.equal(first.last_seq, 1);

  // A further append must reuse the SAME sealed projection — only the active
  // month is re-folded; the sealed months are byte-stable (fast path).
  await writer.append(writeEvent('general', 'more'));
  writer._tail = await writer._scanTailUnlocked();
  const second = await writer._freshAdmissionState();
  assert.equal(writer._admSealed, sealed, 'sealed projection reused (not rebuilt) — fast path');
  assert.equal(second.last_seq, 2);
});

test('incremental admission == full fold for a batch append', async () => {
  const { writer } = await freshSilo();
  // A TOPIC_METADATA_SET(type) creation + a write to it, in one batch — the
  // creation stages admissibility for the same-batch write.
  await writer.batchAppend([
    {
      type: 'TOPIC_METADATA_SET',
      isStateBearing: true,
      intentId: `intent:meta-${Math.random()}`,
      principal: 'helder',
      payload: { topic: 'garden', type: 'reference' },
    },
    writeEvent('garden', '- tomatoes'),
  ]);
  await assertEquivalent(writer, 'after batch create+write');
  const full = await interpret(writer);
  assert.ok(deriveWriteAdmissible(full).has('garden'), 'garden admissible after batch');
});

test('incremental path absorbs writes from a second (external) process', async () => {
  const { dir, writer: a } = await freshSilo();
  await a.append(writeEvent('general', 'a-seed'));
  await assertEquivalent(a, 'A seeded'); // seeds A's cache at its tail

  // A second writer on the same dir mints a topic + writes — A's cache is now
  // stale, exactly the multi-writer case (CLI / MCP / crons) the re-fold guards.
  const b = new LogWriter(dir);
  await b.init();
  await createTopic(b, { slug: 'shared-topic', type: 'reference' });
  await b.append(writeEvent('shared-topic', '- from B'));

  // A advances its cache by reading B's new tail entries off disk.
  await assertEquivalent(a, 'A after external B writes');
  a._tail = await a._scanTailUnlocked();
  const aState = await a._freshAdmissionState();
  assert.ok(deriveWriteAdmissible(aState).has('shared-topic'), 'A sees B-created topic');
});

test('broken physical tail → admission fold stops at last good entry → tail-safety gate trips', async () => {
  const { dir, writer } = await freshSilo();
  await writer.append(writeEvent('general', 'good-1'));
  await writer.append(writeEvent('general', 'good-2'));
  // Seed the cache on the healthy log.
  writer._tail = await writer._scanTailUnlocked();
  await writer._freshAdmissionState();

  // Hand-write a VALID-JSON entry with a WRONG hash_prev → a chain break that is
  // the physical tail. _scanTailUnlocked accepts it (chain-blind); interpret()
  // skips it. So folded last_seq (2) != physical tail seq (3).
  const files = (await fs.readdir(join(dir, 'operation-log')))
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  const monthFile = files[files.length - 1];
  const broken = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: 3,
    hashPrev: '0'.repeat(64), // wrong — breaks the chain
    intentId: 'intent:broken',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'orphan' },
    ts: '2026-04-22T10:00:09Z',
  });
  await fs.appendFile(join(dir, 'operation-log', monthFile), serializeEntry(broken));

  // The next real append must refuse: the gate sees folded last_seq != tail seq.
  await assert.rejects(
    () => writer.append(writeEvent('general', 'good-3')),
    (err) => err instanceof AdmissionError && err.code === 'LOG_TAIL_NOT_INTERPRETABLE',
    'gate must trip on the orphaned tail',
  );
  // The admission fold stops at the last good entry — the orphaned tail is
  // skipped exactly as a full interpret() would, which is what drives the gate.
  writer._tail = await writer._scanTailUnlocked();
  const after = await writer._freshAdmissionState();
  assert.equal(after.last_seq, 2, 'admission fold stops at the last good entry');
  await assertEquivalent(writer, 'broken-tail admission == full fold');
});

// Build a fresh, independently-chained log on disk (genesis → ...specs),
// overwriting whatever month-files exist. Simulates a backup restore / rewrite
// of the log out from under a live LogWriter. `monthFile` defaults to the
// writer's current tail file so it lands where the original entries were.
async function restoreLog(logDir, monthFile, specs) {
  let prev = GENESIS_HASH;
  let seq = 0;
  const parts = [];
  for (const s of specs) {
    seq += 1;
    const entry = buildEntry({
      type: s.type, isStateBearing: true, seq, hashPrev: prev,
      intentId: `intent:restore-${seq}-${Math.random()}`, principal: 'helder',
      payload: s.payload, ts: '2026-06-30T00:00:00Z',
    });
    prev = canonicalHash(entry);
    parts.push(serializeEntry(entry));
  }
  for (const f of await fs.readdir(logDir)) {
    if (/^\d{4}-\d{2}\.jsonl$/.test(f)) await fs.rm(join(logDir, f));
  }
  await fs.writeFile(join(logDir, monthFile), Buffer.concat(parts));
}

test('CRITICAL: same-seq restore (different content, same tail seq) → fast path falls back, no stale timeline served', async () => {
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');

  // Timeline ONE: a write + creation of topic 'alpha'. Tail seq 2.
  await writer.append(writeEvent('general', 'one'));
  await writer.batchAppend([{
    type: 'TOPIC_METADATA_SET', isStateBearing: true,
    intentId: `intent:meta-alpha-${Math.random()}`, principal: 'helder',
    payload: { topic: 'alpha', type: 'reference' },
  }]);
  writer._tail = await writer._scanTailUnlocked();
  const monthFile = writer._tail.logFile;
  const seeded = await writer._freshAdmissionState(); // seed cache on timeline ONE
  assert.ok(deriveWriteAdmissible(seeded).has('alpha'), 'cache sees alpha');
  const oneHash = writer._tail.hash;

  // RESTORE the log to timeline TWO: SAME length and seqs (tail still seq 2) but
  // the seq-2 entry creates 'beta', not 'alpha' — same seq, DIFFERENT tail hash.
  await restoreLog(logDir, monthFile, [
    { type: 'write_event', payload: { slug: 'general', tag: 'FACT', content: 'restored' } },
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'beta', type: 'reference' } },
  ]);

  writer._tail = await writer._scanTailUnlocked();
  assert.equal(writer._tail.seq, 2, 'restored tail is still seq 2 (same-seq restore)');
  assert.notEqual(writer._tail.hash, oneHash, 'but the tail hash changed');

  // The fix: same seq but different tail hash → must NOT serve the erased
  // timeline; must re-fold authoritatively.
  const after = await writer._freshAdmissionState();
  const adm = deriveWriteAdmissible(after);
  assert.ok(adm.has('beta'), 'restored-timeline topic IS visible');
  assert.ok(!adm.has('alpha'), 'erased-timeline topic is NOT served (the bug)');
  await assertEquivalent(writer, 'after same-seq restore');
});

test('restored prefix at a HIGHER seq (different content) → fast path falls back', async () => {
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  await writer.append(writeEvent('general', 'one'));
  await writer.batchAppend([{
    type: 'TOPIC_METADATA_SET', isStateBearing: true,
    intentId: `intent:meta-alpha-${Math.random()}`, principal: 'helder',
    payload: { topic: 'alpha', type: 'reference' },
  }]);
  writer._tail = await writer._scanTailUnlocked();
  const monthFile = writer._tail.logFile;
  await writer._freshAdmissionState();

  // Restore to a LONGER, different timeline: tail seq 3, creates 'gamma'.
  await restoreLog(logDir, monthFile, [
    { type: 'write_event', payload: { slug: 'general', tag: 'FACT', content: 'r1' } },
    { type: 'write_event', payload: { slug: 'general', tag: 'FACT', content: 'r2' } },
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'gamma', type: 'reference' } },
  ]);

  writer._tail = await writer._scanTailUnlocked();
  assert.equal(writer._tail.seq, 3, 'restored tail seq advanced to 3');
  const after = await writer._freshAdmissionState();
  const adm = deriveWriteAdmissible(after);
  assert.ok(adm.has('gamma'), 'restored topic visible');
  assert.ok(!adm.has('alpha'), 'erased topic not served');
  await assertEquivalent(writer, 'after higher-seq restore');
});

test('duplicate-seq replacement under a live writer (same seq, swapped entry) → fall back', async () => {
  // A narrower restatement of the CRITICAL: a single committed entry at the tail
  // seq is replaced in place by a different one while the writer holds its cache.
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  await writer.append(writeEvent('general', 'keep'));            // seq 1
  await writer.batchAppend([{
    type: 'TOPIC_METADATA_SET', isStateBearing: true,
    intentId: `intent:p-${Math.random()}`, principal: 'helder',
    payload: { topic: 'pre', type: 'reference' },
  }]);                                                            // seq 2
  writer._tail = await writer._scanTailUnlocked();
  const monthFile = writer._tail.logFile;
  await writer._freshAdmissionState();

  // Swap the seq-2 entry for a different creation ('post'); seq 1 identical.
  await restoreLog(logDir, monthFile, [
    { type: 'write_event', payload: { slug: 'general', tag: 'FACT', content: 'keep' } },
    { type: 'TOPIC_METADATA_SET', payload: { topic: 'post', type: 'reference' } },
  ]);
  writer._tail = await writer._scanTailUnlocked();
  const after = await writer._freshAdmissionState();
  const adm = deriveWriteAdmissible(after);
  assert.ok(adm.has('post') && !adm.has('pre'), 'serves the on-disk entry, not the swapped-out one');
  await assertEquivalent(writer, 'after duplicate-seq swap');
});

test('mid-window hash-break that re-syncs to a healthy tail (prod 2026-04 shape) → advance skips the orphan, fast path holds', async () => {
  // Production /root/.silo has 17 mid-log hash-chain breaks (2026-04.jsonl, the
  // cutover seq-counter restart) that re-sync and leave a healthy tail. The
  // suite covered a *tail* break; this pins a *mid-advance-window* break — the
  // real-world class — so the §2 "17 historical breaks" invariant isn't left to
  // "by construction" (seat C).
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  const monthFile = '2026-06.jsonl';
  const e = (seq, prev, type, payload, n) => buildEntry({
    type, isStateBearing: true, seq, hashPrev: prev,
    intentId: `intent:mw-${n}`, principal: 'helder', payload, ts: '2026-06-30T00:00:00Z',
  });

  // Healthy prefix: write 'general' (seq1) + create 'good-topic' (seq2).
  const e1 = e(1, GENESIS_HASH, 'write_event', { slug: 'general', tag: 'FACT', content: 'a' }, 1);
  const h1 = canonicalHash(e1);
  const e2 = e(2, h1, 'TOPIC_METADATA_SET', { topic: 'good-topic', type: 'reference' }, 2);
  const h2 = canonicalHash(e2);
  await fs.writeFile(join(logDir, monthFile), Buffer.concat([serializeEntry(e1), serializeEntry(e2)]));

  // Seed the cache on the healthy prefix (tail = e2, seq 2).
  writer._tail = await writer._scanTailUnlocked();
  const seeded = await writer._freshAdmissionState();
  assert.equal(seeded.last_seq, 2);
  assert.ok(deriveWriteAdmissible(seeded).has('good-topic'));
  const sealedObj = writer._admSealed;

  // The break lands INSIDE the advance window:
  //   e3 (seq3): chain-broken TOPIC_METADATA_SET for 'ghost' (wrong hash_prev)
  //              → foldStream skips it, does NOT advance the chain.
  //   e4 (seq4): re-syncs by chaining onto the last GOOD entry (e2), creating
  //              'after-break'. Physical tail is healthy.
  const e3 = e(3, '0'.repeat(64), 'TOPIC_METADATA_SET', { topic: 'ghost', type: 'reference' }, 3);
  const e4 = e(4, h2, 'TOPIC_METADATA_SET', { topic: 'after-break', type: 'reference' }, 4);
  await fs.appendFile(join(logDir, monthFile), Buffer.concat([serializeEntry(e3), serializeEntry(e4)]));

  writer._tail = await writer._scanTailUnlocked();
  assert.equal(writer._tail.seq, 4, 'physical tail is the healthy e4');
  const after = await writer._freshAdmissionState();
  const adm = deriveWriteAdmissible(after);
  assert.ok(adm.has('good-topic') && adm.has('after-break'), 'pre- and post-break topics admissible');
  assert.ok(!adm.has('ghost'), 'orphaned (chain-broken) topic is NOT admissible');
  assert.equal(after.last_seq, 4, 'folded last_seq is the healthy tail');
  assert.equal(writer._admSealed, sealedObj, 'fast path TAKEN (sealed projection reused, active re-folded — not a full sealed rebuild)');
  await assertEquivalent(writer, 'after mid-window break');
});

// ── CRITICAL #2 (gauntlet round-2, ChatGPT seat; reproduced) ──────────────────
// The seq+tail-hash accept condition is NOT a complete certificate of the on-disk
// folded prefix: canonicalHash(tail) binds only the tail entry's own bytes (its
// hash_prev is stored DATA, not a re-verified link). A prefix rewrite that PRESERVES
// the tail entry byte-for-byte keeps last_seq AND tail_hash matching, so the fast
// path serves the ERASED timeline while a full interpret() skips the orphaned tail.
async function writeMonth(logDir, monthFile, entries) {
  await fs.writeFile(join(logDir, monthFile), Buffer.concat(entries.map(serializeEntry)));
}
const mkEntry = (seq, prev, type, payload, n) => buildEntry({
  type, isStateBearing: true, seq, hashPrev: prev,
  intentId: `intent:pfx-${n}`, principal: 'helder', payload, ts: '2026-06-30T00:00:00Z',
});

test('CRITICAL #2: prefix rewrite preserving the tail entry byte-for-byte → must NOT serve the erased prefix', async () => {
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  const monthFile = '2026-06.jsonl';

  const E1A = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'alpha', type: 'reference' }, 'a1');
  const H1A = canonicalHash(E1A);
  const E2A = mkEntry(2, H1A, 'write_event', { slug: 'alpha', tag: 'FACT', content: 'x' }, 'a2');
  await writeMonth(logDir, monthFile, [E1A, E2A]);

  writer._tail = await writer._scanTailUnlocked();
  const seeded = await writer._freshAdmissionState();
  assert.ok(deriveWriteAdmissible(seeded).has('alpha'), 'cache sees alpha');

  // seq1 now creates 'beta'; E2A re-written BYTE-FOR-BYTE (hash_prev still = H1A → broken link).
  const E1B = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'beta', type: 'reference' }, 'b1');
  await writeMonth(logDir, monthFile, [E1B, E2A]);

  writer._tail = await writer._scanTailUnlocked();
  assert.equal(writer._tail.seq, 2, 'tail seq unchanged');
  assert.equal(writer._tail.hash, canonicalHash(E2A), 'tail hash unchanged (tail entry byte-preserved)');

  const after = await writer._freshAdmissionState();
  const adm = deriveWriteAdmissible(after);
  assert.ok(!adm.has('alpha'), 'must NOT serve the erased timeline (the bug)');
  assert.ok(adm.has('beta'), 'serves the on-disk restored prefix');
  assert.equal(after.last_seq, 1, 'folded last_seq matches a full fold (orphaned tail skipped)');
  await assertEquivalent(writer, 'after prefix rewrite preserving tail');
});

test('CRITICAL #2 (month-floor variant): older-month rewrite, tail month untouched → must re-fold', async () => {
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  const older = '2026-05.jsonl';
  const newer = '2026-06.jsonl';

  const E1A = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'alpha', type: 'reference' }, 'm1');
  const H1A = canonicalHash(E1A);
  const E2A = mkEntry(2, H1A, 'write_event', { slug: 'alpha', tag: 'FACT', content: 'x' }, 'm2');
  await writeMonth(logDir, older, [E1A]);
  await writeMonth(logDir, newer, [E2A]);

  writer._tail = await writer._scanTailUnlocked();
  const seeded = await writer._freshAdmissionState();
  assert.ok(deriveWriteAdmissible(seeded).has('alpha'));
  assert.equal(writer._admStateMonth, newer, 'cache month-floor is the tail month');

  // Rewrite the OLDER month only: seq1 now creates a DIFFERENT-SIZE topic (so the
  // rewrite is detected by the size arm on every platform — same-size detection
  // is covered separately, and Linux-gated, by the ctime-arm test below). Newer
  // (tail) month untouched.
  const E1B = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'beta-erased-longer', type: 'reference' }, 'm1');
  await writeMonth(logDir, older, [E1B]);

  writer._tail = await writer._scanTailUnlocked();
  const after = await writer._freshAdmissionState();
  const adm = deriveWriteAdmissible(after);
  assert.ok(!adm.has('alpha'), 'must NOT serve the erased older-month prefix');
  assert.equal(after.last_seq, 1, 'full-fold-equivalent: orphaned tail skipped');
  await assertEquivalent(writer, 'after older-month rewrite under the floor');
});

test('CRITICAL #3: sealed-projection TOCTOU (fold→stat race) must not persist a stale sealed projection', async () => {
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  const may = '2026-05.jsonl', jun = '2026-06.jsonl';
  const write = (f, entries) => fs.writeFile(join(logDir, f), Buffer.concat(entries.map(serializeEntry)));
  const mk = (seq, prev, type, payload, n) => buildEntry({
    type, isStateBearing: true, seq, hashPrev: prev,
    intentId: `intent:${n}`, principal: 'helder', payload, ts: '2026-06-30T00:00:00Z' });

  const E1A = mk(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'alpha', type: 'reference' }, 'e1a');
  const H1A = canonicalHash(E1A);
  const E2A = mk(2, H1A, 'write_event', { slug: 'alpha', tag: 'FACT', content: 'x' }, 'e2a');
  await write(may, [E1A]); await write(jun, [E2A]);
  const E1B = mk(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'beta-longer', type: 'reference' }, 'e1b');

  // Inject the race: the restore of the sealed file lands right AFTER the sealed
  // handle has been read (folded), before the after-fstat — the exact TOCTOU
  // window. The atomic stat→fold→re-stat must catch it (before != after) and
  // retry, never caching bytes-A under bytes-B's fingerprint.
  const realReadHandle = writer._readHandle.bind(writer);
  let raced = false;
  writer._readHandle = async function* (fh, file) {
    yield* realReadHandle(fh, file);
    if (!raced && file === may) { raced = true; await write(may, [E1B]); }
  };
  writer._tail = await writer._scanTailUnlocked();
  await writer._freshAdmissionState();
  writer._readHandle = realReadHandle;

  writer._tail = await writer._scanTailUnlocked();
  const fast = await writer._freshAdmissionState();
  const full = await interpret(writer);
  assert.deepEqual(
    { last_seq: fast.last_seq, admissible: [...deriveWriteAdmissible(fast)].sort() },
    { last_seq: full.last_seq, admissible: [...deriveWriteAdmissible(full)].sort() },
    'sealed projection must equal a full fold after the race');
  assert.ok(!deriveWriteAdmissible(fast).has('alpha'), 'must not serve the erased sealed timeline');
});

test('sealed same-size rewrite with mtime forged via Date (sub-ms lost) → re-folds → == full fold', async () => {
  // Cross-platform. `fs.utimes` with the recorded Date restores mtime only to ms,
  // losing the sub-ms/ns fraction, so mtimeMs DIFFERS after the forge → the MTIME
  // arm detects it on both NTFS and ext4. (This does NOT isolate the ctime/ino
  // arm — see the linux-gated test below for that.) Asserts the OUTCOME.
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  const may = '2026-05.jsonl', jun = '2026-06.jsonl';
  const write = (f, entries) => fs.writeFile(join(logDir, f), Buffer.concat(entries.map(serializeEntry)));

  const E1A = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'alpha', type: 'reference' }, 'c1');
  const H1A = canonicalHash(E1A);
  const E2 = mkEntry(2, H1A, 'write_event', { slug: 'alpha', tag: 'FACT', content: 'x' }, 'c2');
  await write(may, [E1A]);
  await write(jun, [E2]);

  writer._tail = await writer._scanTailUnlocked();
  const seeded = await writer._freshAdmissionState();
  assert.ok(deriveWriteAdmissible(seeded).has('alpha'), 'seed sees alpha');
  const recorded = await fs.stat(join(logDir, may));

  // Same-length topic ('gamma' == 'alpha', 5 chars) → byte-size preserved; forge
  // mtime back via the recorded Date (ms-precision → sub-ms lost).
  const E1B = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'gamma', type: 'reference' }, 'c1');
  await write(may, [E1B]);
  assert.equal((await fs.stat(join(logDir, may))).size, recorded.size, 'byte-size preserved (the forge is meaningful)');
  await fs.utimes(join(logDir, may), recorded.atime, recorded.mtime);

  writer._tail = await writer._scanTailUnlocked();
  const fast = await writer._freshAdmissionState();
  const full = await interpret(writer);
  assert.deepEqual(
    { last_seq: fast.last_seq, admissible: [...deriveWriteAdmissible(fast)].sort() },
    { last_seq: full.last_seq, admissible: [...deriveWriteAdmissible(full)].sort() },
    'must re-fold and equal a full fold');
  assert.ok(!deriveWriteAdmissible(fast).has('alpha'), 'erased sealed timeline not served');
});

test('sealed same-size rewrite with mtime restored EXACTLY → isolates the ctime arm → == full fold', {
  // ext4 (prod): a same-size in-place rewrite bumps ctime, which is the real
  // guard when size AND mtime are held identical. On NTFS ctime does not move
  // under a same-size in-place rewrite, so this isolation can't be exercised —
  // skip off-linux (the cross-platform test above still covers the outcome).
  skip: process.platform !== 'linux' ? 'ext4 ctime isolation (NTFS ctime is static on same-size in-place rewrite)' : false,
}, async () => {
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  const may = '2026-05.jsonl', jun = '2026-06.jsonl';
  const write = (f, entries) => fs.writeFile(join(logDir, f), Buffer.concat(entries.map(serializeEntry)));
  const FIXED = 1_750_000_000; // integer epoch seconds → mtime round-trips EXACTLY

  const E1A = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'alpha', type: 'reference' }, 'x1');
  const H1A = canonicalHash(E1A);
  const E2 = mkEntry(2, H1A, 'write_event', { slug: 'alpha', tag: 'FACT', content: 'x' }, 'x2');
  await write(may, [E1A]);
  await write(jun, [E2]);
  await fs.utimes(join(logDir, may), FIXED, FIXED); // integer-ms mtime, no sub-ms fraction

  writer._tail = await writer._scanTailUnlocked();
  assert.ok(deriveWriteAdmissible(await writer._freshAdmissionState()).has('alpha'), 'seed sees alpha');
  const recorded = await fs.stat(join(logDir, may));

  // Same-size rewrite, then restore mtime to the EXACT recorded value → only
  // ctime (and ino/dev) can distinguish the timelines now.
  const E1B = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'gamma', type: 'reference' }, 'x1');
  await write(may, [E1B]);
  await fs.utimes(join(logDir, may), FIXED, FIXED);
  const reStat = await fs.stat(join(logDir, may));
  assert.equal(reStat.size, recorded.size, 'byte-size preserved');
  assert.equal(reStat.mtimeMs, recorded.mtimeMs, 'mtime restored EXACTLY (so only ctime/ino can catch it)');

  writer._tail = await writer._scanTailUnlocked();
  const fast = await writer._freshAdmissionState();
  const full = await interpret(writer);
  assert.deepEqual(
    { last_seq: fast.last_seq, admissible: [...deriveWriteAdmissible(fast)].sort() },
    { last_seq: full.last_seq, admissible: [...deriveWriteAdmissible(full)].sort() },
    'ctime arm re-folds → equals a full fold');
  assert.ok(!deriveWriteAdmissible(fast).has('alpha'), 'erased sealed timeline not served');
});

test('FIX A: a symlink sealed month file is refused (never trusted-cached); admission == full fold', async (t) => {
  // A symlink month file must be REFUSED for caching, so the CRITICAL #4
  // target-swap ABA can never reach the sealed cache. On ext4, open O_NOFOLLOW
  // throws ELOOP → refuse. On Windows (O_NOFOLLOW is a no-op), the lstat
  // path-identity check in _foldSealedOnce still catches the symlink (isFile()
  // false → retry → null). Either way _admSealed stays null and admission
  // delegates to a full fold (readAll follows the symlink → reads the live
  // target), so admission == full fold. Skipped only where symlinks are
  // unavailable (needs privilege on some Windows setups).
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  const jun = '2026-06.jsonl';
  const may = '2026-05.jsonl';           // the SEALED month — will be a symlink
  const target = 'may-target.data';      // real content, NOT a month-file name

  const E1A = mkEntry(1, GENESIS_HASH, 'TOPIC_METADATA_SET', { topic: 'alpha', type: 'reference' }, 'l1');
  const H1A = canonicalHash(E1A);
  const E2 = mkEntry(2, H1A, 'write_event', { slug: 'alpha', tag: 'FACT', content: 'x' }, 'l2');
  await fs.writeFile(join(logDir, target), serializeEntry(E1A));
  try {
    await fs.symlink(target, join(logDir, may)); // 2026-05.jsonl → may-target.data
  } catch (err) {
    t.skip(`symlinks unavailable here (${err.code})`);
    return;
  }
  await fs.writeFile(join(logDir, jun), serializeEntry(E2));

  writer._tail = await writer._scanTailUnlocked();
  const fast = await writer._freshAdmissionState();
  const full = await interpret(writer);
  assert.deepEqual(
    { last_seq: fast.last_seq, admissible: [...deriveWriteAdmissible(fast)].sort() },
    { last_seq: full.last_seq, admissible: [...deriveWriteAdmissible(full)].sort() },
    'symlink sealed month → admission delegates to a full fold');
  assert.equal(writer._admSealed, null, 'a symlink sealed month is never trusted-cached (refused)');
});

test('_readFiles streams entries only from the given month-files, in order', async () => {
  const { dir, writer } = await freshSilo();
  const logDir = join(dir, 'operation-log');
  const a = mkEntry(1, GENESIS_HASH, 'write_event', { slug: 'general', tag: 'FACT', content: 'a' }, 'rf1');
  const b = mkEntry(2, canonicalHash(a), 'write_event', { slug: 'general', tag: 'FACT', content: 'b' }, 'rf2');
  await writeMonth(logDir, '2026-05.jsonl', [a]);
  await writeMonth(logDir, '2026-06.jsonl', [b]);

  const older = [];
  for await (const { entry } of writer._readFiles(['2026-05.jsonl'])) older.push(entry.seq);
  assert.deepEqual(older, [1], 'reads only the named file');

  const both = [];
  for await (const { entry } of writer._readFiles(['2026-05.jsonl', '2026-06.jsonl'])) both.push(entry.seq);
  assert.deepEqual(both, [1, 2], 'reads the named files in order');

  const none = [];
  for await (const { entry } of writer._readFiles([])) none.push(entry.seq);
  assert.deepEqual(none, [], 'empty file list yields nothing');
});
