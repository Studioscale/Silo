/**
 * Phase 2.2 §15 step 2 tests — state + interpret extensions.
 *
 * Covers:
 *   - 6 new state slots initialize empty
 *   - write_event fold extension populates seq_to_event
 *   - TOPIC_SUGGESTED handler
 *   - TOPIC_SUGGESTION_ACCEPTED handler (lifecycle + bootstrap index +
 *     cleared_by_accept_seq stamping with causal precision)
 *   - TOPIC_SUGGESTION_DISMISSED handler (batch, cooldown_days, history)
 *   - Finalization derives cooldowns_by_normalized_slug from history
 *   - normalizeSlugKey + computeSupportFingerprint helpers
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { normalizeSlugKey, isValidSlug } from '../src/admission/slug.js';
import { computeSupportFingerprint } from '../src/util/support-fingerprint.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-2.2-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

function suggestedPayload({ slug, name, description, supporting_seqs, rationale, source }) {
  const payload = {
    slug,
    name,
    description,
    supporting_seqs,
    rationale,
  };
  if (source) payload.source = source;
  return payload;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

test('normalizeSlugKey: pets / Pets / pet-s / PETS all normalize to pets', () => {
  assert.equal(normalizeSlugKey('pets'), 'pets');
  assert.equal(normalizeSlugKey('Pets'), 'pets');
  assert.equal(normalizeSlugKey('pet-s'), 'pets');
  assert.equal(normalizeSlugKey('PETS'), 'pets');
  assert.equal(normalizeSlugKey('Pet-S'), 'pets');
});

test('normalizeSlugKey: applies NFC normalization', () => {
  // NFC composes combining marks; e.g. "café" written with combining ́
  // collapses to the same key as "café" written with precomposed é.
  const decomposed = 'café';
  const composed = 'café';
  assert.equal(normalizeSlugKey(decomposed), normalizeSlugKey(composed));
});

test('normalizeSlugKey: rejects empty / non-string', () => {
  assert.throws(() => normalizeSlugKey(''), TypeError);
  assert.throws(() => normalizeSlugKey(null), TypeError);
  assert.throws(() => normalizeSlugKey(123), TypeError);
});

test('isValidSlug: enforces regex + length 2..40', () => {
  assert.equal(isValidSlug('pets'), true);
  assert.equal(isValidSlug('p'), false); // too short
  assert.equal(isValidSlug('a'.repeat(41)), false); // too long
  assert.equal(isValidSlug('Pets'), false); // capital
  assert.equal(isValidSlug('pet_s'), false); // underscore
  assert.equal(isValidSlug('-pets'), false); // leading hyphen
  assert.equal(isValidSlug('pets-'), false); // trailing hyphen
  assert.equal(isValidSlug('pet--s'), false); // double hyphen
});

test('computeSupportFingerprint: deterministic 16-hex prefix', () => {
  const fp1 = computeSupportFingerprint([1, 2, 3]);
  const fp2 = computeSupportFingerprint([3, 2, 1]); // sort + dedup
  const fp3 = computeSupportFingerprint([1, 2, 2, 3]); // dedup
  assert.equal(fp1, fp2);
  assert.equal(fp1, fp3);
  assert.match(fp1, /^[0-9a-f]{16}$/);
});

test('computeSupportFingerprint: different sets yield different fps', () => {
  assert.notEqual(
    computeSupportFingerprint([1, 2, 3]),
    computeSupportFingerprint([1, 2, 4]),
  );
});

test('computeSupportFingerprint: throws on empty', () => {
  assert.throws(() => computeSupportFingerprint([]), /non-empty/);
});

// ── State slots initialize empty ─────────────────────────────────────────────

test('state: Phase 2.2 slots initialize empty', async () => {
  const { writer } = await freshSilo();
  const state = await interpret(writer);
  assert.equal(state.topic_suggestions.size, 0);
  assert.equal(state.pending_topic_suggestion_seqs.size, 0);
  assert.equal(state.accepted_topic_suggestion_by_slug.size, 0);
  assert.equal(state.dismissed_topic_suggestion_history.size, 0);
  assert.equal(state.cooldowns_by_normalized_slug.size, 0);
  assert.equal(state.seq_to_event.size, 0);
});

// ── write_event extension populates seq_to_event ─────────────────────────────

test('write_event fold: seq_to_event captures slug/tag/content/ts/source/principal', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'rover loves walks', source: 'session-extract' },
    ts: '2026-04-22T10:00:00Z',
  });
  const state = await interpret(writer);
  const evt = state.seq_to_event.get(1);
  assert.ok(evt);
  assert.equal(evt.slug, 'general');
  assert.equal(evt.tag, 'FACT');
  assert.equal(evt.content, 'rover loves walks');
  assert.equal(evt.ts, '2026-04-22T10:00:00Z');
  assert.equal(evt.source, 'session-extract');
  assert.equal(evt.principal, 'helder');
});

test('write_event fold: seq_to_event.source is null when payload lacks source', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'no source set' },
    ts: '2026-04-22T10:00:00Z',
  });
  const state = await interpret(writer);
  assert.equal(state.seq_to_event.get(1).source, null);
});

// ── TOPIC_SUGGESTED handler ──────────────────────────────────────────────────

test('TOPIC_SUGGESTED: lands as pending, status defaults populated', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'Health, training, routine for pets',
      supporting_seqs: [1, 2, 3, 4, 5],
      rationale: '5 events about a dog Rover',
      source: 'silo-topic-detector',
    }),
    ts: '2026-04-22T10:00:00Z',
  });
  const state = await interpret(writer);
  const s = state.topic_suggestions.get(1);
  assert.ok(s);
  assert.equal(s.status, 'pending');
  assert.equal(s.slug, 'pets');
  assert.equal(s.source, 'silo-topic-detector');
  assert.equal(s.resolved_at, null);
  assert.equal(s.resolved_by_seq, null);
  assert.equal(s.accepted_slug, null);
  assert.deepEqual(s.supporting_seqs, [1, 2, 3, 4, 5]);
  assert.ok(state.pending_topic_suggestion_seqs.has(1));
});

// ── TOPIC_SUGGESTION_ACCEPTED handler ────────────────────────────────────────

test('ACCEPTED: transitions pending → accepted; updates bootstrap index', async () => {
  const { writer } = await freshSilo();
  // seq 1: TOPIC_SUGGESTED
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'Health and routine',
      supporting_seqs: [10, 11, 12],
      rationale: 'three events',
    }),
    ts: '2026-04-22T10:00:00Z',
  });
  // seq 2: ACCEPTED
  await writer.append({
    type: 'TOPIC_SUGGESTION_ACCEPTED',
    isStateBearing: true,
    intentId: 'intent:acc',
    principal: 'operator',
    payload: { suggestion_seq: 1, accepted_slug: 'pets' },
    ts: '2026-04-23T11:00:00Z',
  });
  const state = await interpret(writer);
  const s = state.topic_suggestions.get(1);
  assert.equal(s.status, 'accepted');
  assert.equal(s.resolved_by_seq, 2);
  assert.equal(s.resolved_at, '2026-04-23T11:00:00Z');
  assert.equal(s.accepted_slug, 'pets');
  assert.equal(state.pending_topic_suggestion_seqs.has(1), false);
  assert.equal(state.accepted_topic_suggestion_by_slug.get('pets'), 1);
});

test('ACCEPTED: idempotent on non-pending suggestion → skipped[] entry', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'Routine',
      supporting_seqs: [10],
      rationale: 'one',
    }),
    ts: '2026-04-22T10:00:00Z',
  });
  await writer.append({
    type: 'TOPIC_SUGGESTION_ACCEPTED',
    isStateBearing: true,
    intentId: 'intent:acc1',
    principal: 'operator',
    payload: { suggestion_seq: 1, accepted_slug: 'pets' },
    ts: '2026-04-23T11:00:00Z',
  });
  // Replay of acceptance on same suggestion_seq — should land in skipped[]
  await writer.append({
    type: 'TOPIC_SUGGESTION_ACCEPTED',
    isStateBearing: true,
    intentId: 'intent:acc2',
    principal: 'operator',
    payload: { suggestion_seq: 1, accepted_slug: 'pets' },
    ts: '2026-04-23T11:00:01Z',
  });
  const state = await interpret(writer);
  const skips = state.skipped.filter((s) => s.reason === 'suggestion_seq_not_pending');
  assert.equal(skips.length, 1);
  assert.equal(skips[0].suggestion_seq, 1);
});

// ── TOPIC_SUGGESTION_DISMISSED handler + cooldown finalization ───────────────

test('DISMISSED: batch dismiss appends one history entry per seq', async () => {
  const { writer } = await freshSilo();
  // seq 1, 2: two TOPIC_SUGGESTED with different slugs
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s1',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'pet care',
      supporting_seqs: [100, 101, 102],
      rationale: '...',
    }),
    ts: '2026-04-22T10:00:00Z',
  });
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s2',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'plants',
      name: 'Plants',
      description: 'gardening',
      supporting_seqs: [200, 201],
      rationale: '...',
    }),
    ts: '2026-04-22T10:00:01Z',
  });
  // seq 3: DISMISSED both at once with 90d cooldown
  await writer.append({
    type: 'TOPIC_SUGGESTION_DISMISSED',
    isStateBearing: true,
    intentId: 'intent:d',
    principal: 'operator',
    payload: {
      suggestion_seqs: [1, 2],
      cooldown_days: 90,
      reason: 'not interested yet',
    },
    ts: '2026-04-22T10:00:02Z',
  });
  const state = await interpret(writer);
  assert.equal(state.topic_suggestions.get(1).status, 'dismissed');
  assert.equal(state.topic_suggestions.get(2).status, 'dismissed');
  assert.equal(state.pending_topic_suggestion_seqs.size, 0);

  const petsHistory = state.dismissed_topic_suggestion_history.get('pets');
  const plantsHistory = state.dismissed_topic_suggestion_history.get('plants');
  assert.equal(petsHistory.length, 1);
  assert.equal(plantsHistory.length, 1);
  assert.equal(petsHistory[0].cooldown_days, 90);
  assert.equal(petsHistory[0].reason, 'not interested yet');
  assert.equal(petsHistory[0].source_dismissal_seq, 3);
});

test('finalization: cooldowns_by_normalized_slug uses MAX until_ts uncleared', async () => {
  const { writer } = await freshSilo();
  // Acceptance-criterion §14 scenario: dismiss `pets` 365d, dismiss `pet-s` 1d.
  // Both normalize to "pets"; max until_ts wins.
  // seq 1, 2: two suggestions
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s1',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'pet care',
      supporting_seqs: [100],
      rationale: '...',
    }),
    ts: '2026-04-22T10:00:00Z',
  });
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s2',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pet-s',
      name: 'Pets',
      description: 'pet care alt slug',
      supporting_seqs: [200],
      rationale: '...',
    }),
    ts: '2026-04-22T10:00:01Z',
  });
  // seq 3: dismiss "pets" with 365d
  await writer.append({
    type: 'TOPIC_SUGGESTION_DISMISSED',
    isStateBearing: true,
    intentId: 'intent:d1',
    principal: 'operator',
    payload: { suggestion_seqs: [1], cooldown_days: 365 },
    ts: '2026-04-22T10:00:02Z',
  });
  // seq 4: dismiss "pet-s" with 1d
  await writer.append({
    type: 'TOPIC_SUGGESTION_DISMISSED',
    isStateBearing: true,
    intentId: 'intent:d2',
    principal: 'operator',
    payload: { suggestion_seqs: [2], cooldown_days: 1 },
    ts: '2026-04-22T10:00:03Z',
  });

  const state = await interpret(writer);
  const cd = state.cooldowns_by_normalized_slug.get('pets');
  assert.ok(cd);
  // 365d wins over 1d.
  const expectedUntil = Date.parse('2026-04-22T10:00:02Z') + 365 * 86400000;
  assert.equal(cd.until_ts, expectedUntil);
  assert.equal(cd.source_dismissal_seq, 3);
  assert.equal(cd.cleared_by_accept_seq, null);
});

test('finalization: accept clears prior dismissal (cleared_by_accept_seq stamped)', async () => {
  const { writer } = await freshSilo();
  // Scenario: dismiss "pets" with cooldown. Later, accept a SECOND "pets"
  // suggestion. The first dismissal should be cleared by the accept seq —
  // not the suggestion_seq — per spec §4.2 "causal precision".
  // seq 1: TOPIC_SUGGESTED pets
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s1',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'first attempt',
      supporting_seqs: [100],
      rationale: '...',
    }),
    ts: '2026-04-22T10:00:00Z',
  });
  // seq 2: DISMISSED [1] 90d
  await writer.append({
    type: 'TOPIC_SUGGESTION_DISMISSED',
    isStateBearing: true,
    intentId: 'intent:d',
    principal: 'operator',
    payload: { suggestion_seqs: [1], cooldown_days: 90 },
    ts: '2026-04-22T10:00:01Z',
  });
  // seq 3: SECOND TOPIC_SUGGESTED pets (different evidence set, post-cooldown
  //        or via manual operator override)
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s2',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'second attempt',
      supporting_seqs: [200],
      rationale: '...',
    }),
    ts: '2026-06-22T10:00:00Z',
  });
  // seq 4: ACCEPTED [3] as "pets"
  await writer.append({
    type: 'TOPIC_SUGGESTION_ACCEPTED',
    isStateBearing: true,
    intentId: 'intent:a',
    principal: 'operator',
    payload: { suggestion_seq: 3, accepted_slug: 'pets' },
    ts: '2026-06-22T10:00:01Z',
  });

  const state = await interpret(writer);
  const history = state.dismissed_topic_suggestion_history.get('pets');
  assert.equal(history.length, 1);
  // Stamped with ACCEPT seq (4), not suggestion_seq (3).
  assert.equal(history[0].cleared_by_accept_seq, 4);
  // Derived view excludes cleared dismissals — no cooldown should remain.
  assert.equal(state.cooldowns_by_normalized_slug.has('pets'), false);
});

test('finalization: cleared dismissal does NOT contribute to active cooldown', async () => {
  const { writer } = await freshSilo();
  // Two dismissals for "pets". First gets cleared by an intervening accept;
  // second is still active. Finalization picks the still-active one.
  // 1: SUGGESTED, 2: DISMISSED, 3: SUGGESTED, 4: ACCEPTED (clears #2),
  // 5: SUGGESTED, 6: DISMISSED (active).
  const seqOf = async (entry) => (await writer.append(entry)).seq;
  await seqOf({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s1',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'a',
      supporting_seqs: [100],
      rationale: '...',
    }),
    ts: '2026-04-22T10:00:00Z',
  });
  await seqOf({
    type: 'TOPIC_SUGGESTION_DISMISSED',
    isStateBearing: true,
    intentId: 'intent:d1',
    principal: 'operator',
    payload: { suggestion_seqs: [1], cooldown_days: 30 },
    ts: '2026-04-22T10:00:01Z',
  });
  await seqOf({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s2',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'b',
      supporting_seqs: [200],
      rationale: '...',
    }),
    ts: '2026-05-01T10:00:00Z',
  });
  await seqOf({
    type: 'TOPIC_SUGGESTION_ACCEPTED',
    isStateBearing: true,
    intentId: 'intent:a',
    principal: 'operator',
    payload: { suggestion_seq: 3, accepted_slug: 'pets' },
    ts: '2026-05-01T10:00:01Z',
  });
  // Operator deletes the accepted topic conceptually (not modeled here) and
  // a NEW suggestion lands; dismissed again.
  await seqOf({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:s3',
    principal: 'topic-detector',
    payload: suggestedPayload({
      slug: 'pets',
      name: 'Pets',
      description: 'c',
      supporting_seqs: [300],
      rationale: '...',
    }),
    ts: '2026-06-01T10:00:00Z',
  });
  await seqOf({
    type: 'TOPIC_SUGGESTION_DISMISSED',
    isStateBearing: true,
    intentId: 'intent:d2',
    principal: 'operator',
    payload: { suggestion_seqs: [5], cooldown_days: 60 },
    ts: '2026-06-01T10:00:01Z',
  });

  const state = await interpret(writer);
  const cd = state.cooldowns_by_normalized_slug.get('pets');
  assert.ok(cd, 'a cooldown should remain — the SECOND dismissal is not cleared');
  // The strongest uncleared dismissal is #2 (60d from 2026-06-01).
  const expectedUntil = Date.parse('2026-06-01T10:00:01Z') + 60 * 86400000;
  assert.equal(cd.until_ts, expectedUntil);
});
