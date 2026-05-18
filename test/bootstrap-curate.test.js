/**
 * Phase 2.2 §15 step 6 — bootstrap curate.
 *
 * Eligibility predicate + prompt + parser tests. Doesn't exercise the
 * CLI-level orchestration (covered when curate runs end-to-end in
 * production); focuses on the pure parts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import {
  isBootstrapEligible,
  resolveBootstrapEvents,
  buildBootstrapPrompt,
  parseBootstrapResponse,
  BOOTSTRAP_MAX_AGE_DAYS,
  SUPPORTING_SEQS_TRUNCATION,
} from '../src/curate/bootstrap.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-boot-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

/**
 * Seed N general events, then suggest+accept the topic. Returns the
 * accepted slug, the accept_seq, and the seed event seqs.
 */
async function seedSuggestAccept({ writer, slug, name = null, description = 'desc', summary = 'sum', seedCount = 3, resolvedAt = '2026-05-01T10:00:00Z' }) {
  const seedSeqs = [];
  for (let i = 0; i < seedCount; i++) {
    const r = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:seed-${slug}-${i}-${Math.random()}`,
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: `general event for ${slug} #${i}` },
      ts: '2026-04-22T10:00:00Z',
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
      name: name || slug,
      description,
      supporting_seqs: seedSeqs,
      rationale: 'auto',
    },
    ts: '2026-04-30T10:00:00Z',
  });
  // Metadata set first (real flow batches these — for tests we emit them
  // sequentially since admission validators are independent).
  await writer.append({
    type: 'TOPIC_METADATA_SET',
    isStateBearing: true,
    intentId: `intent:meta-${slug}-${Math.random()}`,
    principal: 'operator',
    payload: { topic: slug, type: 'reference', status: 'active', summary },
    ts: resolvedAt,
  });
  const acc = await writer.append({
    type: 'TOPIC_SUGGESTION_ACCEPTED',
    isStateBearing: true,
    intentId: `intent:acc-${slug}-${Math.random()}`,
    principal: 'operator',
    payload: { suggestion_seq: sug.seq, accepted_slug: slug },
    ts: resolvedAt,
  });
  return { sug, acc, seedSeqs };
}

// ─── isBootstrapEligible ─────────────────────────────────────────────────────

test('isBootstrapEligible: accepted-no-curated topic is eligible', async () => {
  const { writer } = await freshSilo();
  await seedSuggestAccept({ writer, slug: 'pets' });
  const state = await interpret(writer);
  // Now (test seam) very close to resolvedAt — well under 60 days.
  const now = Date.parse('2026-05-15T10:00:00Z');
  assert.equal(isBootstrapEligible('pets', state, now), true);
});

test('isBootstrapEligible: topic with metadata but no accepted suggestion is NOT eligible', async () => {
  const { writer } = await freshSilo();
  // Plain topic with metadata only (e.g., from import-jarvis).
  await writer.append({
    type: 'TOPIC_METADATA_SET',
    isStateBearing: true,
    intentId: 'intent:m',
    principal: 'operator',
    payload: { topic: 'imported', type: 'reference', status: 'active' },
    ts: '2026-04-22T10:00:00Z',
  });
  const state = await interpret(writer);
  assert.equal(isBootstrapEligible('imported', state), false);
});

test('isBootstrapEligible: topic with active curated bullet is NOT eligible (already bootstrapped)', async () => {
  const { writer } = await freshSilo();
  await seedSuggestAccept({ writer, slug: 'pets' });
  // Emit a CURATED bullet on the new topic.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:b',
    principal: 'curator',
    payload: { slug: 'pets', tag: 'CURATED', content: '- existing bullet', source: 'silo-curate-bootstrap' },
    ts: '2026-05-02T10:00:00Z',
  });
  const state = await interpret(writer);
  assert.equal(isBootstrapEligible('pets', state, Date.parse('2026-05-15T10:00:00Z')), false);
});

test('isBootstrapEligible: retired bullet does NOT block eligibility (bootstrap can run again post-retire)', async () => {
  // Setup: bootstrap runs, then ALL of its bullets are retired. The slug
  // is functionally "no active curated bullets again" — but the spec
  // explicitly says "ownCurated.length > 0 → false" means active-only.
  // (See isBootstrapEligible.ownCurated filter — retired_curated_seqs is
  // subtracted.) This pins that semantics.
  const { writer } = await freshSilo();
  await seedSuggestAccept({ writer, slug: 'pets' });
  const b = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:b',
    principal: 'curator',
    payload: { slug: 'pets', tag: 'CURATED', content: '- bootstrap output', source: 'silo-curate-bootstrap' },
    ts: '2026-05-02T10:00:00Z',
  });
  await writer.append({
    type: 'TOPIC_BULLETS_RETIRED',
    isStateBearing: true,
    intentId: 'intent:r',
    principal: 'curator',
    payload: { topic: 'pets', superseded_seqs: [b.seq] },
    ts: '2026-05-03T10:00:00Z',
  });
  const state = await interpret(writer);
  assert.equal(isBootstrapEligible('pets', state, Date.parse('2026-05-15T10:00:00Z')), true);
});

test('isBootstrapEligible: stale acceptance (> BOOTSTRAP_MAX_AGE_DAYS) NOT eligible', async () => {
  const { writer } = await freshSilo();
  await seedSuggestAccept({ writer, slug: 'pets', resolvedAt: '2026-01-01T10:00:00Z' });
  const state = await interpret(writer);
  // now 100 days later
  const now = Date.parse('2026-04-15T10:00:00Z');
  const age = (now - Date.parse('2026-01-01T10:00:00Z')) / 86400000;
  assert.ok(age > BOOTSTRAP_MAX_AGE_DAYS);
  assert.equal(isBootstrapEligible('pets', state, now), false);
});

test('isBootstrapEligible: --slug single-target works (state.topic_index lookup)', async () => {
  const { writer } = await freshSilo();
  await seedSuggestAccept({ writer, slug: 'pets' });
  await seedSuggestAccept({ writer, slug: 'plants' });
  const state = await interpret(writer);
  const now = Date.parse('2026-05-15T10:00:00Z');
  assert.equal(isBootstrapEligible('pets', state, now), true);
  assert.equal(isBootstrapEligible('plants', state, now), true);
  assert.equal(isBootstrapEligible('unknown-slug', state, now), false);
});

// ─── resolveBootstrapEvents ──────────────────────────────────────────────────

test('resolveBootstrapEvents: caps at SUPPORTING_SEQS_TRUNCATION most-recent (sorted by ts asc)', async () => {
  const { writer } = await freshSilo();
  // Seed 60 general events with strictly-ascending timestamps.
  const seeds = [];
  for (let i = 0; i < 60; i++) {
    const r = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:seed-${i}`,
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: `event ${i}` },
      ts: new Date(Date.parse('2026-04-01T10:00:00Z') + i * 60_000).toISOString(),
    });
    seeds.push(r.seq);
  }
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      supporting_seqs: seeds.slice(0, SUPPORTING_SEQS_TRUNCATION + 10), // 60 seqs to support 50-cap
      rationale: 'r',
    },
    ts: '2026-04-30T10:00:00Z',
  });
  const state = await interpret(writer);
  const events = resolveBootstrapEvents(seeds.slice(0, SUPPORTING_SEQS_TRUNCATION + 10), state);
  assert.equal(events.length, SUPPORTING_SEQS_TRUNCATION);
  // Sorted ascending by ts → first event should be earlier than last.
  assert.ok(events[0].ts < events[events.length - 1].ts);
});

test('resolveBootstrapEvents: drops seqs not in seq_to_event (defensive)', async () => {
  const { writer } = await freshSilo();
  // No write_events emitted yet — state.seq_to_event is empty.
  const state = await interpret(writer);
  const events = resolveBootstrapEvents([1, 2, 3], state);
  assert.equal(events.length, 0);
});

// ─── buildBootstrapPrompt ────────────────────────────────────────────────────

test('buildBootstrapPrompt: includes slug, name, summary, type, events', () => {
  const { systemPrompt, userPrompt } = buildBootstrapPrompt({
    slug: 'pets',
    name: 'Pets',
    summary: 'Health, training, routine',
    type: 'reference',
    tags: ['rover', 'walks'],
    events: [
      { seq: 1, slug: 'general', tag: 'FACT', content: 'rover loves walks', ts: '2026-04-22T10:00:00Z' },
      { seq: 2, slug: 'general', tag: 'CHANGED', content: 'rover vet appt rescheduled', ts: '2026-04-25T10:00:00Z' },
    ],
    maxBullets: 10,
  });
  assert.match(systemPrompt, /\bpets\b/);
  assert.match(systemPrompt, /\bPets\b/);
  assert.match(systemPrompt, /Health, training, routine/);
  assert.match(systemPrompt, /reference/);
  assert.match(systemPrompt, /At most 10 bullets/);
  assert.match(systemPrompt, /rover, walks/);
  assert.match(userPrompt, /rover loves walks/);
  assert.match(userPrompt, /rover vet appt rescheduled/);
});

// ─── parseBootstrapResponse ──────────────────────────────────────────────────

test('parseBootstrapResponse: NOTHING_TO_ADD literal returned as-is', () => {
  assert.equal(parseBootstrapResponse('NOTHING_TO_ADD'), 'NOTHING_TO_ADD');
  assert.equal(parseBootstrapResponse('  NOTHING_TO_ADD  '), 'NOTHING_TO_ADD');
  assert.equal(parseBootstrapResponse(''), 'NOTHING_TO_ADD');
});

test('parseBootstrapResponse: bullet lines extracted; non-bullet lines dropped', () => {
  const raw = `Here are some bullets:
- First fact about pets
- Second fact
random noise line
- Third fact
`;
  const bullets = parseBootstrapResponse(raw);
  assert.deepEqual(bullets, ['First fact about pets', 'Second fact', 'Third fact']);
});

test('parseBootstrapResponse: drops over-200-char bullets', () => {
  const raw = `- short
- ${'x'.repeat(201)}
- ok one`;
  const bullets = parseBootstrapResponse(raw);
  assert.deepEqual(bullets, ['short', 'ok one']);
});

test('parseBootstrapResponse: caps at maxBullets', () => {
  const raw = Array.from({ length: 20 }, (_, i) => `- bullet ${i + 1}`).join('\n');
  const bullets = parseBootstrapResponse(raw, 5);
  assert.equal(bullets.length, 5);
});
