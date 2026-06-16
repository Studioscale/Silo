/**
 * Tests for hash-chain verification inside interpret().
 *
 * The check landed because a static audit pointed out that interpret()
 * validated entry shape but never compared entry.hash_prev against the
 * previous canonical hash — a corrupted or tampered chain replayed
 * cleanly. With the verify-on-fold pass, chain breaks land in
 * state.skipped[] with reason='hash_chain_break' and the offending
 * entry is NOT folded — protecting downstream state from poisoned
 * inputs without making interpret() throw.
 *
 * Approach: write a real silo, then forge a corrupted entry directly
 * onto disk (bypassing LogWriter) so we can verify interpret()
 * detects the break.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { canonicalHash } from '../src/log/canonical.js';
import { GENESIS_HASH, buildEntry, serializeEntry } from '../src/log/entry.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-chain-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function writeRawEntry(writer, entry) {
  // Helper that bypasses LogWriter's API and writes a hand-crafted entry
  // straight to the current month's log file. Used to forge corruption.
  const logDir = writer.logDir;
  const files = (await fs.readdir(logDir)).filter((f) => f.endsWith('.jsonl')).sort();
  let file;
  if (files.length === 0) {
    // Fresh silo with no real entries yet — derive the current month's
    // filename ourselves (matches LogWriter's `currentLogFilename`).
    const d = new Date();
    file = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
  } else {
    file = files[files.length - 1];
  }
  await fs.appendFile(join(logDir, file), serializeEntry(entry));
}

// ── Happy path: untouched log replays with no hash_chain_break ──────────────

test('interpret: clean log → no hash_chain_break entries in state.skipped', async () => {
  const { writer } = await freshSilo();
  for (let i = 0; i < 3; i++) {
    await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${i}`,
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: `event ${i}` },
      ts: `2026-05-19T10:00:${String(i).padStart(2, '0')}Z`,
    });
  }
  const state = await interpret(writer);
  const breaks = state.skipped.filter((s) => s.reason === 'hash_chain_break');
  assert.equal(breaks.length, 0);
  assert.equal(state.last_seq, 3); // 3 init events + 0 demo... actually no init in this test
});

// ── Forged break: entry with wrong hash_prev ────────────────────────────────

test('interpret: tampered hash_prev → hash_chain_break + entry NOT folded', async () => {
  const { writer } = await freshSilo();
  // Write 2 real entries.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'first' },
    ts: '2026-05-19T10:00:00Z',
  });
  const tail = writer.tail();
  // Forge a 3rd entry with a deliberately-wrong hash_prev (all zeros except
  // the last byte). buildEntry insists on a 64-char hash, so we satisfy that
  // shape but break the chain.
  const forgedHashPrev = '0'.repeat(63) + '1';
  const forged = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: tail.seq + 1,
    hashPrev: forgedHashPrev,
    intentId: 'intent:forged',
    principal: 'attacker',
    payload: { slug: 'general', tag: 'FACT', content: 'injected' },
    ts: '2026-05-19T10:00:01Z',
  });
  await writeRawEntry(writer, forged);

  const state = await interpret(writer);
  const breaks = state.skipped.filter((s) => s.reason === 'hash_chain_break');
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].seq, tail.seq + 1);
  assert.equal(breaks[0].got_hash_prev, forgedHashPrev);
  assert.equal(breaks[0].expected_hash_prev, tail.hash);
  // The forged content must NOT appear in topic_content for 'demo'.
  const demo = state.topic_content.get('general') ?? [];
  assert.equal(demo.length, 1);
  assert.equal(demo[0].content, 'first');
});

// ── Genesis chain: first entry must chain to GENESIS_HASH ────────────────────

test('interpret: first entry not chaining to genesis → hash_chain_break', async () => {
  const { writer } = await freshSilo();
  // Forge a first entry whose hash_prev is non-genesis. buildEntry requires
  // hashPrev to be a 64-char string; "ff...ff" satisfies that.
  const forged = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: 1,
    hashPrev: 'f'.repeat(64),
    intentId: 'intent:wrong-genesis',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'bad genesis' },
    ts: '2026-05-19T10:00:00Z',
  });
  await writeRawEntry(writer, forged);

  const state = await interpret(writer);
  const breaks = state.skipped.filter((s) => s.reason === 'hash_chain_break');
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].expected_hash_prev, GENESIS_HASH);
});

// ── Chain recovery: a valid entry after the corruption still folds if it
// ── correctly chains to the LAST GOOD entry (not to the corrupted one) ──────

test('interpret: valid entry after a chain break (chains to last good) is folded', async () => {
  const { writer } = await freshSilo();
  // 1 real entry.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:good1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'good 1' },
    ts: '2026-05-19T10:00:00Z',
  });
  const goodTail = writer.tail();

  // Forge a broken entry (wrong hash_prev).
  const broken = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: goodTail.seq + 1,
    hashPrev: 'd'.repeat(64),
    intentId: 'intent:broken',
    principal: 'attacker',
    payload: { slug: 'general', tag: 'FACT', content: 'injected' },
    ts: '2026-05-19T10:00:01Z',
  });
  await writeRawEntry(writer, broken);

  // Now forge a "good" entry that chains to the LAST VALID tail (skipping
  // the broken one). Use the same seq as the broken to be realistic.
  const good2 = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: goodTail.seq + 2,
    hashPrev: goodTail.hash, // chains to good1, not to the forged
    intentId: 'intent:good2',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'good 2' },
    ts: '2026-05-19T10:00:02Z',
  });
  await writeRawEntry(writer, good2);

  const state = await interpret(writer);
  const breaks = state.skipped.filter((s) => s.reason === 'hash_chain_break');
  // The broken entry is rejected; good2 is accepted (chains to good1).
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].seq, goodTail.seq + 1);
  const demo = state.topic_content.get('general') ?? [];
  assert.deepEqual(demo.map((h) => h.content), ['good 1', 'good 2']);
});

// ── Existing tail_hash semantics: still set to the LAST ACCEPTED entry's hash ──

test('interpret: tail_hash reflects last ACCEPTED entry, ignoring chain breaks', async () => {
  const { writer } = await freshSilo();
  const r = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'real' },
    ts: '2026-05-19T10:00:00Z',
  });
  // Forge a broken entry after.
  const broken = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: r.seq + 1,
    hashPrev: 'c'.repeat(64),
    intentId: 'intent:broken',
    principal: 'attacker',
    payload: { slug: 'general', tag: 'FACT', content: 'injected' },
    ts: '2026-05-19T10:00:01Z',
  });
  await writeRawEntry(writer, broken);

  const state = await interpret(writer);
  assert.equal(state.tail_hash, canonicalHash(r.entry));
  // last_seq also reflects the last folded entry's seq.
  assert.equal(state.last_seq, r.seq);
});
