/**
 * Phase 2.2 §15 step 8 — suggestion-ops accept/dismiss tests.
 *
 * The CLI (silo suggest --accept/--dismiss) and the MCP server's
 * accept_suggestion / dismiss_suggestion tools both call into
 * src/topic-proposal/suggestion-ops.js. These tests exercise the shared
 * library so both surfaces inherit correctness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import {
  acceptSuggestion,
  dismissSuggestions,
  SuggestionOpError,
} from '../src/topic-proposal/suggestion-ops.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-ops-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function seedSuggested(writer, { slug, name = 'Auto Name', description = 'auto desc', supportingCount = 3, ts = '2026-04-22T10:00:00Z' }) {
  const seedSeqs = [];
  for (let i = 0; i < supportingCount; i++) {
    const r = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:seed-${slug}-${i}-${Math.random()}`,
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: `event ${i} for ${slug}` },
      ts: new Date(Date.parse('2026-04-01T10:00:00Z') + i * 60_000).toISOString(),
    });
    seedSeqs.push(r.seq);
  }
  const sug = await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: `intent:sug-${slug}-${Math.random()}`,
    principal: 'topic-detector',
    payload: {
      slug,
      name,
      description,
      supporting_seqs: seedSeqs,
      rationale: 'auto rationale',
    },
    ts,
  });
  return { sug, seedSeqs };
}

// ── acceptSuggestion ─────────────────────────────────────────────────────────

test('acceptSuggestion: happy path emits METADATA_SET + ACCEPTED with type/status defaults', async () => {
  const { writer } = await freshSilo();
  const { sug } = await seedSuggested(writer, { slug: 'pets' });

  const result = await acceptSuggestion(writer, { suggestion_seq: sug.seq });

  assert.equal(result.accepted, true);
  assert.equal(result.suggestion_seq, sug.seq);
  assert.equal(result.slug, 'pets');
  assert.ok(result.metadata_seq < result.accepted_seq);

  const state = await interpret(writer);
  const meta = state.topic_index.get('pets');
  assert.ok(meta);
  // CRITICAL defaults — without these regen skips the topic (round-5 F1).
  assert.equal(meta.topic_type, 'reference');
  assert.equal(meta.topic_status, 'active');
  // Bootstrap index populated for downstream curate-bootstrap.
  assert.equal(state.accepted_topic_suggestion_by_slug.get('pets'), sug.seq);
});

test('acceptSuggestion: type/status overrides honored', async () => {
  const { writer } = await freshSilo();
  const { sug } = await seedSuggested(writer, { slug: 'pets' });

  await acceptSuggestion(writer, {
    suggestion_seq: sug.seq,
    type: 'hobby',
    tags: ['rover', 'walks'],
  });

  const state = await interpret(writer);
  const meta = state.topic_index.get('pets');
  assert.equal(meta.topic_type, 'hobby');
  assert.deepEqual(meta.topic_tags, ['rover', 'walks']);
});

test('acceptSuggestion: slug override honored', async () => {
  const { writer } = await freshSilo();
  const { sug } = await seedSuggested(writer, { slug: 'pets' });

  await acceptSuggestion(writer, { suggestion_seq: sug.seq, slug: 'rover-walks' });

  const state = await interpret(writer);
  // The override slug lands in topic_index; original 'pets' should NOT.
  assert.ok(state.topic_index.get('rover-walks'));
  assert.equal(state.topic_index.get('pets')?.topic_type, undefined);
});

test('acceptSuggestion: rejects unknown suggestion_seq', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => acceptSuggestion(writer, { suggestion_seq: 999 }),
    (err) => err instanceof SuggestionOpError && err.code === 'SUGGESTION_NOT_FOUND',
  );
});

test('acceptSuggestion: rejects already-accepted suggestion (replay)', async () => {
  const { writer } = await freshSilo();
  const { sug } = await seedSuggested(writer, { slug: 'pets' });
  await acceptSuggestion(writer, { suggestion_seq: sug.seq });
  await assert.rejects(
    () => acceptSuggestion(writer, { suggestion_seq: sug.seq }),
    (err) => err instanceof SuggestionOpError && err.code === 'SUGGESTION_NOT_PENDING',
  );
});

test('acceptSuggestion: rejects slug collision with existing topic', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'TOPIC_METADATA_SET',
    isStateBearing: true,
    intentId: 'intent:m',
    principal: 'operator',
    payload: { topic: 'pets', type: 'reference', status: 'active' },
    ts: '2026-04-01T10:00:00Z',
  });
  const { sug } = await seedSuggested(writer, { slug: 'pets' });
  await assert.rejects(
    () => acceptSuggestion(writer, { suggestion_seq: sug.seq }),
    (err) => err instanceof SuggestionOpError && err.code === 'SLUG_COLLISION',
  );
});

test('acceptSuggestion: rejects supporting_seq invalid source (detector self-citation)', async () => {
  const { writer } = await freshSilo();
  // Seed a detector-sourced event under general.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:d',
    principal: 'topic-detector',
    payload: {
      slug: 'general',
      tag: 'FACT',
      content: 'detector self emit',
      source: 'silo-topic-detector',
    },
    ts: '2026-04-01T10:00:00Z',
  });
  // Hand-craft a suggestion that cites the detector's own event.
  const sug = await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      supporting_seqs: [1],
      rationale: 'r',
    },
    ts: '2026-04-22T10:00:00Z',
  });
  await assert.rejects(
    () => acceptSuggestion(writer, { suggestion_seq: sug.seq }),
    (err) => err instanceof SuggestionOpError && err.code === 'SUPPORTING_SEQ_INVALID_SOURCE',
  );
});

test('acceptSuggestion: rejects supporting_seq under non-scan slug', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'helder',
    // 'system' is a reserved sink (admissible without creation) that is NOT in
    // scan_slugs (['general']) — exactly a write_event on a non-scan slug.
    payload: { slug: 'system', tag: 'FACT', content: 'wrong slug' },
    ts: '2026-04-01T10:00:00Z',
  });
  const sug = await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      supporting_seqs: [1],
      rationale: 'r',
    },
    ts: '2026-04-22T10:00:00Z',
  });
  await assert.rejects(
    () => acceptSuggestion(writer, { suggestion_seq: sug.seq }),
    (err) => err instanceof SuggestionOpError && err.code === 'SUPPORTING_SEQ_WRONG_SLUG',
  );
});

// ── dismissSuggestions ───────────────────────────────────────────────────────

test('dismissSuggestions: single seq, default cooldown 90d', async () => {
  const { writer } = await freshSilo();
  const { sug } = await seedSuggested(writer, { slug: 'pets' });
  const result = await dismissSuggestions(writer, { suggestion_seqs: [sug.seq] });
  assert.equal(result.dismissed, true);
  assert.equal(result.count, 1);
  assert.equal(result.cooldown_days, 90);
});

test('dismissSuggestions: batch with reason persists', async () => {
  const { writer } = await freshSilo();
  const { sug: a } = await seedSuggested(writer, { slug: 'pets' });
  const { sug: b } = await seedSuggested(writer, { slug: 'plants', ts: '2026-04-23T10:00:00Z' });
  await dismissSuggestions(writer, {
    suggestion_seqs: [a.seq, b.seq],
    cooldown_days: 30,
    reason: 'too narrow',
  });
  const state = await interpret(writer);
  const petsHistory = state.dismissed_topic_suggestion_history.get('pets');
  const plantsHistory = state.dismissed_topic_suggestion_history.get('plants');
  assert.equal(petsHistory[0].cooldown_days, 30);
  assert.equal(petsHistory[0].reason, 'too narrow');
  assert.equal(plantsHistory[0].reason, 'too narrow');
});

test('dismissSuggestions: all-or-nothing rejection with structured detail', async () => {
  const { writer } = await freshSilo();
  const { sug } = await seedSuggested(writer, { slug: 'pets' });
  await assert.rejects(
    () =>
      dismissSuggestions(writer, {
        suggestion_seqs: [sug.seq, 9999],
        cooldown_days: 30,
      }),
    (err) => {
      assert.ok(err instanceof SuggestionOpError);
      assert.equal(err.code, 'DISMISS_INVALID_SEQS');
      assert.ok(Array.isArray(err.detail.invalid));
      assert.equal(err.detail.invalid[0].seq, 9999);
      assert.equal(err.detail.invalid[0].reason, 'not_found');
      return true;
    },
  );
  // Pre-check failed → no event landed.
  const state = await interpret(writer);
  assert.equal(state.topic_suggestions.get(sug.seq).status, 'pending');
});

test('dismissSuggestions: rejects empty array up front', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => dismissSuggestions(writer, { suggestion_seqs: [] }),
    (err) => err instanceof SuggestionOpError && err.code === 'INVALID_SUGGESTION_SEQS',
  );
});

test('dismissSuggestions: dedups and sorts suggestion_seqs (idempotent input shape)', async () => {
  const { writer } = await freshSilo();
  const { sug: a } = await seedSuggested(writer, { slug: 'pets' });
  const { sug: b } = await seedSuggested(writer, { slug: 'plants', ts: '2026-04-23T10:00:00Z' });
  // Pass intentionally messy input — [b, a, b, a] — ops should dedup and sort.
  const result = await dismissSuggestions(writer, {
    suggestion_seqs: [b.seq, a.seq, b.seq, a.seq],
    cooldown_days: 14,
  });
  assert.equal(result.count, 2);
});
