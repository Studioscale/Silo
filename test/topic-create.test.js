/**
 * `silo topic create` ops tests — slug-existence-guard v0.2.5 §4.6.
 *
 * Exercises src/topic-proposal/topic-ops.js createTopic (the shared library the
 * CLI `silo topic create` calls): the topic becomes write-admissible, with
 * collision / pending-suggestion / cooldown guards reusing the suggestion-ops +
 * detect machinery.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { AdmissionError } from '../src/log/admission-error.js';
import { createTopic } from '../src/topic-proposal/topic-ops.js';
import { SuggestionOpError } from '../src/topic-proposal/suggestion-ops.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-topic-create-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

const writeEvent = (slug, content = 'x') => ({
  type: 'write_event', isStateBearing: true,
  intentId: `intent:we-${slug}-${Math.random()}`,
  principal: 'helder', payload: { slug, tag: 'FACT', content },
});

// Append a pending TOPIC_SUGGESTED for `slug` (with a real supporting seq on
// `general`). Returns the suggestion seq.
async function seedSuggestion(writer, slug, ts = '2026-06-15T00:00:00Z') {
  const sup = await writer.append({ ...writeEvent('general', `support ${slug}`), ts });
  const sug = await writer.append({
    type: 'TOPIC_SUGGESTED', isStateBearing: true,
    intentId: `intent:sug-${slug}-${Math.random()}`, principal: 'topic-detector',
    payload: { slug, name: 'Name', description: 'desc', supporting_seqs: [sup.seq], rationale: 'because' },
    ts,
  });
  return sug.seq;
}

test('topic create: mints a topic that then accepts write_events', async () => {
  const { writer } = await freshSilo();
  const result = await createTopic(writer, { slug: 'pets' });
  assert.equal(result.created, true);
  assert.equal(result.type, 'reference'); // default
  assert.equal(result.dismissed_suggestion_seqs.length, 0);
  // The slug is now write-admissible — a write_event lands.
  const w = await writer.append(writeEvent('pets', '- a pet fact'));
  assert.ok(w.seq > result.metadata_seq);
  const state = await interpret(writer);
  assert.equal(state.topic_index.get('pets').topic_type, 'reference');
  assert.equal(state.topic_content.get('pets').length, 1);
});

test('topic create: --type override is honored', async () => {
  const { writer } = await freshSilo();
  const result = await createTopic(writer, { slug: 'novel-idea', type: 'project' });
  assert.equal(result.type, 'project');
  const state = await interpret(writer);
  assert.equal(state.topic_index.get('novel-idea').topic_type, 'project');
});

test('topic create: SLUG_COLLISION when the topic already exists', async () => {
  const { writer } = await freshSilo();
  await createTopic(writer, { slug: 'pets' });
  await assert.rejects(
    () => createTopic(writer, { slug: 'pets' }),
    (e) => e instanceof SuggestionOpError && e.code === 'SLUG_COLLISION',
  );
});

test('topic create: INVALID_SLUG for a malformed slug', async () => {
  const { writer } = await freshSilo();
  await assert.rejects(
    () => createTopic(writer, { slug: 'Bad Slug' }),
    (e) => e instanceof SuggestionOpError && e.code === 'INVALID_SLUG',
  );
});

test('topic create: PENDING_SUGGESTION_EXISTS unless --dismiss-pending (normalized match)', async () => {
  const { writer } = await freshSilo();
  // Suggestion slug 'pet-s' normalizes to 'pets' — a normalized collision.
  const sugSeq = await seedSuggestion(writer, 'pet-s');
  await assert.rejects(
    () => createTopic(writer, { slug: 'pets' }),
    (e) => e instanceof SuggestionOpError
      && e.code === 'PENDING_SUGGESTION_EXISTS'
      && e.detail.pending_seqs.includes(sugSeq),
  );

  // --dismiss-pending dismisses ALL matches (cooldown_days=1) then creates.
  const result = await createTopic(writer, { slug: 'pets', dismissPending: true });
  assert.equal(result.created, true);
  assert.deepEqual(result.dismissed_suggestion_seqs, [sugSeq]);
  const state = await interpret(writer);
  assert.equal(state.topic_suggestions.get(sugSeq).status, 'dismissed');
  assert.equal(state.topic_index.get('pets').topic_type, 'reference');
});

test('topic create: COOLDOWN_ACTIVE unless --override-cooldown', async () => {
  const { writer } = await freshSilo();
  const sugSeq = await seedSuggestion(writer, 'pets');
  // Dismiss with a long cooldown → an active cooldown for normalized 'pets'.
  await writer.append({
    type: 'TOPIC_SUGGESTION_DISMISSED', isStateBearing: true, intentId: 'intent:dismiss',
    principal: 'operator', payload: { suggestion_seqs: [sugSeq], cooldown_days: 365 },
    ts: '2026-06-15T00:00:00Z',
  });

  await assert.rejects(
    () => createTopic(writer, { slug: 'pets' }),
    (e) => e instanceof SuggestionOpError && e.code === 'COOLDOWN_ACTIVE',
  );

  const result = await createTopic(writer, { slug: 'pets', overrideCooldown: true });
  assert.equal(result.created, true);
  const state = await interpret(writer);
  assert.equal(state.topic_index.get('pets').topic_type, 'reference');
});

test('topic create: runs under the tail-safety gate (no orphaning onto a broken tail)', async () => {
  const { writer } = await freshSilo();
  await writer.append(writeEvent('general', 'seed'));
  // Forge a broken physical tail.
  const tailSeq = writer.tail().seq;
  await fs.appendFile(join(writer.logDir, writer.tail().logFile), JSON.stringify({
    seq: tailSeq + 1, type: 'write_event', hash_prev: '0'.repeat(64),
    principal: 'operator', intent_id: 'intent:bad', is_state_bearing: true,
    payload: { slug: 'general', tag: 'FACT', content: 'broken' }, ts: '2026-04-01T12:00:00Z',
  }) + '\n');
  await assert.rejects(
    () => createTopic(writer, { slug: 'pets' }),
    (e) => e instanceof AdmissionError && e.code === 'LOG_TAIL_NOT_INTERPRETABLE',
  );
});
