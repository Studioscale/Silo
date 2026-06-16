/**
 * Phase 2.2 §15 step 7 — detection module.
 *
 * Pure tests on validators / helpers + integration tests with a stub LLM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import {
  detectTopicClusters,
  isCooldownActive,
  shouldDeferFirstRun,
  selectScanEvents,
  stratifiedSample,
  parseDetectionResponse,
  validateClusterProposal,
  jaccardOverlap,
  DEFERRAL_GENERAL_COUNT_THRESHOLD,
} from '../src/topic-proposal/detect.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-detect-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function seedGeneral(writer, n, opts = {}) {
  const seqs = [];
  for (let i = 0; i < n; i++) {
    const r = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:seed-${i}-${Math.random()}`,
      principal: 'helder',
      payload: {
        slug: 'general',
        tag: 'FACT',
        content: opts.contentFor ? opts.contentFor(i) : `general event ${i}`,
        ...(opts.source ? { source: opts.source } : {}),
      },
      ts: new Date(
        (opts.baseMs ?? Date.parse('2026-04-01T10:00:00Z')) + i * 60_000,
      ).toISOString(),
    });
    seqs.push(r.seq);
  }
  return seqs;
}

function stubLlm(rawResponse) {
  return {
    complete: async () => ({ content: rawResponse, usage: { total_tokens: 100 } }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

test('isCooldownActive: true when now < until_ts and not cleared', () => {
  const rec = { until_ts: 1000, cleared_by_accept_seq: null };
  assert.equal(isCooldownActive(rec, 500), true);
  assert.equal(isCooldownActive(rec, 1500), false);
  assert.equal(
    isCooldownActive({ until_ts: 1000, cleared_by_accept_seq: 42 }, 500),
    false,
  );
  assert.equal(isCooldownActive(null, 500), false);
});

test('jaccardOverlap: intersection/union math', () => {
  assert.equal(jaccardOverlap(new Set([1, 2, 3]), new Set([2, 3, 4])), 2 / 4);
  assert.equal(jaccardOverlap(new Set([1, 2]), new Set([3, 4])), 0);
  assert.equal(jaccardOverlap(new Set([1, 2, 3]), new Set([1, 2, 3])), 1);
  assert.equal(jaccardOverlap(new Set(), new Set()), 0);
});

// ── Stratified sampling ──────────────────────────────────────────────────────

test('stratifiedSample: under budget → returns input as-is', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ seq: i, content: 'x' }));
  const out = stratifiedSample(events, 100_000);
  assert.equal(out.length, 10);
});

test('stratifiedSample: over budget → keeps first + last + every-Kth', () => {
  const events = Array.from({ length: 100 }, (_, i) => ({
    seq: i,
    content: 'x'.repeat(200),
  }));
  const out = stratifiedSample(events, 2000);
  assert.ok(out.length < events.length);
  assert.ok(out.length >= 2);
  // First and last preserved.
  assert.equal(out[0].seq, events[0].seq);
  assert.equal(out[out.length - 1].seq, events[events.length - 1].seq);
});

// ── parseDetectionResponse ───────────────────────────────────────────────────

test('parseDetectionResponse: extracts proposals from fenced JSON block', () => {
  const raw = `Here are my proposals:
\`\`\`json
[
  {
    "slug": "pets",
    "name": "Pets",
    "description": "d",
    "rationale": "r",
    "supporting_seqs": [10, 11, 12]
  }
]
\`\`\`
done.`;
  const parsed = parseDetectionResponse(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].slug, 'pets');
});

test('parseDetectionResponse: NOTHING_TO_PROPOSE → empty array', () => {
  assert.deepEqual(parseDetectionResponse('NOTHING_TO_PROPOSE'), []);
  assert.deepEqual(parseDetectionResponse(''), []);
});

test('parseDetectionResponse: malformed JSON → empty array', () => {
  assert.deepEqual(parseDetectionResponse('```json\n{not json}\n```'), []);
  assert.deepEqual(parseDetectionResponse('totally not json'), []);
});

test('parseDetectionResponse: parses bare JSON (no fenced block)', () => {
  const raw = '[{"slug":"a","name":"A","description":"d","rationale":"r","supporting_seqs":[1]}]';
  const parsed = parseDetectionResponse(raw);
  assert.equal(parsed.length, 1);
});

// ── validateClusterProposal ──────────────────────────────────────────────────

test('validateClusterProposal: rejects hallucinated supporting_seqs', async () => {
  const { writer } = await freshSilo();
  await seedGeneral(writer, 3);
  const state = await interpret(writer);
  const reject = validateClusterProposal(
    {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      rationale: 'r',
      supporting_seqs: [9999], // doesn't exist
    },
    state,
    { scan_slugs: ['general'], fingerprint_overlap_threshold: 0.65 },
    Date.now(),
  );
  assert.equal(reject, 'supporting_seq_not_found');
});

test('validateClusterProposal: rejects slug that already exists', async () => {
  const { writer } = await freshSilo();
  const seeds = await seedGeneral(writer, 3);
  await writer.append({
    type: 'TOPIC_METADATA_SET',
    isStateBearing: true,
    intentId: 'intent:m',
    principal: 'operator',
    payload: { topic: 'pets', type: 'reference', status: 'active' },
    ts: '2026-04-01T10:00:00Z',
  });
  const state = await interpret(writer);
  const reject = validateClusterProposal(
    {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      rationale: 'r',
      supporting_seqs: seeds,
    },
    state,
    { scan_slugs: ['general'], fingerprint_overlap_threshold: 0.65 },
    Date.now(),
  );
  assert.equal(reject, 'slug_collision_with_topic_index');
});

test('validateClusterProposal: rejects active cooldown match', async () => {
  const { writer } = await freshSilo();
  const seeds = await seedGeneral(writer, 3);
  const sug = await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      supporting_seqs: seeds,
      rationale: 'r',
    },
    ts: '2026-04-22T10:00:00Z',
  });
  await writer.append({
    type: 'TOPIC_SUGGESTION_DISMISSED',
    isStateBearing: true,
    intentId: 'intent:d',
    principal: 'operator',
    payload: { suggestion_seqs: [sug.seq], cooldown_days: 90 },
    ts: '2026-04-22T10:00:01Z',
  });
  const state = await interpret(writer);
  // A new proposal for the SAME normalized slug ("pets" vs "Pets") with
  // DIFFERENT supporting_seqs (no overlap) still gets blocked by cooldown.
  const seedsB = await seedGeneral(writer, 3, { baseMs: Date.parse('2026-05-01T10:00:00Z') });
  const stateB = await interpret(writer);
  const reject = validateClusterProposal(
    {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      rationale: 'r',
      supporting_seqs: seedsB,
    },
    stateB,
    { scan_slugs: ['general'], fingerprint_overlap_threshold: 0.65 },
    Date.parse('2026-04-25T10:00:00Z'), // within cooldown window
  );
  assert.equal(reject, 'cooldown_active');
});

test('validateClusterProposal: rejects fingerprint overlap with pending suggestion', async () => {
  const { writer } = await freshSilo();
  const seeds = await seedGeneral(writer, 6);
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      supporting_seqs: seeds.slice(0, 4), // [s1,s2,s3,s4]
      rationale: 'r',
    },
    ts: '2026-04-22T10:00:00Z',
  });
  const state = await interpret(writer);
  // Proposal supporting_seqs = [s1,s2,s3,s4,s5] — shares 4 of 4 with pending,
  // adds s5. Jaccard = 4/(4+5-4) = 4/5 = 0.8 ≥ 0.65 → rejected.
  const reject = validateClusterProposal(
    {
      slug: 'animals',
      name: 'Animals',
      description: 'd',
      rationale: 'r',
      supporting_seqs: seeds.slice(0, 5),
    },
    state,
    { scan_slugs: ['general'], fingerprint_overlap_threshold: 0.65 },
    Date.now(),
  );
  assert.match(reject, /^support_overlap_pending_seq_/);
});

test('validateClusterProposal: rejects supporting_seq under non-scan slug (hallucination guard)', async () => {
  const { writer } = await freshSilo();
  // Seed an event under a NON-scan slug. 'system' is a reserved sink
  // (admissible without creation) and is NOT in scan_slugs (['general']).
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:s',
    principal: 'helder',
    payload: { slug: 'system', tag: 'FACT', content: 'something' },
    ts: '2026-04-01T10:00:00Z',
  });
  const state = await interpret(writer);
  const reject = validateClusterProposal(
    {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      rationale: 'r',
      supporting_seqs: [1],
    },
    state,
    { scan_slugs: ['general'], fingerprint_overlap_threshold: 0.65 },
    Date.now(),
  );
  assert.equal(reject, 'supporting_seq_wrong_slug');
});

// ── selectScanEvents ─────────────────────────────────────────────────────────

test('selectScanEvents: excludes detector-sourced events (anti-self-citation)', async () => {
  const { writer } = await freshSilo();
  // Seed mix of helder + detector-sourced events.
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'human event' },
    ts: '2026-05-01T10:00:00Z',
  });
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:2',
    principal: 'topic-detector',
    payload: {
      slug: 'general',
      tag: 'FACT',
      content: 'detector emitted',
      source: 'silo-topic-detector',
    },
    ts: '2026-05-02T10:00:00Z',
  });
  const state = await interpret(writer);
  const events = selectScanEvents(
    state,
    ['general'],
    30,
    Date.parse('2026-05-10T10:00:00Z'),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].content, 'human event');
});

// ── First-run deferral ──────────────────────────────────────────────────────

test('shouldDeferFirstRun: defers when no prior suggested + general > 50', async () => {
  const { writer } = await freshSilo();
  await seedGeneral(writer, DEFERRAL_GENERAL_COUNT_THRESHOLD + 1);
  const state = await interpret(writer);
  assert.equal(shouldDeferFirstRun(state, ['general']), true);
});

test('shouldDeferFirstRun: no defer when general count ≤ 50', async () => {
  const { writer } = await freshSilo();
  await seedGeneral(writer, 5);
  const state = await interpret(writer);
  assert.equal(shouldDeferFirstRun(state, ['general']), false);
});

test('shouldDeferFirstRun: no defer once at least one prior TOPIC_SUGGESTED exists', async () => {
  const { writer } = await freshSilo();
  const seeds = await seedGeneral(writer, DEFERRAL_GENERAL_COUNT_THRESHOLD + 1);
  await writer.append({
    type: 'TOPIC_SUGGESTED',
    isStateBearing: true,
    intentId: 'intent:sug',
    principal: 'topic-detector',
    payload: {
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      supporting_seqs: seeds.slice(0, 3),
      rationale: 'r',
    },
    ts: '2026-05-01T10:00:00Z',
  });
  const state = await interpret(writer);
  assert.equal(shouldDeferFirstRun(state, ['general']), false);
});

// ── End-to-end orchestration with stub LLM ──────────────────────────────────

test('detectTopicClusters: insufficient events → status emitted, no suggestions', async () => {
  const { writer } = await freshSilo();
  await seedGeneral(writer, 1); // below min=3
  const llm = stubLlm('should not be called');
  const result = await detectTopicClusters({
    writer,
    llm,
    options: { scan_slugs: ['general'], days_back: 30, min_events: 3 },
    now: Date.parse('2026-04-15T10:00:00Z'),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.status, 'insufficient_events');
  // Status event landed in system slug.
  const state = await interpret(writer);
  const sys = state.topic_content.get('system') ?? [];
  assert.ok(sys.some((e) => e.content.includes('insufficient events')));
});

test('detectTopicClusters: valid LLM output produces TOPIC_SUGGESTED events', async () => {
  const { writer } = await freshSilo();
  const seeds = await seedGeneral(writer, 5);
  // LLM proposes one valid cluster.
  const llmRaw = `\`\`\`json
[
  {
    "slug": "pets",
    "name": "Pets",
    "description": "Health and routine for pets",
    "rationale": "Five events about Rover",
    "supporting_seqs": ${JSON.stringify(seeds.slice(0, 3))}
  }
]
\`\`\``;
  const llm = stubLlm(llmRaw);
  const result = await detectTopicClusters({
    writer,
    llm,
    options: { scan_slugs: ['general'], days_back: 60, min_events: 3 },
    bulkScan: true,
    now: Date.parse('2026-04-15T10:00:00Z'),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.validated, 1);
  assert.equal(result.suggested.length, 1);

  const state = await interpret(writer);
  assert.equal(state.pending_topic_suggestion_seqs.size, 1);
});

test('detectTopicClusters: hallucinated seqs rejected; valid proposal still passes', async () => {
  const { writer } = await freshSilo();
  const seeds = await seedGeneral(writer, 5);
  const llmRaw = `\`\`\`json
[
  {"slug": "ghost", "name": "Ghost", "description": "d", "rationale": "r", "supporting_seqs": [9999]},
  {"slug": "pets", "name": "Pets", "description": "d", "rationale": "r", "supporting_seqs": ${JSON.stringify(seeds.slice(0, 3))}}
]
\`\`\``;
  const llm = stubLlm(llmRaw);
  const result = await detectTopicClusters({
    writer,
    llm,
    options: { scan_slugs: ['general'], days_back: 60, min_events: 3 },
    bulkScan: true,
    now: Date.parse('2026-04-15T10:00:00Z'),
  });
  assert.equal(result.proposed, 2);
  assert.equal(result.validated, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'supporting_seq_not_found');
});

test('detectTopicClusters: deterministic intent_id makes duplicate runs land in skipped', async () => {
  const { writer } = await freshSilo();
  const seeds = await seedGeneral(writer, 5);
  const llmRaw = `\`\`\`json
[{"slug": "pets", "name": "Pets", "description": "d", "rationale": "r", "supporting_seqs": ${JSON.stringify(seeds.slice(0, 3))}}]
\`\`\``;
  const llm = stubLlm(llmRaw);
  await detectTopicClusters({
    writer,
    llm,
    options: { scan_slugs: ['general'], days_back: 60, min_events: 3 },
    bulkScan: true,
    now: Date.parse('2026-04-15T10:00:00Z'),
  });
  // Second run same UTC date + same fingerprint → SAME intent_id. The
  // second append should hash-chain a NEW seq but be functionally a
  // duplicate the consumer can deduplicate.
  // (Note: spec §11.1 — intent_id is audit/correlation, NOT writer-level
  //  dedup. We pin that the SECOND call DOES land another suggestion in
  //  the log; cooldown / fingerprint-overlap is what actually prevents
  //  duplicates in production.)
  const result2 = await detectTopicClusters({
    writer,
    llm,
    options: { scan_slugs: ['general'], days_back: 60, min_events: 3 },
    bulkScan: true,
    now: Date.parse('2026-04-15T10:00:00Z'),
  });
  // Second run's proposal SHOULD be rejected by fingerprint overlap
  // against the first run's pending suggestion.
  assert.equal(result2.validated, 0);
  assert.ok(
    result2.rejected.some((r) => /^support_overlap_pending_seq_/.test(r.reason)),
  );
});

test('detectTopicClusters: first-run deferral on fresh log + many general events', async () => {
  const { writer } = await freshSilo();
  await seedGeneral(writer, DEFERRAL_GENERAL_COUNT_THRESHOLD + 5);
  const llm = stubLlm('should not be called');
  const result = await detectTopicClusters({
    writer,
    llm,
    // bulkScan = false (default)
    options: { scan_slugs: ['general'], days_back: 60, min_events: 3 },
    now: Date.parse('2026-05-01T10:00:00Z'),
  });
  assert.equal(result.status, 'first_run_deferred');
  assert.equal(result.skipped, true);
});

test('detectTopicClusters: --bulk-scan bypasses first-run deferral', async () => {
  const { writer } = await freshSilo();
  const seeds = await seedGeneral(writer, DEFERRAL_GENERAL_COUNT_THRESHOLD + 5);
  const llmRaw = `\`\`\`json
[{"slug": "pets", "name": "Pets", "description": "d", "rationale": "r", "supporting_seqs": ${JSON.stringify(seeds.slice(0, 3))}}]
\`\`\``;
  const llm = stubLlm(llmRaw);
  const result = await detectTopicClusters({
    writer,
    llm,
    options: { scan_slugs: ['general'], days_back: 60, min_events: 3 },
    bulkScan: true,
    now: Date.parse('2026-05-01T10:00:00Z'),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.validated, 1);
});
