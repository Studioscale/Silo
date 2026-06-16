/**
 * `silo extract` reactive slug-existence reroute (v0.2.5 §4.8 / build-note #3).
 *
 * persistDistilledEntries re-routes an entry whose distilled slug doesn't exist
 * to `general` (visible, never silent), but ONLY for SLUG_NOT_ADMITTED — every
 * other admission error must propagate so extract fails loud.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { AdmissionError } from '../src/log/admission-error.js';
import { persistDistilledEntries } from '../src/distill/persist.js';
import { seedTopic } from './helpers/seed-topic.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-persist-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

const logFilePath = (writer) => join(writer.logDir, writer.tail().logFile);
async function breakPhysicalTail(writer) {
  const tailSeq = writer.tail().seq;
  await fs.appendFile(logFilePath(writer), JSON.stringify({
    seq: tailSeq + 1, type: 'write_event', hash_prev: '0'.repeat(64),
    principal: 'operator', intent_id: `intent:broken-${tailSeq}`, is_state_bearing: true,
    payload: { slug: 'general', tag: 'FACT', content: 'broken tail' },
    ts: '2026-04-01T12:00:00Z',
  }) + '\n');
}

test('persist: a known slug lands; a novel slug re-routes to general (visible, not silent)', async () => {
  const { writer } = await freshSilo();
  await seedTopic(writer, 'health');
  const { written, rerouted } = await persistDistilledEntries(writer, [
    { slug: 'health', tag: 'FACT', content: 'bp 120/80' },
    { slug: 'nonexistent-topic', tag: 'DECISION', content: 'chose X' },
  ], 'helder');

  assert.equal(written, 2, 'both entries are written (one rerouted)');
  assert.equal(rerouted.length, 1);
  assert.equal(rerouted[0].from, 'nonexistent-topic');

  const state = await interpret(writer);
  assert.equal(state.topic_content.get('health').length, 1);
  const general = state.topic_content.get('general') ?? [];
  assert.ok(general.some((h) => h.content === 'chose X'), 'rerouted entry landed on general');
  assert.ok(!state.topic_content.has('nonexistent-topic'), 'no junk topic was created');
});

test('persist: empty input is a no-op', async () => {
  const { writer } = await freshSilo();
  const { written, rerouted } = await persistDistilledEntries(writer, [], 'helder');
  assert.equal(written, 0);
  assert.equal(rerouted.length, 0);
});

test('persist: LOG_TAIL_NOT_INTERPRETABLE propagates — NOT silently rerouted to general (build-note #3)', async () => {
  const { writer } = await freshSilo();
  // Seed a valid entry, then forge a broken physical tail.
  await writer.append({
    type: 'write_event', isStateBearing: true, intentId: 'intent:seed',
    principal: 'helder', payload: { slug: 'general', tag: 'FACT', content: 'seed' },
  });
  await breakPhysicalTail(writer);

  // Even though the entry's slug is novel (would normally reroute), the
  // session-level tail gate fires FIRST and that error MUST propagate — a
  // catch-all reroute would silently mask log corruption.
  await assert.rejects(
    () => persistDistilledEntries(writer, [{ slug: 'novel-topic', tag: 'FACT', content: 'x' }], 'helder'),
    (e) => e instanceof AdmissionError && e.code === 'LOG_TAIL_NOT_INTERPRETABLE',
  );
});
