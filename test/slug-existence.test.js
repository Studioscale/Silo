/**
 * Write-event slug-existence guard tests — v0.2.5
 * (proposals/slug-existence-guard.md §7 test plan).
 *
 * Two layers:
 *   - UNIT: the pure helper (deriveWriteAdmissible / isSlugWriteAdmissible /
 *     guardSlugExistence) in isolation, no LogWriter.
 *   - INTEGRATION: the guard live in LogWriter's append path — bypass-closed,
 *     creation-marker, intra-batch staging, grandfathering, tail-safety gate,
 *     context lifecycle, reserved sinks, admin socket, airtight-on-omission.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { AdmissionError } from '../src/log/admission-error.js';
import {
  RESERVED_SINKS,
  deriveWriteAdmissible,
  buildAdmissionContext,
  isSlugWriteAdmissible,
  guardSlugExistence,
} from '../src/admission/slug-existence.js';
import { seedTopic } from './helpers/seed-topic.js';
import { appendUnsafeForTest } from './helpers/append-unsafe.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-slug-guard-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

function writeEvent({ slug, content = 'x', tag = 'FACT', socket, intentId, principal = 'helder', ts }) {
  const e = {
    type: 'write_event',
    isStateBearing: true,
    intentId: intentId ?? `intent:we-${slug}-${Math.random()}`,
    principal,
    payload: { slug, tag, content },
    ts,
  };
  if (socket) e.socket = socket;
  return e;
}

const metadataEvent = ({ topic, type, summary, intentId, principal = 'operator' }) => {
  const payload = { topic };
  if (type !== undefined) payload.type = type;
  if (summary !== undefined) payload.summary = summary;
  return {
    type: 'TOPIC_METADATA_SET',
    isStateBearing: true,
    intentId: intentId ?? `intent:meta-${topic}-${Math.random()}`,
    principal,
    payload,
  };
};

const logFilePath = (writer) => join(writer.logDir, writer.tail().logFile);

// Append a shape-valid line whose hash_prev is wrong → a broken PHYSICAL tail
// (interpret() skips it via hash_chain_break; _scanTailUnlocked accepts it).
async function breakPhysicalTail(writer) {
  const tailSeq = writer.tail().seq;
  await fs.appendFile(logFilePath(writer), JSON.stringify({
    seq: tailSeq + 1, type: 'write_event', hash_prev: '0'.repeat(64),
    principal: 'operator', intent_id: `intent:broken-${tailSeq}`, is_state_bearing: true,
    payload: { slug: 'general', tag: 'FACT', content: 'broken tail' },
    ts: '2026-04-01T12:00:00Z',
  }) + '\n');
  return tailSeq;
}

// ─── UNIT: deriveWriteAdmissible ─────────────────────────────────────────────

test('unit: deriveWriteAdmissible — topic_content + topic_type membership; excludes verify/curate-only + empty + sinks', () => {
  const state = {
    topic_content: new Map([
      ['has-writes', [{ seq: 1 }]],
      ['empty-history', []], // present but empty → not admissible
    ]),
    topic_index: new Map([
      ['typed', { topic_type: 'reference' }],
      ['verify-only', { slug: 'verify-only' }], // TOPIC_VERIFIED slot, no topic_type
      ['has-writes', {}],
    ]),
  };
  const set = deriveWriteAdmissible(state);
  assert.ok(set.has('has-writes'), 'a slug with topic_content is admissible');
  assert.ok(set.has('typed'), 'a slug with topic_type set is admissible');
  assert.ok(!set.has('empty-history'), 'an empty content array is not admissible');
  assert.ok(!set.has('verify-only'), 'a verify/curate-only slot is NOT admissible (bypass closed)');
  assert.ok(!set.has('general'), 'reserved sinks are NOT folded into the derived set');
});

// ─── UNIT: isSlugWriteAdmissible ─────────────────────────────────────────────

test('unit: isSlugWriteAdmissible — sinks ∪ writeAdmissible ∪ stagedAdmissible', () => {
  const ctx = {
    stateSeq: 0,
    writeAdmissible: new Set(['known']),
    stagedAdmissible: new Set(['staged']),
  };
  for (const sink of RESERVED_SINKS) assert.ok(isSlugWriteAdmissible(sink, ctx), `${sink} sink admissible`);
  assert.ok(isSlugWriteAdmissible('known', ctx));
  assert.ok(isSlugWriteAdmissible('staged', ctx));
  assert.ok(!isSlugWriteAdmissible('unknown', ctx));
});

// ─── UNIT: guardSlugExistence ────────────────────────────────────────────────

test('unit: guardSlugExistence — typed metadata stages; typeless does NOT (build-note #6)', () => {
  const ctx = buildAdmissionContext({ last_seq: 0, topic_content: new Map(), topic_index: new Map() });
  guardSlugExistence({ type: 'TOPIC_METADATA_SET', payload: { topic: 'typed', type: 'reference' } }, ctx);
  assert.ok(ctx.stagedAdmissible.has('typed'));
  guardSlugExistence({ type: 'TOPIC_METADATA_SET', payload: { topic: 'typeless', summary: 's' } }, ctx);
  assert.ok(!ctx.stagedAdmissible.has('typeless'));
});

test('unit: guardSlugExistence — admits an admissible write + stages it; rejects unknown with AdmissionError{slug,hint}', () => {
  const ctx = { stateSeq: 0, writeAdmissible: new Set(['known']), stagedAdmissible: new Set() };
  guardSlugExistence({ type: 'write_event', payload: { slug: 'known' } }, ctx); // no throw
  assert.ok(ctx.stagedAdmissible.has('known'), 'an admitted write stages its slug (grandfathering within batch)');
  assert.throws(
    () => guardSlugExistence({ type: 'write_event', payload: { slug: 'nope' } }, ctx),
    (e) => e instanceof AdmissionError
      && e.code === 'SLUG_NOT_ADMITTED'
      && e.details.slug === 'nope'
      && typeof e.details.hint === 'string',
  );
});

test('unit: guardSlugExistence — write_event with NO context is rejected (G2 airtight)', () => {
  assert.throws(
    () => guardSlugExistence({ type: 'write_event', payload: { slug: 'general' } }, null),
    (e) => e instanceof AdmissionError
      && e.code === 'SLUG_NOT_ADMITTED'
      && e.details.reason === 'admission_context_required',
  );
});

test('unit: guardSlugExistence — non-write/non-metadata events are inert', () => {
  const ctx = { stateSeq: 0, writeAdmissible: new Set(), stagedAdmissible: new Set() };
  for (const type of ['TOPIC_CURATED', 'TOPIC_VERIFIED', 'TOPIC_BULLETS_RETIRED', 'ACL_SEALED']) {
    guardSlugExistence({ type, payload: { topic: 'x' } }, ctx);
  }
  assert.equal(ctx.stagedAdmissible.size, 0);
});

// ─── INTEGRATION: guard core ─────────────────────────────────────────────────

test('guard: rejects a write_event to an unknown slug (SLUG_NOT_ADMITTED); nothing appended', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => writer.append(writeEvent({ slug: 'novel-topic' })),
    (e) => e instanceof AdmissionError && e.code === 'SLUG_NOT_ADMITTED' && e.details.slug === 'novel-topic',
  );
  assert.equal(writer.tail().seq, 0);
});

test('guard: admits a write to a write-admissible slug (created via metadata)', async () => {
  const { writer } = await freshSilo();
  await seedTopic(writer, 'pets');
  const r = await writer.append(writeEvent({ slug: 'pets', content: '- a' }));
  assert.ok(r.seq > 0);
  const state = await interpret(writer);
  assert.equal(state.topic_content.get('pets').length, 1);
});

test('guard: admits reserved sinks general + system without any creation (F1 cron sink)', async () => {
  const { writer } = await freshSilo();
  const a = await writer.append(writeEvent({ slug: 'general' }));
  const b = await writer.append(writeEvent({ slug: 'system' }));
  assert.ok(a.seq === 1 && b.seq === 2);
});

// ─── INTEGRATION: admin socket guarded (F10) ─────────────────────────────────

test('guard: the admin socket is guarded too — rejects unknown, admits admissible (F10)', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => writer.append(writeEvent({ slug: 'novel', socket: 'admin' })),
    (e) => e instanceof AdmissionError && e.code === 'SLUG_NOT_ADMITTED',
  );
  await seedTopic(writer, 'pets');
  const r = await writer.append(writeEvent({ slug: 'pets', socket: 'admin' }));
  assert.ok(r.seq > 0);
});

// ─── INTEGRATION: bypass closed (F2) ─────────────────────────────────────────

test('guard: TOPIC_CURATED{junk} then write_event(junk) is rejected (round-2 bypass closed, F2)', async () => {
  const { writer } = await freshSilo();
  // TOPIC_CURATED mints a topic_index slot but sets neither topic_content nor topic_type.
  await writer.append({
    type: 'TOPIC_CURATED', isStateBearing: true, intentId: 'intent:curated-junk',
    principal: 'curator', payload: { topic: 'junk' },
  });
  const state = await interpret(writer);
  assert.ok(state.topic_index.has('junk'), 'slot was minted');
  assert.equal(state.topic_index.get('junk').topic_type, undefined, 'but with no topic_type');
  await assert.rejects(
    () => writer.append(writeEvent({ slug: 'junk' })),
    (e) => e instanceof AdmissionError && e.code === 'SLUG_NOT_ADMITTED',
  );
});

// ─── INTEGRATION: creation marker = topic_type present (R3-D5) ────────────────

test('guard: typeless TOPIC_METADATA_SET → write rejected; a typed one → admitted (R3-D5)', async () => {
  const { writer } = await freshSilo();
  await writer.append(metadataEvent({ topic: 'foo', summary: 'a topic, no type' }));
  await assert.rejects(
    () => writer.append(writeEvent({ slug: 'foo' })),
    (e) => e instanceof AdmissionError && e.code === 'SLUG_NOT_ADMITTED',
  );
  await writer.append(metadataEvent({ topic: 'foo', type: 'reference' }));
  const r = await writer.append(writeEvent({ slug: 'foo' }));
  assert.ok(r.seq > 0);
});

// ─── INTEGRATION: intra-batch staging (F3) ───────────────────────────────────

test('guard: intra-batch [TOPIC_METADATA_SET(foo,type), write_event(foo)] is admitted (F3)', async () => {
  const { writer } = await freshSilo();
  const r = await writer.batchAppend([
    metadataEvent({ topic: 'foo', type: 'reference' }),
    writeEvent({ slug: 'foo' }),
  ]);
  assert.equal(r.length, 2);
  assert.equal(writer.tail().seq, 2);
});

test('guard: intra-batch typeless metadata does NOT admit a following write (build-note #6); atomic', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => writer.batchAppend([
      metadataEvent({ topic: 'foo', summary: 's' }),
      writeEvent({ slug: 'foo' }),
    ]),
    (e) => e instanceof AdmissionError && e.code === 'SLUG_NOT_ADMITTED',
  );
  assert.equal(writer.tail().seq, 0); // whole batch rejected, nothing persisted
});

// ─── INTEGRATION: grandfathering ─────────────────────────────────────────────

test('guard: grandfathers a pre-guard orphan (topic_content, NO topic_type) on its next write', async () => {
  const { writer } = await freshSilo();
  // Simulate a write that landed before the guard existed (no metadata).
  await appendUnsafeForTest(writer, {
    type: 'write_event', isStateBearing: true, intentId: 'intent:orphan',
    principal: 'helder', payload: { slug: 'orphan', tag: 'FACT', content: 'old' },
  });
  const before = await interpret(writer);
  assert.ok(before.topic_content.has('orphan'));
  assert.equal(before.topic_index.get('orphan')?.topic_type, undefined);
  // A normal guarded write is admitted purely via topic_content membership.
  const r = await writer.append(writeEvent({ slug: 'orphan', content: 'new' }));
  assert.ok(r.seq > 0);
});

// ─── INTEGRATION: tail-safety gate (F5 / G8 / build-note #2) ──────────────────

test('guard: tail-safety gate refuses a write_event on a broken physical tail (F5)', async () => {
  const { writer } = await freshSilo();
  await seedTopic(writer, 'pets');
  await writer.append(writeEvent({ slug: 'pets', content: '- a' }));
  const tailSeq = await breakPhysicalTail(writer);
  await assert.rejects(
    () => writer.append(writeEvent({ slug: 'pets', content: '- b' })),
    (e) => e instanceof AdmissionError
      && e.code === 'LOG_TAIL_NOT_INTERPRETABLE'
      && e.details.tail_seq === tailSeq + 1
      && e.details.last_seq === tailSeq,
  );
});

test('guard: tail-safety gate also refuses a TOPIC_METADATA_SET on a broken tail (build-note #2 — append-level)', async () => {
  const { writer } = await freshSilo();
  await writer.append(writeEvent({ slug: 'general', content: 'seed' }));
  await breakPhysicalTail(writer);
  await assert.rejects(
    () => seedTopic(writer, 'newtopic'),
    (e) => e instanceof AdmissionError && e.code === 'LOG_TAIL_NOT_INTERPRETABLE',
  );
});

test('guard: tail-safety gate is inert on a healthy tail', async () => {
  const { writer } = await freshSilo();
  await seedTopic(writer, 'pets');
  const r = await writer.append(writeEvent({ slug: 'pets', content: '- a' }));
  assert.ok(r.seq > 0);
});

// ─── INTEGRATION: context lifecycle (F7) ─────────────────────────────────────

test('guard: a slug staged in a FAILED batch does not leak into the next session (F7)', async () => {
  const { writer } = await freshSilo();
  // Batch stages 'foo' via typed metadata, then a sibling write to an unknown
  // slug fails admission → the whole batch is rejected, nothing persists.
  await assert.rejects(
    () => writer.batchAppend([
      metadataEvent({ topic: 'foo', type: 'reference' }),
      writeEvent({ slug: 'unknown-sibling' }),
    ]),
    (e) => e instanceof AdmissionError && e.code === 'SLUG_NOT_ADMITTED',
  );
  assert.equal(writer.tail().seq, 0);
  // The staged 'foo' must NOT have leaked — a fresh write to it is still rejected.
  await assert.rejects(
    () => writer.append(writeEvent({ slug: 'foo' })),
    (e) => e instanceof AdmissionError && e.code === 'SLUG_NOT_ADMITTED',
  );
});

test('guard: context is rebuilt each session — a creation in one session admits writes in the next', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => writer.append(writeEvent({ slug: 'foo' })),
    (e) => e instanceof AdmissionError && e.code === 'SLUG_NOT_ADMITTED',
  );
  await seedTopic(writer, 'foo');
  const r = await writer.append(writeEvent({ slug: 'foo' })); // fresh context sees the creation
  assert.ok(r.seq > 0);
});

// ─── INTEGRATION: airtight on context omission (G2) ───────────────────────────

test('guard: a write_event reaching _appendBatchUnlocked with NO context is rejected (G2 airtight)', async () => {
  const { writer } = await freshSilo();
  // Even a reserved sink is rejected without a context — a write_event must
  // never reach the primitive uncontexted (that would be a caller bug, not a
  // legitimate bypass).
  await assert.rejects(
    () => writer._appendBatchUnlocked([writeEvent({ slug: 'general' })]),
    (e) => e instanceof AdmissionError
      && e.code === 'SLUG_NOT_ADMITTED'
      && e.details.reason === 'admission_context_required',
  );
});
