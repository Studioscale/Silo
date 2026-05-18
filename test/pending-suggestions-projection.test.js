/**
 * Phase 2.2 §15 step 5 — pending-suggestions projection.
 *
 * Pure-builder tests on buildPendingSuggestionsEnvelope + one end-to-end
 * regen test that confirms PENDING-SUGGESTIONS.json is written atomically
 * alongside the existing projections.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import {
  buildPendingSuggestionsEnvelope,
  PENDING_CAP,
  SCHEMA_VERSION,
} from '../src/projection/regenerate-pending-suggestions.js';
import { regenerateProjections } from '../src/projection/index.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-proj-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function seedAndSuggest(writer, slug, name, ts, seedCount = 1, source) {
  // Seed N general events first, then emit one TOPIC_SUGGESTED referencing them.
  const seedSeqs = [];
  for (let i = 0; i < seedCount; i++) {
    const r = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:seed-${slug}-${i}-${Date.now()}-${Math.random()}`,
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: `seed for ${slug} #${i}` },
      ts: new Date(Date.parse(ts) - (seedCount - i) * 1000).toISOString(),
    });
    seedSeqs.push(r.seq);
  }
  const payload = {
    slug,
    name,
    description: `desc for ${slug}`,
    supporting_seqs: seedSeqs,
    rationale: 'auto-seeded',
  };
  if (source) payload.source = source;
  return writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: `intent:sug-${slug}-${Date.now()}-${Math.random()}`,
    principal: 'topic-detector',
    payload,
    ts,
  });
}

// ─── Empty / minimal cases ───────────────────────────────────────────────────

test('envelope: empty state → count 0, cap_reached false, null detector_status', async () => {
  const { writer } = await freshSilo();
  const state = await interpret(writer);
  const env = buildPendingSuggestionsEnvelope(state, Date.parse('2026-05-18T14:00:00Z'));
  assert.equal(env.schema_version, SCHEMA_VERSION);
  assert.equal(env.count, 0);
  assert.equal(env.cap_reached, false);
  assert.equal(env.cap, PENDING_CAP);
  assert.equal(env.oldest_pending_age_days, 0);
  assert.equal(env.generated_at, '2026-05-18T14:00:00.000Z');
  assert.equal(env.detector_status.last_run_at, null);
  assert.equal(env.detector_status.last_success_at, null);
  assert.equal(env.detector_status.consecutive_failures, 0);
  assert.equal(env.detector_status.first_run_deferred, false);
  assert.deepEqual(env.suggestions, []);
});

// ─── Sorting + age calculation ───────────────────────────────────────────────

test('envelope: pending sorted oldest-first by ts; age_days from now anchor', async () => {
  const { writer } = await freshSilo();
  await seedAndSuggest(writer, 'plants', 'Plants', '2026-05-10T10:00:00Z');
  await seedAndSuggest(writer, 'pets', 'Pets', '2026-05-15T10:00:00Z');
  await seedAndSuggest(writer, 'cars', 'Cars', '2026-05-01T10:00:00Z');

  const state = await interpret(writer);
  const env = buildPendingSuggestionsEnvelope(state, Date.parse('2026-05-18T10:00:00Z'));

  assert.equal(env.count, 3);
  assert.deepEqual(
    env.suggestions.map((s) => s.slug),
    ['cars', 'plants', 'pets'],
  );
  // ages from 2026-05-18: cars=17, plants=8, pets=3
  assert.deepEqual(
    env.suggestions.map((s) => s.age_days),
    [17, 8, 3],
  );
  assert.equal(env.oldest_pending_age_days, 17);
});

// ─── Cap behavior ────────────────────────────────────────────────────────────

test('envelope: cap_reached true when pending exceeds CAP', async () => {
  const { writer } = await freshSilo();
  // Build PENDING_CAP + 1 suggestions, each with a 1-event seed.
  // ts strictly ascending so the oldest CAP are visible.
  for (let i = 0; i < PENDING_CAP + 1; i++) {
    const ts = new Date(Date.parse('2026-05-01T10:00:00Z') + i * 60_000).toISOString();
    await seedAndSuggest(writer, `slug${i + 1}`, `Name${i + 1}`, ts);
  }
  const state = await interpret(writer);
  const env = buildPendingSuggestionsEnvelope(state, Date.parse('2026-05-18T10:00:00Z'));
  assert.equal(env.count, PENDING_CAP);
  assert.equal(env.cap_reached, true);
});

// ─── Accept / dismiss removes from pending ───────────────────────────────────

test('envelope: dismissed and accepted suggestions excluded from suggestions list', async () => {
  const { writer } = await freshSilo();
  const a = await seedAndSuggest(writer, 'pets', 'Pets', '2026-05-10T10:00:00Z');
  const b = await seedAndSuggest(writer, 'plants', 'Plants', '2026-05-11T10:00:00Z');
  const c = await seedAndSuggest(writer, 'cars', 'Cars', '2026-05-12T10:00:00Z');

  // Dismiss `b`, accept `c`
  await writer.append({
    type: 'TOPIC_SUGGESTION_DISMISSED',
    isStateBearing: true,
    intentId: 'intent:d',
    principal: 'operator',
    payload: { suggestion_seqs: [b.seq], cooldown_days: 90 },
    ts: '2026-05-13T10:00:00Z',
  });
  await writer.append({
    type: 'TOPIC_SUGGESTION_ACCEPTED',
    isStateBearing: true,
    intentId: 'intent:a',
    principal: 'operator',
    payload: { suggestion_seq: c.seq, accepted_slug: 'cars' },
    ts: '2026-05-13T10:00:01Z',
  });
  const state = await interpret(writer);
  const env = buildPendingSuggestionsEnvelope(state, Date.parse('2026-05-18T10:00:00Z'));
  assert.equal(env.count, 1);
  assert.equal(env.suggestions[0].seq, a.seq);
  assert.equal(env.suggestions[0].slug, 'pets');
});

// ─── End-to-end: file written atomically by regenerateProjections ────────────

test('regenerateProjections: PENDING-SUGGESTIONS.json appears at target', async () => {
  const { dir, writer } = await freshSilo();
  await seedAndSuggest(writer, 'pets', 'Pets', '2026-05-10T10:00:00Z');

  const state = await interpret(writer);
  const targetDir = await fs.mkdtemp(join(tmpdir(), 'silo-target-'));
  const result = await regenerateProjections({ logReader: writer, state, targetDir });

  assert.equal(result.pending_suggestions, 1);

  const path = join(targetDir, 'PENDING-SUGGESTIONS.json');
  const text = await fs.readFile(path, 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.schema_version, SCHEMA_VERSION);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.suggestions[0].slug, 'pets');

  // No .tmp file left behind (atomic rename).
  const stray = await fs.readdir(targetDir);
  assert.equal(stray.some((f) => f.endsWith('.tmp')), false);
});

test('regenerateProjections: empty pending → file still written with count 0', async () => {
  const { writer } = await freshSilo();
  // Write one write_event so the regen has SOMETHING to project — but no
  // TOPIC_SUGGESTED events. Pending list should be empty.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'just an event' },
    ts: '2026-05-10T10:00:00Z',
  });
  const state = await interpret(writer);
  const targetDir = await fs.mkdtemp(join(tmpdir(), 'silo-target-'));
  await regenerateProjections({ logReader: writer, state, targetDir });
  const text = await fs.readFile(join(targetDir, 'PENDING-SUGGESTIONS.json'), 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.count, 0);
  assert.deepEqual(parsed.suggestions, []);
});

// ─── detector_status parsing ─────────────────────────────────────────────────

test('detector_status: derives last_run_at / last_success_at / consecutive_failures', async () => {
  const { writer } = await freshSilo();
  // Two cron runs — first failed (started but no complete), second succeeded.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'topic-detector',
    payload: {
      slug: 'system',
      tag: 'FACT',
      content: 'silo-detect run started (run_id=A, scope=general, days_back=30)',
      source: 'silo-topic-detector',
    },
    ts: '2026-05-10T05:00:00Z',
  });
  // No "run complete" landed (failure). New run.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:2',
    principal: 'topic-detector',
    payload: {
      slug: 'system',
      tag: 'FACT',
      content: 'silo-detect run started (run_id=B, scope=general, days_back=30)',
      source: 'silo-topic-detector',
    },
    ts: '2026-05-11T05:00:00Z',
  });
  // Second run completes.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:3',
    principal: 'topic-detector',
    payload: {
      slug: 'system',
      tag: 'FACT',
      content: 'silo-detect run complete (run_id=B, 0 suggested, 0 skipped, 0 validated)',
      source: 'silo-topic-detector',
    },
    ts: '2026-05-11T05:01:00Z',
  });

  const state = await interpret(writer);
  const env = buildPendingSuggestionsEnvelope(state, Date.parse('2026-05-18T10:00:00Z'));
  assert.equal(env.detector_status.last_run_at, '2026-05-11T05:01:00Z');
  assert.equal(env.detector_status.last_success_at, '2026-05-11T05:01:00Z');
  // First run failed; second succeeded → consecutive_failures = 0 after the success.
  assert.equal(env.detector_status.consecutive_failures, 0);
  assert.equal(env.detector_status.first_run_deferred, false);
});

test('detector_status: first_run_deferred reflected from system event', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'topic-detector',
    payload: {
      slug: 'system',
      tag: 'FACT',
      content: 'silo-detect first run deferred (general_count=120, run silo suggest --bulk-scan to onboard)',
      source: 'silo-topic-detector',
    },
    ts: '2026-05-10T05:00:00Z',
  });
  const state = await interpret(writer);
  const env = buildPendingSuggestionsEnvelope(state, Date.parse('2026-05-18T10:00:00Z'));
  assert.equal(env.detector_status.first_run_deferred, true);
  assert.equal(env.detector_status.last_run_at, '2026-05-10T05:00:00Z');
});
