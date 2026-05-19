/**
 * Context pack v0 — Stage 2 of the universal-client compatibility work.
 *
 * Given a free-form task description, return a small curated bundle of
 * relevant topics + Layer 2 excerpts that a generic MCP client (e.g.
 * ChatGPT) can use as a launchpad without first reading the entire index.
 *
 * Ranking is delegated to the silo CLI's BM25 backend (`silo search
 * --mode=context`, which runs through src/retrieval/index.js + minisearch).
 * Reusing the CLI keeps the v0/v1 gap small — Stage 3 can replace this
 * subprocess call with smarter ranking (semantic, hybrid) without
 * changing the MCP tool's API surface.
 *
 * Pure-fs / pure-data helpers — no MCP SDK imports — so the silo
 * workspace test runner can exercise the module without silo-mcp/node_modules.
 * spawnSync is injectable for unit tests.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';

const LAYER2_EXCERPT_MAX_CHARS = 1500;

// BM25 confidence thresholds. Eyeballed from the existing silo CLI's
// context_retrieval score distribution — single-token AND-mode hits typically
// land in [1.5, 4], multi-token hits clear 4 only when query terms strongly
// match slug + tags. Revisit once real ChatGPT usage data exists (Stage 3).
const CONFIDENCE_THRESHOLD_HIGH = 4;
const CONFIDENCE_THRESHOLD_MEDIUM = 1.5;

const SEARCH_TIMEOUT_MS = 5000;

/**
 * Shell out to `silo search --mode=context` and parse the JSON envelope.
 * Returns `{ results: [...] }` on success or `{ error: { code, message } }`.
 *
 * @param {Object} opts
 * @param {string} opts.task       - free-form task description (the search query)
 * @param {number} opts.maxTopics  - upper bound on returned topics
 * @param {string} opts.siloDir    - path to operation-log dir (e.g. /root/.silo)
 * @param {string} opts.siloCli    - path to silo CLI entry (e.g. /root/silo/src/cli/silo.js)
 * @param {Function} [opts.spawnFn] - DI seam: defaults to child_process.spawnSync
 * @returns {{results: Array}|{error: {code, message}}}
 */
export function rankTopicsByBM25({
  task,
  maxTopics,
  siloDir,
  siloCli,
  spawnFn = defaultSpawnSync,
}) {
  if (typeof task !== 'string' || task.trim().length === 0) {
    return { error: { code: 'TASK_REQUIRED', message: 'task argument is required' } };
  }
  const r = spawnFn('node', [
    siloCli, 'search', task,
    '--mode=context',
    `--limit=${maxTopics}`,
    `--silo-dir=${siloDir}`,
  ], { encoding: 'utf-8', timeout: SEARCH_TIMEOUT_MS });

  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
    return { error: { code: 'SEARCH_TIMEOUT', message: `silo search timed out after ${SEARCH_TIMEOUT_MS}ms` } };
  }
  if (r.error) {
    return { error: { code: 'SEARCH_SPAWN_FAILED', message: r.error.message } };
  }
  if (r.status !== 0) {
    return { error: { code: 'SEARCH_FAILED', message: r.stderr || r.stdout || `silo search exit ${r.status}` } };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    return { error: { code: 'SEARCH_PARSE_FAILED', message: `silo search stdout not JSON: ${err.message}` } };
  }
  return { results: Array.isArray(parsed.results) ? parsed.results : [] };
}

/**
 * Map a best BM25 score into a confidence bucket.
 *
 * @param {number|null|undefined} bestScore
 * @returns {'high'|'medium'|'low'}
 */
export function mapConfidence(bestScore) {
  if (typeof bestScore !== 'number' || !Number.isFinite(bestScore)) return 'low';
  if (bestScore >= CONFIDENCE_THRESHOLD_HIGH) return 'high';
  if (bestScore >= CONFIDENCE_THRESHOLD_MEDIUM) return 'medium';
  return 'low';
}

/**
 * Build the recommended_next_tool_calls hints based on confidence.
 * Generic LLM-readable strings (not structured) — match OpenAI Apps SDK
 * convention; callers parse them as hints rather than machine instructions.
 *
 * @param {Object} opts
 * @param {'high'|'medium'|'low'} opts.confidence
 * @param {Array<{slug: string}>} opts.selectedTopics
 * @param {string} opts.task
 * @returns {string[]}
 */
export function buildRecommendedNextCalls({ confidence, selectedTopics, task }) {
  // Low-confidence path leads with search (per spec) — the context pack
  // failed to find relevant topics, so go broader before drilling down.
  if (confidence === 'low' || selectedTopics.length === 0) {
    return [
      `search "${task}" for evidence — context pack ranking found no strong matches`,
      'read_index to enumerate available topics if the task description doesn\'t map to known slugs',
    ];
  }
  const calls = [];
  for (const t of selectedTopics) {
    calls.push(`fetch "topic:${t.slug}" for full curated Layer 2`);
  }
  if (confidence === 'medium') {
    calls.push(`search "${task}" for source evidence if curated facts are insufficient`);
  }
  return calls;
}

/**
 * Compose the final context-pack envelope from ranked CLI results +
 * per-slug Layer 2 excerpts. Pure: callers load Layer 2 externally
 * (via the existing extractLayer2 helper) and inject it here.
 *
 * @param {Object} opts
 * @param {string} opts.task
 * @param {Array<{slug, score, preview?}>} opts.ranked - silo search results
 * @param {Map<string, {title?: string, layer2: string}>} opts.detailsBySlug
 *        - map from slug to topic header + extracted Layer 2 string. Missing
 *          slugs are dropped (skip silently — the CLI may rank a topic that
 *          has no projection on disk yet during a regen race).
 * @returns {Object} envelope: { task, selected_topics[], confidence,
 *                               recommended_next_tool_calls[] }
 */
export function buildContextPackEnvelope({ task, ranked, detailsBySlug }) {
  const selected = [];
  for (const r of ranked) {
    const details = detailsBySlug.get(r.slug);
    if (!details) continue;
    const layer2 = details.layer2 || '';
    const excerpt = layer2.length > LAYER2_EXCERPT_MAX_CHARS
      ? layer2.slice(0, LAYER2_EXCERPT_MAX_CHARS) + '…'
      : layer2;
    // Compose a terse "why_selected" — BM25 score is the truth, but a string
    // hint is what a generic LLM client can show its user.
    const why = `BM25 score ${r.score.toFixed(2)} — silo CLI context_retrieval ranked this topic against the task description.`;
    selected.push({
      slug: r.slug,
      title: details.title ?? r.slug,
      score: r.score,
      why_selected: why,
      curated_facts_excerpt: excerpt || (r.preview ?? ''),
      metadata: {
        source_type: 'topic',
        topic_slug: r.slug,
        layer: 2,
      },
    });
  }
  const bestScore = selected.length > 0 ? selected[0].score : null;
  const confidence = mapConfidence(bestScore);
  const recommended_next_tool_calls = buildRecommendedNextCalls({
    confidence,
    selectedTopics: selected,
    task,
  });
  return {
    task,
    selected_topics: selected,
    confidence,
    recommended_next_tool_calls,
  };
}
