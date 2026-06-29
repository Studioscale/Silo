#!/usr/bin/env node
/**
 * Track 1 — LongMemEval retrieval eval for Silo's search engine.
 *
 * Head-to-head of Silo's retrieval engine on LongMemEval's retrieval task. With
 * the hybrid-search build this supports three retrievers (same primitives the
 * product ships):
 *   --retriever=lexical   MiniSearch (BM25-family), mirrors contextRetrieval.
 *   --retriever=semantic  embedder.js (local model) + chunk.js, cosine rank.
 *   --retriever=hybrid    RRF(lexical, semantic) — fusion.js, k=60.
 * Report lexical/semantic/hybrid side-by-side to read the fusion delta (§5).
 *
 * FOUR HARNESS-CORRECTNESS FIXES folded here (prereq for any published number —
 * RETRIEVAL-EVAL-review-packet.md), each toggle-documented below:
 *   (1) GOLD = official per-turn `has_answer` derivation, NOT `answer_session_ids`.
 *   (2) INDEX USER TURNS ONLY (the official retrieval setup).
 *   (3) EMIT the FULL haystack id list per question (so the official nDCG scorer
 *       sees the whole candidate set, not just our ranked hits).
 *   (4) HEADLINE metric is `recall_all@5` (strict; the multi-evidence gap the
 *       semantic arm targets), not recall_any@5.
 *
 * Streams the dataset element-by-element (the _M file is 2.74 GB). Deterministic
 * for lexical; semantic/hybrid require `silo semantic install` + the model.
 * Usage: node eval/longmemeval/run-longmemeval.js <dataset.json> [--retriever=lexical] [--label=NAME] [--emit=path]
 */

import { createReadStream, writeFileSync } from 'node:fs';
import MiniSearch from 'minisearch';
import { normalizeQuery } from '../../src/retrieval/index.js';
import { rrf } from '../../src/retrieval/fusion.js';

export const K_LIST = [1, 3, 5, 10];

// ── Fix (1): GOLD from per-turn has_answer ─────────────────────────────────
// Official LongMemEval retrieval gold = the set of sessions that actually
// CONTAIN an answer turn (any turn with has_answer===true), derived from the
// haystack itself — NOT the question's answer_session_ids (which can diverge).
// Falls back to answer_session_ids only when the haystack carries no has_answer
// markers at all (older dumps).
export function deriveGold(q) {
  const ids = q.haystack_session_ids || [];
  const sessions = q.haystack_sessions || [];
  const gold = new Set();
  let sawMarker = false;
  sessions.forEach((s, i) => {
    for (const turn of Array.isArray(s) ? s : []) {
      if (turn && typeof turn.has_answer === 'boolean') {
        sawMarker = true;
        if (turn.has_answer) { gold.add(ids[i]); break; }
      }
    }
  });
  if (!sawMarker) for (const sid of q.answer_session_ids || []) gold.add(sid);
  return gold;
}

function turnText(turn) {
  return typeof turn?.content === 'string' ? turn.content : JSON.stringify(turn?.content ?? '');
}

// ── Fix (2): INDEX USER TURNS ONLY ─────────────────────────────────────────
// One doc per user turn, carrying its session id (so hits collapse to sessions).
// Assistant turns are excluded from the index; has_answer (often on assistant
// turns) is consulted only for gold derivation (fix 1), never for indexing.
export function buildDocs(sessionIds, sessions, { userTurnsOnly = true } = {}) {
  const docs = [];
  let id = 0;
  sessions.forEach((s, si) => {
    for (const turn of Array.isArray(s) ? s : []) {
      if (userTurnsOnly && turn?.role && turn.role !== 'user') continue;
      docs.push({ id: id++, sid: sessionIds[si], content: turnText(turn) });
    }
  });
  return docs;
}

function collapseToSessions(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) if (!seen.has(h.sid)) { seen.add(h.sid); out.push(h.sid); }
  return out;
}

export function rankLexical(question, sessionIds, sessions, { queryMode = 'keywords', userTurnsOnly = true } = {}) {
  const mini = new MiniSearch({ fields: ['content'], storeFields: ['sid'] });
  mini.addAll(buildDocs(sessionIds, sessions, { userTurnsOnly }));
  const q = queryMode === 'keywords' ? normalizeQuery(question) : question;
  const opts = { boost: { content: 1 }, fuzzy: 0.3, prefix: true };
  let hits = mini.search(q, { ...opts, combineWith: 'AND' });
  if (hits.length === 0) hits = mini.search(q, { ...opts, combineWith: 'OR' });
  return collapseToSessions(hits);
}

// Semantic / hybrid arms reuse the SHIPPED embedder primitive (model + prefixes).
// embedder.embed([texts], kind) → L2-normalized vectors. Per-session doc text =
// concatenated user turns.
function sessionUserText(session) {
  return (Array.isArray(session) ? session : [])
    .filter((t) => !t?.role || t.role === 'user')
    .map(turnText)
    .join('\n');
}

export async function rankSemantic(question, sessionIds, sessions, { embedder }) {
  if (!embedder) throw new Error('rankSemantic: embedder required (run `silo semantic install`)');
  const texts = sessions.map(sessionUserText);
  const docVecs = await embedder.embed(texts, 'passage');
  const [qvec] = await embedder.embed([question], 'query');
  const scored = sessionIds.map((sid, i) => {
    let dot = 0; const v = docVecs[i];
    for (let d = 0; d < qvec.length; d++) dot += qvec[d] * v[d];
    return { sid, sim: dot };
  });
  scored.sort((a, b) => b.sim - a.sim);
  return scored.map((s) => s.sid);
}

export async function rankHybrid(question, sessionIds, sessions, opts) {
  const L = rankLexical(question, sessionIds, sessions, opts);
  const S = await rankSemantic(question, sessionIds, sessions, opts);
  return rrf({ L, S }).map((r) => r.key);
}

export async function rankFor(retriever, question, sessionIds, sessions, opts) {
  if (retriever === 'semantic') return rankSemantic(question, sessionIds, sessions, opts);
  if (retriever === 'hybrid') return rankHybrid(question, sessionIds, sessions, opts);
  return rankLexical(question, sessionIds, sessions, opts);
}

export function makeAcc() {
  const agg = {};
  for (const k of K_LIST) agg[k] = { any: 0, all: 0 };
  return { agg, mrrSum: 0, n: 0, skipped: 0, byType: {}, emit: [] };
}

/** Score one question's ranking into the accumulator. `top` = ranked session ids. */
export function scoreRanking(q, top, gold, acc, { emit = false } = {}) {
  if (gold.size === 0) { acc.skipped += 1; return; }
  acc.n += 1;

  if (emit) {
    acc.emit.push({
      question_id: q.question_id,
      question_type: q.question_type,
      ranked_session_ids: top,
      gold_session_ids: [...gold],
      // ── Fix (3): emit the FULL haystack id list for the official nDCG scorer.
      haystack_session_ids: q.haystack_session_ids || [],
    });
  }

  let firstRank = 0;
  for (let i = 0; i < top.length; i++) if (gold.has(top[i])) { firstRank = i + 1; break; }
  acc.mrrSum += firstRank ? 1 / firstRank : 0;

  for (const k of K_LIST) {
    const topk = top.slice(0, k);
    if (topk.some((id) => gold.has(id))) acc.agg[k].any += 1;
    if ([...gold].every((id) => topk.includes(id))) acc.agg[k].all += 1;
  }
  const t = q.question_type || 'unknown';
  acc.byType[t] = acc.byType[t] || { n: 0, all5: 0 };
  acc.byType[t].n += 1;
  if ([...gold].every((id) => top.slice(0, 5).includes(id))) acc.byType[t].all5 += 1;
}

export function summarize(acc, { label, retriever }) {
  const { agg, mrrSum, n, skipped, byType } = acc;
  const pct = (x) => (n ? (100 * x / n) : 0);
  const out = {
    label, retriever, n, skipped,
    recall_all: {}, recall_any: {}, mrr: n ? mrrSum / n : 0, by_type: {},
    headline_recall_all_at_5: pct(agg[5].all), // ── Fix (4): headline is recall_all@5
  };
  for (const k of K_LIST) { out.recall_all[k] = pct(agg[k].all); out.recall_any[k] = pct(agg[k].any); }
  for (const [t, v] of Object.entries(byType)) out.by_type[t] = { n: v.n, recall_all_at_5: 100 * v.all5 / v.n };
  return out;
}

function printSummary(s) {
  console.log('═══ LongMemEval retrieval — Silo ═══');
  console.log(`dataset: ${s.label}  |  retriever=${s.retriever}`);
  console.log(`questions scored: ${s.n}${s.skipped ? ` (skipped ${s.skipped} with no gold)` : ''}`);
  console.log('');
  console.log(`HEADLINE recall_all@5: ${s.headline_recall_all_at_5.toFixed(1)}%  (strict — all gold sessions in top-5)`);
  console.log('');
  console.log('recall_all@k:');
  for (const k of K_LIST) console.log(`  R@${k}: ${s.recall_all[k].toFixed(1)}%`);
  console.log('recall_any@k:');
  for (const k of K_LIST) console.log(`  R@${k}: ${s.recall_any[k].toFixed(1)}%`);
  console.log(`MRR: ${s.mrr.toFixed(3)}`);
}

/**
 * Stream a top-level JSON array of objects, invoking onObject(obj) per element.
 * Depth scanner that respects string literals + escapes — handles the 2.74 GB _M
 * file without ever holding a >512 MB string.
 */
export async function streamArray(path, onObject) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let inString = false, escape = false, depth = 0, collecting = false;
  let parts = [];
  for await (const chunk of stream) {
    let sliceStart = collecting ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inString) {
        if (escape) escape = false;
        else if (c === 92) escape = true;
        else if (c === 34) inString = false;
        continue;
      }
      if (c === 34) { inString = true; continue; }
      if (c === 123 || c === 91) {
        if (depth === 1 && c === 123) { collecting = true; sliceStart = i; }
        depth += 1;
      } else if (c === 125 || c === 93) {
        depth -= 1;
        if (depth === 1 && c === 125) {
          parts.push(chunk.slice(sliceStart < 0 ? 0 : sliceStart, i + 1));
          await onObject(JSON.parse(parts.join('')));
          parts = []; collecting = false; sliceStart = -1;
        }
      }
    }
    if (collecting) parts.push(chunk.slice(sliceStart < 0 ? 0 : sliceStart));
  }
}

async function main() {
  const { getEmbedder } = await import('../../src/embedding/embedder.js');
  const args = process.argv.slice(2);
  const dataPath = args.find((a) => !a.startsWith('--'))
    || 'C:/Users/studi/silo-eval-data/longmemeval/longmemeval_s_cleaned.json';
  const label = (args.find((a) => a.startsWith('--label=')) || '').split('=')[1] || dataPath;
  const retriever = (args.find((a) => a.startsWith('--retriever=')) || '--retriever=lexical').split('=')[1];
  const queryMode = (args.find((a) => a.startsWith('--query=')) || '--query=keywords').split('=')[1];
  const emitPath = (args.find((a) => a.startsWith('--emit=')) || '').split('=')[1] || null;

  let embedder = null;
  if (retriever === 'semantic' || retriever === 'hybrid') {
    embedder = await getEmbedder({ siloDir: process.env.SILO_DIR, env: process.env });
    if (!embedder) { console.error(`retriever=${retriever} needs the model — run \`silo semantic install\` + SILO_SEMANTIC=on`); process.exit(2); }
  }

  const acc = makeAcc();
  await streamArray(dataPath, async (q) => {
    const gold = deriveGold(q);
    const top = await rankFor(retriever, q.question, q.haystack_session_ids, q.haystack_sessions, { queryMode, embedder });
    scoreRanking(q, top, gold, acc, { emit: !!emitPath });
  });

  if (emitPath) {
    writeFileSync(emitPath, `${acc.emit.map((e) => JSON.stringify(e)).join('\n')}\n`);
    console.log(`emitted ${acc.emit.length} rankings → ${emitPath}`);
  }
  printSummary(summarize(acc, { label, retriever }));
}

// Run only when invoked directly (importable for offline tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('run-longmemeval.js')) {
  main();
}
