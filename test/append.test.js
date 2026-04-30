import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { canonicalHash } from '../src/log/canonical.js';
import { GENESIS_HASH } from '../src/log/entry.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

test('LogWriter: empty log -> tail at seq 0, genesis hash', async () => {
  const { writer } = await freshSilo();
  assert.deepEqual(writer.tail(), { seq: 0, hash: GENESIS_HASH });
});

test('LogWriter: single append yields seq 1, hash_prev = genesis', async () => {
  const { writer } = await freshSilo();
  const result = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:abc',
    principal: 'helder',
    payload: { slug: 'test', content: 'hello' },
    ts: '2026-04-22T10:00:00Z',
  });
  assert.equal(result.seq, 1);
  assert.equal(result.entry.hash_prev, GENESIS_HASH);
  assert.equal(result.hash.length, 64);
});

test('LogWriter: second append chains correctly', async () => {
  const { writer } = await freshSilo();
  const first = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:a',
    principal: 'helder',
    payload: { slug: 't1', content: 'one' },
    ts: '2026-04-22T10:00:00Z',
  });
  const second = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:b',
    principal: 'helder',
    payload: { slug: 't2', content: 'two' },
    ts: '2026-04-22T10:00:01Z',
  });
  assert.equal(second.seq, 2);
  assert.equal(second.entry.hash_prev, first.hash);
  assert.equal(writer.tail().seq, 2);
  assert.equal(writer.tail().hash, second.hash);
});

test('LogWriter: concurrent appends serialize deterministically', async () => {
  const { writer } = await freshSilo();
  const inputs = Array.from({ length: 10 }, (_, i) => ({
    type: 'write_event',
    isStateBearing: true,
    intentId: `intent:${i}`,
    principal: 'helder',
    payload: { slug: `t${i}`, content: `content-${i}` },
    ts: `2026-04-22T10:00:${String(i).padStart(2, '0')}Z`,
  }));
  // Fire all concurrently
  const results = await Promise.all(inputs.map((i) => writer.append(i)));
  // Seqs must be contiguous 1..10
  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Final tail is seq 10
  assert.equal(writer.tail().seq, 10);
});

test('LogWriter: readAll iterates committed entries in order', async () => {
  const { writer } = await freshSilo();
  for (let i = 0; i < 5; i++) {
    await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${i}`,
      principal: 'helder',
      payload: { content: `msg-${i}` },
      ts: `2026-04-22T10:00:${String(i).padStart(2, '0')}Z`,
    });
  }
  const collected = [];
  for await (const { entry } of writer.readAll()) {
    collected.push(entry);
  }
  assert.equal(collected.length, 5);
  assert.deepEqual(
    collected.map((e) => e.seq),
    [1, 2, 3, 4, 5],
  );
});

test('LogWriter: hash chain integrity verifiable end-to-end', async () => {
  const { writer } = await freshSilo();
  for (let i = 0; i < 5; i++) {
    await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${i}`,
      principal: 'helder',
      payload: { content: `msg-${i}` },
      ts: `2026-04-22T10:00:${String(i).padStart(2, '0')}Z`,
    });
  }
  let expectedPrev = GENESIS_HASH;
  let count = 0;
  for await (const { entry } of writer.readAll()) {
    assert.equal(entry.hash_prev, expectedPrev, `seq ${entry.seq} hash_prev mismatch`);
    expectedPrev = canonicalHash(entry);
    count += 1;
  }
  assert.equal(count, 5);
});

test('LogWriter: init picks up existing log on reopen', async () => {
  const { dir, writer } = await freshSilo();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:a',
    principal: 'helder',
    payload: { content: 'before close' },
    ts: '2026-04-22T10:00:00Z',
  });
  const tailHash = writer.tail().hash;

  // New writer reopens same dir
  const writer2 = new LogWriter(dir);
  await writer2.init();
  assert.equal(writer2.tail().seq, 1);
  assert.equal(writer2.tail().hash, tailHash);

  // Append chains correctly
  const result = await writer2.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:b',
    principal: 'helder',
    payload: { content: 'after reopen' },
    ts: '2026-04-22T11:00:00Z',
  });
  assert.equal(result.seq, 2);
  assert.equal(result.entry.hash_prev, tailHash);
});
