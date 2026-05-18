/**
 * Phase 2.2 §14 acceptance-criteria audit tests.
 *
 * Per-step suites covered most of §14. This file closes the gaps that
 * cross step boundaries — concurrency, end-to-end bootstrap idempotency,
 * detector status event provenance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { acceptSuggestion, SuggestionOpError } from '../src/topic-proposal/suggestion-ops.js';
import { detectTopicClusters } from '../src/topic-proposal/detect.js';
import { isBootstrapEligible } from '../src/curate/bootstrap.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-acc-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function seedSuggested(writer, slug, ts = '2026-04-22T10:00:00Z') {
  const seedSeqs = [];
  for (let i = 0; i < 3; i++) {
    const r = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:seed-${slug}-${i}-${Math.random()}`,
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: `seed ${slug} ${i}` },
      ts: new Date(Date.parse(ts) - (3 - i) * 60_000).toISOString(),
    });
    seedSeqs.push(r.seq);
  }
  return await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: `intent:sug-${slug}-${Math.random()}`,
    principal: 'topic-detector',
    payload: {
      slug,
      name: slug.toUpperCase(),
      description: 'd',
      supporting_seqs: seedSeqs,
      rationale: 'r',
    },
    ts,
  });
}

// ── Same-process parallel accept_suggestion → SLUG_COLLISION ────────────────

test('§14: two parallel accepts for SAME suggestion → one wins, other SUGGESTION_NOT_PENDING', async () => {
  const { writer } = await freshSilo();
  const sug = await seedSuggested(writer, 'pets');
  const results = await Promise.allSettled([
    acceptSuggestion(writer, { suggestion_seq: sug.seq }),
    acceptSuggestion(writer, { suggestion_seq: sug.seq }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.ok(failed[0].reason instanceof SuggestionOpError);
  assert.equal(failed[0].reason.code, 'SUGGESTION_NOT_PENDING');
});

test('§14: two parallel accepts for DIFFERENT suggestions targeting SAME slug → one SLUG_COLLISION', async () => {
  const { writer } = await freshSilo();
  // Two suggestions both want slug "pets". User accepts both with the
  // SAME final slug override.
  const sugA = await seedSuggested(writer, 'pets', '2026-04-22T10:00:00Z');
  const sugB = await seedSuggested(writer, 'pet-care', '2026-04-23T10:00:00Z');
  const results = await Promise.allSettled([
    acceptSuggestion(writer, { suggestion_seq: sugA.seq, slug: 'pets' }),
    acceptSuggestion(writer, { suggestion_seq: sugB.seq, slug: 'pets' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.ok(failed[0].reason instanceof SuggestionOpError);
  assert.equal(failed[0].reason.code, 'SLUG_COLLISION');
});

// ── Bootstrap idempotency ──────────────────────────────────────────────────

test('§14: bootstrap eligibility flips false once an active CURATED bullet exists', async () => {
  const { writer } = await freshSilo();
  const sug = await seedSuggested(writer, 'pets');
  await acceptSuggestion(writer, { suggestion_seq: sug.seq });
  let state = await interpret(writer);
  const now = Date.parse('2026-04-25T10:00:00Z');
  assert.equal(isBootstrapEligible('pets', state, now), true);
  // Write one CURATED bullet (the second pass of cmdCurate would do this)
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:b',
    principal: 'curator',
    payload: {
      slug: 'pets',
      tag: 'CURATED',
      content: '- bootstrap seed bullet',
      source: 'silo-curate-bootstrap',
    },
    ts: '2026-04-25T11:00:00Z',
  });
  state = await interpret(writer);
  assert.equal(isBootstrapEligible('pets', state, now), false);
});

// ── Detector status events provenance ──────────────────────────────────────

test('§14: detector status events land under system slug with source=silo-topic-detector', async () => {
  const { writer } = await freshSilo();
  // Seed 1 event so detection runs into insufficient_events (min=3) and
  // emits a status event.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'lone event' },
    ts: '2026-04-22T10:00:00Z',
  });
  const llm = { complete: async () => ({ content: '' }) };
  await detectTopicClusters({
    writer,
    llm,
    options: { scan_slugs: ['general'], days_back: 30, min_events: 3 },
    bulkScan: true,
    now: Date.parse('2026-04-25T10:00:00Z'),
  });
  const state = await interpret(writer);
  const sysEvents = state.topic_content.get('system') ?? [];
  const detectorEvents = sysEvents.filter(
    (e) => state.seq_to_event.get(e.seq)?.source === 'silo-topic-detector',
  );
  assert.ok(detectorEvents.length > 0, 'detector emitted no status events');
  assert.ok(
    detectorEvents.some((e) => e.content.includes('insufficient events')),
    'no insufficient_events status emitted',
  );
});

// ── intent_id is audit-only, not writer-level dedup (spec §11.1) ────────────

test('§14 §11.1: duplicate intent_id does NOT trigger writer-level rejection', async () => {
  // Spec §11.1 explicitly corrects v2: writer doesn't consult dedup_witness_set
  // before writing. Duplicate intent_ids land in the log but appear in
  // state.skipped during replay (handled by interpret's recordDedup).
  // For Phase 2.2, the relevant dedup mechanism is lock-scoped freshness:
  // detection's identical-fingerprint proposals get rejected by the
  // support-overlap check, NOT by intent_id collision.
  const { writer } = await freshSilo();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:duplicate-id',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'first' },
    ts: '2026-04-22T10:00:00Z',
  });
  // Same intent_id — writer accepts it (intent_id is audit/correlation).
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:duplicate-id',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'second' },
    ts: '2026-04-22T10:00:01Z',
  });
  const state = await interpret(writer);
  assert.equal(state.last_seq, 2, 'both events should land in the log');
});
