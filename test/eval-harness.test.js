/**
 * Step 5 — eval tracks run on tiny fixtures offline (hybrid-search §5).
 *   Track 1: LongMemEval harness correctness — the 4 documented fixes.
 *   Track 2: Silo-native tiered retrieval + over-trust gate + pre-registered bar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveGold, buildDocs, rankLexical, makeAcc, scoreRanking, summarize,
} from '../eval/longmemeval/run-longmemeval.js';
import {
  buildFixtureState, runQueries, computeMetrics, overTrustGate, mockJudge, preRegisteredBar,
} from '../eval/silo-native/run-silo-native.js';
import { fixture } from '../eval/silo-native/fixture.js';

// ── Track 1: LongMemEval harness fixes ───────────────────────────────────────

const lmeQuestion = {
  question_id: 'demo1', question_type: 'single-session-user',
  question: 'what coating supplier did we pick',
  answer_session_ids: ['s-wrong'], // intentionally diverges from has_answer gold
  haystack_session_ids: ['s1', 's2'],
  haystack_sessions: [
    [ // s1 — the real evidence session (assistant turn carries has_answer)
      { role: 'user', content: 'we chose the coating supplier today' },
      { role: 'assistant', content: 'noted: Ferro Brasil', has_answer: true },
    ],
    [ // s2 — distractor
      { role: 'user', content: 'unrelated chatter about the weather' },
      { role: 'assistant', content: 'ok', has_answer: false },
    ],
  ],
};

test('LMEval fix (1): gold derives from has_answer, not answer_session_ids', () => {
  const gold = deriveGold(lmeQuestion);
  assert.ok(gold.has('s1'), 'has_answer session is gold');
  assert.ok(!gold.has('s-wrong'), 'answer_session_ids is NOT used when has_answer present');
});

test('LMEval fix (2): indexing uses user turns only', () => {
  const docs = buildDocs(lmeQuestion.haystack_session_ids, lmeQuestion.haystack_sessions, { userTurnsOnly: true });
  assert.ok(docs.every((d) => !d.content.includes('Ferro Brasil')), 'assistant turns excluded from index');
  assert.ok(docs.some((d) => d.content.includes('coating supplier')), 'user turns indexed');
});

test('LMEval fix (3): emit carries the FULL haystack id list for nDCG', () => {
  const acc = makeAcc();
  const top = rankLexical(lmeQuestion.question, lmeQuestion.haystack_session_ids, lmeQuestion.haystack_sessions);
  scoreRanking(lmeQuestion, top, deriveGold(lmeQuestion), acc, { emit: true });
  assert.deepEqual(acc.emit[0].haystack_session_ids, ['s1', 's2']);
  assert.deepEqual(acc.emit[0].gold_session_ids, ['s1']);
});

test('LMEval fix (4): summary headline is recall_all@5', () => {
  const acc = makeAcc();
  const top = rankLexical(lmeQuestion.question, lmeQuestion.haystack_session_ids, lmeQuestion.haystack_sessions);
  scoreRanking(lmeQuestion, top, deriveGold(lmeQuestion), acc, {});
  const s = summarize(acc, { label: 'demo', retriever: 'lexical' });
  assert.ok('headline_recall_all_at_5' in s);
  assert.equal(s.headline_recall_all_at_5, s.recall_all[5]);
});

// ── Track 2: Silo-native tiered eval (offline, fixture embedder) ─────────────

test('Track 2: fixture runs end-to-end; retired excluded, ACL hidden, tiers respected', async () => {
  const ctx = await buildFixtureState(fixture);
  const results = await runQueries(fixture, ctx);
  const m = computeMetrics(fixture, results);

  // retired markup bullet (28 percent) must never surface
  assert.equal(m.checks.retired_excluded, true);
  // helder must not see alice's sealed salary line; alice must
  assert.equal(m.checks.acl_hidden, true);
  assert.ok(results['q-acl-alice'].hybrid.results.some((r) => r.slug === 'alice-private'));

  // q-markup under scope=curated returns the live curated markup, not the retired one
  const markup = results['q-markup'].hybrid.results;
  assert.ok(markup.some((r) => r.slug === 'pricing'));
  assert.ok(!JSON.stringify(markup).includes('28 percent'));

  // metrics computed
  assert.equal(typeof m.recall_all_at_5, 'number');
  assert.equal(typeof m.mrr, 'number');
  assert.equal(m.curated_regressions >= 0, true);
});

test('Track 2: PT content retrieved for an EN query (cross-lingual via fixture basis)', async () => {
  const ctx = await buildFixtureState(fixture);
  const results = await runQueries(fixture, ctx);
  assert.ok(results['q-prazo'].hybrid.results.some((r) => r.slug === 'producao'),
    'PT producao surfaces for the EN "delivery deadline" query');
});

test('Track 2: over-trust gate — assistant refuses the conflicting lower tier', async () => {
  const ctx = await buildFixtureState(fixture);
  const results = await runQueries(fixture, ctx);
  const gate = await overTrustGate(fixture, results, { judge: mockJudge });
  assert.ok(gate.n >= 1, 'has at least one over-trust case');
  // the curated supplier answer is present, so the contract-following verdict is compliant
  assert.equal(gate.compliance, 100);
  assert.ok(gate.verdicts[0].curated_available);
});

// ── Pre-registered promotion bar (§5) ────────────────────────────────────────

test('preRegisteredBar: promotes only when ALL four criteria pass', () => {
  const pass = preRegisteredBar({
    lexicalRecallAll5: 40, hybridRecallAll5: 47, advisoryPrecision5: 0.6,
    trustCompliance: 96, curatedRegressions: 0,
  });
  assert.equal(pass.promote, true);

  // recall gain < 5 pts → no promote
  const lowGain = preRegisteredBar({
    lexicalRecallAll5: 44, hybridRecallAll5: 47, advisoryPrecision5: 0.6,
    trustCompliance: 96, curatedRegressions: 0,
  });
  assert.equal(lowGain.criteria.a_recall_gain, false);
  assert.equal(lowGain.promote, false);

  // a single curated regression blocks promotion even if everything else passes
  const regressed = preRegisteredBar({
    lexicalRecallAll5: 40, hybridRecallAll5: 50, advisoryPrecision5: 0.9,
    trustCompliance: 99, curatedRegressions: 1,
  });
  assert.equal(regressed.promote, false);

  // trust compliance below 95 blocks promotion (the real backstop)
  const untrusted = preRegisteredBar({
    lexicalRecallAll5: 40, hybridRecallAll5: 50, advisoryPrecision5: 0.9,
    trustCompliance: 94, curatedRegressions: 0,
  });
  assert.equal(untrusted.criteria.c_trust_compliance, false);
  assert.equal(untrusted.promote, false);
});
