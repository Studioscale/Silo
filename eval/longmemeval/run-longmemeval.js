#!/usr/bin/env node
/**
 * Track A — LongMemEval session-retrieval eval for Silo's search engine.
 *
 * WHAT THIS MEASURES (read before quoting any number):
 *   This benchmarks Silo's RETRIEVAL ENGINE — MiniSearch (BM25-family lexical:
 *   TF-IDF + fuzzy + prefix), the same engine `silo search` uses — on
 *   LongMemEval's session-retrieval task. It does NOT measure Silo's curation /
 *   topic organization / audit trail (LongMemEval doesn't test those). It is a
 *   head-to-head of Silo's lexical engine vs the semantic engines other memory
 *   systems report, on the SAME benchmark + SAME metric.
 *
 * THE METRIC: session-level `recall_any@k` — for each question, did ANY gold
 *   evidence session (answer_session_ids) land in the top-k retrieved sessions.
 *   This is exactly the metric behind MemPalace's "96.6% R@5 on LongMemEval_S"
 *   (stock ChromaDB + all-MiniLM-L6-v2). Comparability requires matching all of:
 *     (a) variant — _S (~50 sessions) vs _M (500 sessions); ~96% figures are _S.
 *     (b) granularity — SESSION (this) vs turn. Session is ~14pts easier.
 *     (c) retrieval recall, NOT end-to-end QA accuracy (MemPalace's own QA ≈82.6%).
 *
 * ENGINE FAITHFULNESS: the MiniSearch config below mirrors
 *   src/retrieval/index.js `contextRetrieval` (content field, fuzzy 0.3, prefix,
 *   AND-combine with OR fallback) — Silo's "most relevant memory" search path.
 *
 * Streams the dataset element-by-element (the _M file is 2.74 GB — past V8's
 * max string length, so it can't be read whole). No LLM calls. Deterministic.
 * Usage:  node eval/longmemeval/run-longmemeval.js <dataset.json> [--label=NAME]
 */

import { createReadStream, writeFileSync } from 'node:fs';
import MiniSearch from 'minisearch';
import { normalizeQuery } from '../../src/retrieval/index.js';

const DEFAULT_S = 'C:/Users/studi/silo-eval-data/longmemeval/longmemeval_s_cleaned.json';
const args = process.argv.slice(2);
const dataPath = args.find((a) => !a.startsWith('--')) || DEFAULT_S;
const label = (args.find((a) => a.startsWith('--label=')) || '').split('=')[1] || dataPath;
const K_LIST = [1, 3, 5, 10];

// ── Lexical levers (cheap, no new dependency; each maps to a real Silo change) ──
//   --chunk=session|turn   index unit: whole session (baseline) vs per-turn chunk
//   --query=raw|keywords   query: raw question vs Silo's tokenize() (stop-words stripped)
const chunkMode = (args.find((a) => a.startsWith('--chunk=')) || '--chunk=session').split('=')[1];
const queryMode = (args.find((a) => a.startsWith('--query=')) || '--query=raw').split('=')[1];
// --emit=<path>: also write per-question ranked session ids as JSONL, for the
// official cross-check (scored by LongMemEval's own evaluate_retrieval in Python).
const emitPath = (args.find((a) => a.startsWith('--emit=')) || '').split('=')[1] || null;

function sessionText(session) {
  if (!Array.isArray(session)) return '';
  return session
    .map((t) => (typeof t?.content === 'string' ? t.content : JSON.stringify(t?.content ?? '')))
    .join('\n');
}

function turnText(turn) {
  return typeof turn?.content === 'string' ? turn.content : JSON.stringify(turn?.content ?? '');
}

// Build the indexed docs for one question's haystack. `session` = one doc per
// session (baseline); `turn` = one doc per turn (finer granularity), each
// carrying its session id so hits map back to sessions.
function buildDocs(sessionIds, sessions) {
  if (chunkMode === 'turn') {
    const docs = [];
    let id = 0;
    sessions.forEach((s, si) => {
      (Array.isArray(s) ? s : []).forEach((turn) => {
        docs.push({ id: id++, sid: sessionIds[si], content: turnText(turn) });
      });
    });
    return docs;
  }
  return sessions.map((s, i) => ({ id: i, sid: sessionIds[i], content: sessionText(s) }));
}

// Mirror src/retrieval/index.js contextRetrieval: lexical content match, fuzzy
// 0.3 + prefix, AND-combine then OR fallback. Returns ranked DISTINCT session
// ids (chunk hits collapse to their session, first-seen order).
function rankedSessions(question, sessionIds, sessions) {
  const mini = new MiniSearch({ fields: ['content'], storeFields: ['sid'] });
  mini.addAll(buildDocs(sessionIds, sessions));
  // keywords mode uses Silo's REAL query normalizer (src/retrieval/index.js),
  // so this confirms the shipped fix, not a replica of it.
  const q = queryMode === 'keywords' ? normalizeQuery(question) : question;
  const opts = { boost: { content: 1 }, fuzzy: 0.3, prefix: true };
  let hits = mini.search(q, { ...opts, combineWith: 'AND' });
  if (hits.length === 0) hits = mini.search(q, { ...opts, combineWith: 'OR' });
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (!seen.has(h.sid)) { seen.add(h.sid); out.push(h.sid); }
  }
  return out;
}

function makeAcc() {
  const agg = {};
  for (const k of K_LIST) agg[k] = { any: 0, all: 0 };
  return { agg, mrrSum: 0, n: 0, skipped: 0, byType: {}, emit: [] };
}

function scoreInstance(q, acc) {
  const gold = new Set(q.answer_session_ids || []);
  if (gold.size === 0) { acc.skipped += 1; return; }
  acc.n += 1;
  const top = rankedSessions(q.question, q.haystack_session_ids, q.haystack_sessions);

  if (emitPath) {
    acc.emit.push({
      question_id: q.question_id,
      question_type: q.question_type,
      ranked_session_ids: top,
      answer_session_ids: [...gold],
    });
  }

  let firstRank = 0;
  for (let i = 0; i < top.length; i++) {
    if (gold.has(top[i])) { firstRank = i + 1; break; }
  }
  acc.mrrSum += firstRank ? 1 / firstRank : 0;

  for (const k of K_LIST) {
    const topk = top.slice(0, k);
    if (topk.some((id) => gold.has(id))) acc.agg[k].any += 1;
    if ([...gold].every((id) => topk.includes(id))) acc.agg[k].all += 1;
  }

  const t = q.question_type || 'unknown';
  acc.byType[t] = acc.byType[t] || { n: 0, any5: 0 };
  acc.byType[t].n += 1;
  if (top.slice(0, 5).some((id) => gold.has(id))) acc.byType[t].any5 += 1;
}

function finalize(acc) {
  const { agg, mrrSum, n, skipped, byType } = acc;
  const pct = (x) => `${(100 * x / n).toFixed(1)}%`;
  console.log('═══ LongMemEval session-retrieval — Silo BM25 (MiniSearch) engine ═══');
  console.log(`dataset: ${label}  |  index=${chunkMode}  query=${queryMode}`);
  console.log(`questions scored: ${n}${skipped ? ` (skipped ${skipped} with no gold)` : ' (all have ≥1 gold session)'}`);
  console.log('');
  console.log('recall_any@k  (any gold session in top-k — comparable to MemPalace 96.6% R@5):');
  for (const k of K_LIST) console.log(`  R@${k}:  ${pct(agg[k].any)}`);
  console.log(`  MRR:  ${(mrrSum / n).toFixed(3)}`);
  console.log('');
  console.log('recall_all@k  (ALL gold sessions in top-k — stricter, for multi-session Qs):');
  for (const k of K_LIST) console.log(`  R@${k}:  ${pct(agg[k].all)}`);
  console.log('');
  console.log('recall_any@5 by question type:');
  for (const [t, v] of Object.entries(byType).sort()) {
    console.log(`  ${t.padEnd(28)} ${(100 * v.any5 / v.n).toFixed(1)}%  (n=${v.n})`);
  }
}

/**
 * Stream a top-level JSON array of objects, invoking onObject(obj) per element.
 * Brace/bracket-depth scanner that respects string literals + escapes, so it
 * handles the 2.74 GB _M file without ever holding the whole file (or a >512 MB
 * string) in memory. Accumulates element text by chunk-slice (not char-append).
 */
async function streamArray(path, onObject) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let inString = false, escape = false, depth = 0, collecting = false;
  let parts = [];
  for await (const chunk of stream) {
    let sliceStart = collecting ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inString) {
        if (escape) escape = false;
        else if (c === 92) escape = true;      // backslash
        else if (c === 34) inString = false;   // closing quote
        continue;
      }
      if (c === 34) { inString = true; continue; } // opening quote
      if (c === 123 || c === 91) {                 // { or [
        if (depth === 1 && c === 123) { collecting = true; sliceStart = i; }
        depth += 1;
      } else if (c === 125 || c === 93) {          // } or ]
        depth -= 1;
        if (depth === 1 && c === 125) {            // element object closed
          parts.push(chunk.slice(sliceStart < 0 ? 0 : sliceStart, i + 1));
          onObject(JSON.parse(parts.join('')));
          parts = [];
          collecting = false;
          sliceStart = -1;
        }
      }
    }
    if (collecting) parts.push(chunk.slice(sliceStart < 0 ? 0 : sliceStart));
  }
}

async function main() {
  const acc = makeAcc();
  await streamArray(dataPath, (q) => scoreInstance(q, acc));
  if (emitPath) {
    writeFileSync(emitPath, `${acc.emit.map((e) => JSON.stringify(e)).join('\n')}\n`);
    console.log(`emitted ${acc.emit.length} rankings → ${emitPath}`);
  }
  finalize(acc);
}

main();
