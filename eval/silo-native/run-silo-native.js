/**
 * Track 2 runner — Silo-native tiered-retrieval eval + answer-level over-trust
 * gate + the pre-registered promotion bar (hybrid-search §5).
 *
 * Exported, deterministic, offline-runnable with the built-in fixture embedder.
 * Standalone (`node run-silo-native.js`) resolves the real model when installed.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LogWriter } from '../../src/log/append.js';
import { interpret } from '../../src/interpret/index.js';
import { retireBullet } from '../../src/topic-proposal/retire-ops.js';
import { contextRetrievalHybrid } from '../../src/retrieval/index.js';
import { buildEmbeddingCache } from '../../src/projection/embed-cache.js';
import { MUST_NOT_WRITE_FROM_TIERS } from '../../src/retrieval/tiers.js';
import { fixture as DEFAULT_FIXTURE } from './fixture.js';

const ENV_ENABLED = { SILO_SEMANTIC: 'on', SILO_SEMANTIC_MODEL: 'bge-small-en-v1.5' };

// ── Deterministic fixture embedder: shared "topic basis" so a query and its gold
//    doc collide on cosine. Ordered keyword list → first match wins (so multi-
//    keyword queries pick the intended basis). Simulates cross-lingual matches
//    (entrega↔delivery) via a shared basis token.
const BASIS = [
  ['galvaniz', 'sheet'],            // e0 — invoices
  ['coating', 'supplier', 'tinta', 'ferro'], // e1 — suppliers
  ['markup'],                       // e2 — pricing
  ['welding', 'wire', 'steel', 'er70'], // e3 — welding
  ['delivery', 'deadline', 'prazo', 'entrega'], // e4 — producao
  ['salary', 'alice'],              // e5 — alice-private
  ['roof', 'rain', 'weather'],      // e6 — weather
];
function l2(v) { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); }
export function fixtureVectorFor(text) {
  const lc = text.toLowerCase();
  const v = new Array(BASIS.length + 1).fill(0.0);
  for (let i = 0; i < BASIS.length; i++) {
    if (BASIS[i].some((kw) => lc.includes(kw))) { v[i] = 1; return l2(v); }
  }
  v[BASIS.length] = 1; // default basis
  return l2(v);
}
export function makeFixtureEmbedder() {
  const cfg = {
    model_id: 'fixture/embedder', transformers_id: 'fixture/embedder', model_revision: 'fx-1',
    dims: BASIS.length + 1, dtype: 'q8', pooling: 'mean', normalize: true,
    doc_prefix: 'passage: ', query_prefix: 'query: ',
    tokenizer_hash: 'fx-tok', transformers_version: 'fx', ort_version: 'fx',
  };
  return {
    modelKey: 'fixture', modelId: cfg.model_id, modelRevision: cfg.model_revision, dims: cfg.dims, config: cfg,
    async embed(texts, _kind) { return (Array.isArray(texts) ? texts : [texts]).map(fixtureVectorFor); },
  };
}

async function append(writer, args) {
  return writer.append({ isStateBearing: true, intentId: `i:${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 12)}`, principal: 'helder', ts: '2026-06-01T10:00:00Z', ...args });
}

/** Build the fixture's Silo log + embedding cache; return { dir, writer, state }. */
export async function buildFixtureState(fixture = DEFAULT_FIXTURE, { embedder } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-eval-'));
  const writer = new LogWriter(dir);
  await writer.init();
  for (const p of fixture.principals) {
    await append(writer, { type: 'PRINCIPAL_DECLARED', socket: 'admin', principal: 'operator', payload: { principal: p, class: 'human' } });
  }
  const slugs = [...new Set(fixture.writes.map((w) => w[0]))];
  for (const slug of slugs) {
    await append(writer, { type: 'TOPIC_METADATA_SET', principal: 'operator', payload: { topic: slug, type: 'reference', status: 'active' } });
  }
  const seqBySlugContent = new Map();
  let i = 0;
  for (const [slug, tag, content] of fixture.writes) {
    const r = await append(writer, { type: 'write_event', intentId: `i:w${i++}`, payload: { slug, tag, content } });
    seqBySlugContent.set(`${slug}:${content}`, r.seq);
  }
  for (const [slug, readers] of fixture.seals || []) {
    await append(writer, { type: 'ACL_SEALED', socket: 'admin', principal: 'operator', payload: { topic: slug, readers } });
  }
  for (const [slug, substr] of fixture.retire || []) {
    const target = [...seqBySlugContent.entries()].find(([k]) => k.startsWith(`${slug}:`) && k.includes(substr));
    if (target) await retireBullet(writer, { slug, seqs: [target[1]] });
  }
  const state = await interpret(writer);
  const emb = embedder ?? makeFixtureEmbedder();
  await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: emb, nowIso: '2026-06-01T12:00:00Z' });
  return { dir, writer, state, embedder: emb };
}

/** Run every fixture query under BOTH lexical (gate off) and hybrid (gate on). */
export async function runQueries(fixture, { dir, state, embedder }) {
  const out = {};
  for (const q of fixture.queries) {
    const lexical = await contextRetrievalHybrid({ state, query: q.query, principal: q.principal, scope: q.scope, siloDir: dir, env: {} });
    const hybrid = await contextRetrievalHybrid({ state, query: q.query, principal: q.principal, scope: q.scope, siloDir: dir, env: ENV_ENABLED, embedder });
    out[q.id] = { lexical, hybrid };
  }
  return out;
}

const goldSlugs = (q) => new Set((q.gold || []).map((g) => g.slug));

function recallAtK(results, gold, k) {
  if (gold.size === 0) return null; // not a recall query
  const topSlugs = new Set(results.slice(0, k).map((r) => r.slug));
  return [...gold].every((s) => topSlugs.has(s)) ? 1 : 0; // recall_all
}
function precisionAtKByTier(results, gold, k, tier) {
  const topTier = results.slice(0, k).filter((r) => r.tier === tier);
  if (topTier.length === 0) return null;
  const rel = topTier.filter((r) => gold.has(r.slug)).length;
  return rel / topTier.length;
}

/** Aggregate tiered-retrieval metrics + correctness checks over the fixture. */
export function computeMetrics(fixture, results) {
  const recallQ = fixture.queries.filter((q) => (q.gold || []).length > 0);
  let recallAll5Hits = 0, mrrSum = 0;
  const advisoryPrec = [];
  const checks = { retired_excluded: true, acl_hidden: true };

  for (const q of fixture.queries) {
    const gold = goldSlugs(q);
    const hyb = results[q.id].hybrid.results;

    if (gold.size > 0) {
      if (recallAtK(hyb, gold, 5) === 1) recallAll5Hits += 1;
      let fr = 0;
      for (let i = 0; i < hyb.length; i++) if (gold.has(hyb[i].slug)) { fr = i + 1; break; }
      mrrSum += fr ? 1 / fr : 0;
      for (const tier of MUST_NOT_WRITE_FROM_TIERS) {
        const p = precisionAtKByTier(hyb, gold, 5, tier);
        if (p !== null) advisoryPrec.push(p);
      }
    }
    // forbidden content (retired) must not appear anywhere in the result text.
    if (q.forbidden_content) {
      const blob = JSON.stringify(hyb);
      if (blob.includes(q.forbidden_content)) checks.retired_excluded = false;
    }
    if (q.forbidden_slug && hyb.some((r) => r.slug === q.forbidden_slug)) checks.acl_hidden = false;
  }

  // curated no-regression: a query where lexical surfaced the gold curated slug in
  // top-k but hybrid dropped it (§5 criterion d).
  let curatedRegressions = 0;
  for (const q of recallQ) {
    const gold = goldSlugs(q);
    const lexTop = new Set(results[q.id].lexical.results.slice(0, 5).map((r) => r.slug));
    const hybTop = new Set(results[q.id].hybrid.results.slice(0, 5).map((r) => r.slug));
    for (const s of gold) if (lexTop.has(s) && !hybTop.has(s)) curatedRegressions += 1;
  }

  const recallQn = recallQ.length || 1;
  return {
    recall_all_at_5: 100 * recallAll5Hits / recallQn,
    mrr: mrrSum / recallQn,
    advisory_precision_at_5: advisoryPrec.length ? advisoryPrec.reduce((a, b) => a + b, 0) / advisoryPrec.length : null,
    curated_regressions: curatedRegressions,
    checks,
  };
}

/**
 * Mock answer-level judge. A contract-following assistant must answer ONLY from
 * the authoritative (curated) tier and REFUSE a conflicting note/source. Mock
 * verdict = compliant iff a curated result for the correct slug is present (so the
 * assistant can cite curated and ignore the wrong lower tier). Real-LLM judges
 * plug in via the `judge` arg.
 */
export function mockJudge({ query, result }) {
  if (!query.over_trust) return null;
  const curatedHit = result.results.find((r) => r.slug === query.over_trust.correct_slug && r.tier === 'curated');
  const conflicting = result.results.some((r) => r.slug === query.over_trust.correct_slug
    ? false : r.tier === query.over_trust.wrong_tier);
  // compliant: curated answer available AND the contract names the wrong tier as no-write.
  const refusesLowerTier = !!curatedHit && result.must_not_write_from_tiers.includes(query.over_trust.wrong_tier);
  return { compliant: refusesLowerTier, curated_available: !!curatedHit, conflicting };
}

/** Run the over-trust gate over over_trust queries; returns compliance fraction. */
export async function overTrustGate(fixture, results, { judge = mockJudge } = {}) {
  const cases = fixture.queries.filter((q) => q.over_trust);
  if (cases.length === 0) return { compliance: 1, n: 0, verdicts: [] };
  const verdicts = [];
  for (const q of cases) {
    const v = await judge({ query: q, result: results[q.id].hybrid });
    verdicts.push({ id: q.id, ...v });
  }
  const compliant = verdicts.filter((v) => v.compliant).length;
  return { compliance: 100 * compliant / cases.length, n: cases.length, verdicts };
}

/**
 * Pre-registered promotion bar (§5). scope=all becomes default ONLY if all hold.
 * Inputs are percentages (recall/compliance) + a precision fraction.
 */
export function preRegisteredBar({
  lexicalRecallAll5, hybridRecallAll5, advisoryPrecision5, trustCompliance, curatedRegressions,
  recallGainPts = 5, precisionFloor = 0.5, trustFloor = 95,
}) {
  const criteria = {
    a_recall_gain: hybridRecallAll5 >= lexicalRecallAll5 + recallGainPts,
    b_advisory_precision: advisoryPrecision5 == null ? true : advisoryPrecision5 >= precisionFloor,
    c_trust_compliance: trustCompliance >= trustFloor,
    d_no_curated_regression: curatedRegressions === 0,
  };
  return { promote: Object.values(criteria).every(Boolean), criteria };
}
