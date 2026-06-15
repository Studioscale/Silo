import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { readFile, writeFile, stat, readdir, access } from 'fs/promises';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import {
  buildSiloNotices,
  loadPendingSuggestions,
  loadUpdateStatus,
  loadCurateStatus,
  loadCurateEmit,
  isUpdateOptOut,
  isCurateLivenessOptOut,
} from './notices.js';
import {
  parseFetchId,
  fetchTopic,
  enrichSearchResults,
} from './fetch.js';
import { buildBootstrapContract } from './bootstrap-contract.js';
import {
  rankTopicsByBM25,
  buildContextPackEnvelope,
} from './context-pack.js';

// Tool-annotation hints (MCP SDK 1.29+). readOnlyHint/idempotentHint inform
// generic clients about side-effect posture; OpenAI Apps SDK security
// guidance leans on these for least-privilege + confirmation prompts.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const WRITE_SIDE_EFFECT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
// retire_bullet: the append-only log makes a bullet recoverable by re-curation,
// but ONE seq can remove a whole import-origin "## Heading" section — so a
// generic client should treat it as destructive and confirm first.
const WRITE_DESTRUCTIVE = { ...WRITE_SIDE_EFFECT, destructiveHint: true };

// ── Constants ──────────────────────────────────────────────────────────────

// Phase 2.2 + 2.3 added explicit env overrides for the data + source dirs so
// the MCP server can run against a local checkout for development (the
// production VPS defaults match the install layout).
const SILO_BASE = process.env.SILO_BASE || '/root/clawd-v3';
const SILO_DIR = process.env.SILO_DIR || '/root/.silo';
const SILO_SRC_DIR = process.env.SILO_SRC_DIR || '/root/silo';
const SILO_CLI = `${SILO_SRC_DIR}/src/cli/silo.js`;
// Server-deployment principal for ALL MCP write tools (write_event / accept /
// dismiss / retire). NOT caller identity — the transport has only a shared
// bearer token, so this records WHICH deployment wrote the event, overridable
// per-instance (e.g. a Jarvis-only or ChatGPT-only front-end). Default
// preserves prior behavior so a single caller never logs under two principals.
const MCP_PRINCIPAL = process.env.SILO_MCP_PRINCIPAL || 'desktop-claude';
const TOPIC_INDEX_PATH = join(SILO_BASE, 'TOPIC-INDEX.md');
const TOPICS_DIR = join(SILO_BASE, 'topics');
const EVENTS_DIR = join(SILO_BASE, 'events');
const PENDING_SUGGESTIONS_PATH = join(SILO_BASE, 'PENDING-SUGGESTIONS.json');
// Phase 2.3: update-status.json lives under SILO_DIR (the data dir) NOT
// SILO_BASE (the projection target). Pinned to SILO_DIR per spec §3.4 +
// round-1 ChatGPT F2 fix — the MCP server was previously reading from the
// projection target by default, which the CLI never writes.
const UPDATE_STATUS_PATH = join(SILO_DIR, 'update-status.json');
// Curate-liveness caches live under SILO_DIR (the data dir) alongside
// update-status.json — the CLI writes them there, the bridge reads them.
// curate-status.json: cron-written verdict. curate-emit.json: read-path-written
// cooldown stamp (this server is its ONLY writer — the split is the dual-writer
// race fix, SPEC-curate-liveness §5.5).
const CURATE_STATUS_PATH = join(SILO_DIR, 'curate-status.json');
const CURATE_EMIT_PATH = join(SILO_DIR, 'curate-emit.json');
const HANDOFF_DIR = join(SILO_BASE, 'handoff/cc-to-jarvis');
const HANDOFF_PROCESSED_DIR = join(HANDOFF_DIR, 'processed');

const VALID_TAGS = ['DECISION', 'FACT', 'CHANGED', 'PROCEDURE', 'TODO', 'EVENT'];
const VALID_CONFIDENCES = ['CONFIRMED', 'TENTATIVE', 'CONTEXT'];

const STOP_WORDS_PT = new Set([
  'de', 'a', 'o', 'e', 'do', 'da', 'em', 'um', 'uma', 'para', 'com',
  'que', 'na', 'no', 'os', 'as', 'se', 'ao', 'dos', 'das', 'por',
]);
const STOP_WORDS_EN = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'not', 'and', 'or', 'but', 'if',
  'then', 'than', 'so', 'at', 'by', 'for', 'in', 'of', 'on', 'to',
  'with', 'from', 'up', 'out', 'into', 'over', 'after',
]);

// ── Utility Functions ──────────────────────────────────────────────────────

function tokenize(text) {
  const tokens = text.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);
  return new Set(tokens.filter(t => !STOP_WORDS_PT.has(t) && !STOP_WORDS_EN.has(t) && t.length > 1));
}

function jaccard(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Event line regex — handles both manual [TAG] and auto [AUTO-TAG:CONFIDENCE] formats
const EVENT_LINE_RE = /^\[(?:AUTO-)?(DECISION|FACT|CHANGED|PROCEDURE|TODO|EVENT|SECURITY|CURATION)(?::(CONFIRMED|TENTATIVE|CONTEXT))?\]\s+([a-z0-9-]+):\s+(?:\[([^\]]+)\]\s+)?(.+)$/;

function parseEventLine(line) {
  const m = line.match(EVENT_LINE_RE);
  if (!m) return null;
  return {
    tag: m[1],
    confidence: m[2] || null,
    slug: m[3],
    source: m[4] || null,
    content: m[5],
    raw_line: line,
  };
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const header = {};
  for (const line of match[1].split('\n')) {
    // Handle multi-line values like summary: >
    const kv = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (kv) {
      let val = kv[2].trim();
      // Parse arrays: [a, b, c]
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim());
      }
      header[kv[1]] = val;
    }
  }
  return header;
}

function extractLayer2(text) {
  const startMarker = '<!-- CURATED_START -->';
  const endMarker = '<!-- CURATED_END -->';
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return '';
  return text.slice(startIdx + startMarker.length, endIdx).trim();
}

// ── TOPIC-INDEX Cache ──────────────────────────────────────────────────────

let indexCache = { content: null, mtime: null, slugs: null, topics: null };

async function loadTopicIndex() {
  try {
    const st = await stat(TOPIC_INDEX_PATH);
    const mtime = st.mtimeMs;
    if (indexCache.mtime === mtime && indexCache.content) {
      return indexCache;
    }
    const raw = await readFile(TOPIC_INDEX_PATH, 'utf-8');
    const topics = [];
    const slugs = new Set();
    // Parse pipe-delimited lines inside code block
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('`') ||
          trimmed.startsWith('Last generated') || trimmed.startsWith('Auto-generated')) continue;
      const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
      const parts = stripped.split('|').map(p => p.trim());
      if (parts.length >= 5 && parts[0]) {
        const slug = parts[0];
        const type = parts[1];
        const tags = parts[2].split(',').map(t => t.trim()).filter(Boolean);
        const status = parts[3];
        const summary = parts[4];
        topics.push({ slug, type, tags, status, summary });
        slugs.add(slug);
      }
    }
    if (topics.length === 0) {
      throw { code: 'INDEX_PARSE_ERROR', message: 'TOPIC-INDEX.md parsed to zero valid topics' };
    }
    indexCache = { content: raw, mtime, slugs, topics };
    return indexCache;
  } catch (err) {
    if (err.code === 'INDEX_PARSE_ERROR') throw err;
    throw { code: 'FS_ERROR', message: `Failed to read TOPIC-INDEX.md: ${err.message}` };
  }
}

function errorResult(code, message, suggestion) {
  const result = { success: false, error: message, code };
  if (suggestion) result.suggestion = suggestion;
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
}

function successResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// M3 admission-gate error surfacing — the silo CLI dispatcher prints
// `silo <cmd>: ADMISSION_REFUSED:<code> — <details>` when LogWriter's
// matrix gate refuses a write (proposals/m3-admission-gate.md §5.1).
// Pull the code out of stderr so MCP callers see a structured admission
// failure distinct from generic CLI / payload-validation errors.
const ADMISSION_RE = /ADMISSION_REFUSED:([A-Z_]+) —/;
function extractAdmissionCode(stderr) {
  if (!stderr) return null;
  const m = stderr.match(ADMISSION_RE);
  return m ? m[1] : null;
}

/**
 * Build a structured MCP error result from a failed CLI spawn — shared by the
 * CLI-shell write tools (accept_suggestion / dismiss_suggestion / retire_bullet).
 * Pulls the ADMISSION_REFUSED token first, then the `silo <cmd>: <CODE> —` token;
 * attaches any trailing pretty-printed detail JSON the CLI emitted.
 *
 * @param {{stderr?:string, stdout?:string}} r - spawnSync result (status !== 0)
 * @param {RegExp} codeRe - captures the op-error CODE from stderr (group 1)
 * @param {string} fallbackCode - code when neither token is present
 * @param {string} failMsg - default human message
 */
function cliSpawnError(r, codeRe, fallbackCode, failMsg) {
  const admissionCode = extractAdmissionCode(r.stderr);
  const m = (r.stderr || '').match(codeRe);
  const code = admissionCode || (m ? m[1] : fallbackCode);
  // The detail JSON is pretty-printed on its own line(s). Anchor the opening
  // brace to line-start (/m) so a `{` inside the error message can't trigger a
  // spurious match (tightens the previous bare /(\{[\s\S]*\})/).
  let detail = null;
  const detailMatch = (r.stderr || '').match(/^(\{[\s\S]*\})/m);
  if (detailMatch) { try { detail = JSON.parse(detailMatch[1]); } catch { /* ignore */ } }
  const err = errorResult(code, r.stderr || r.stdout || failMsg);
  if (detail) {
    try {
      const obj = JSON.parse(err.content[0].text);
      obj.detail = detail;
      err.content[0].text = JSON.stringify(obj, null, 2);
    } catch { /* shouldn't happen */ }
  }
  return err;
}

function todayStr() {
  // Use BRT (UTC-3)
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

// Shared notice builder for read_index / search / list_handoffs. Phase 2.2
// contributes pending_topic_suggestions; Phase 2.3 adds update_available /
// update_check_unhealthy when update-status.json is present AND
// SILO_DISABLE_UPDATE_CHECK is not set (spec §3.6 / §5).
async function siloNoticesForRead() {
  const updateStatus = await loadUpdateStatus(UPDATE_STATUS_PATH);
  const curateStatus = await loadCurateStatus(CURATE_STATUS_PATH); // discriminated envelope (L1/L2)
  const curateEmit = await loadCurateEmit(CURATE_EMIT_PATH);
  return buildSiloNotices({
    pendingPath: PENDING_SUGGESTIONS_PATH,
    updateStatus,
    updateCheckDisabled: isUpdateOptOut(),
    curateStatus,
    curateEmit,
    curateLivenessDisabled: isCurateLivenessOptOut(),
    curateEmitPath: CURATE_EMIT_PATH,
  });
}

/** Spawn `silo regenerate` after a successful accept/dismiss/retire. Returns bool. */
function regenerateAfterWrite() {
  const r = spawnSync('node', [
    SILO_CLI, 'regenerate',
    `--silo-dir=${SILO_DIR}`,
    `--to=${SILO_BASE}`,
  ], { encoding: 'utf-8' });
  if (r.status === 0) {
    // Restore ownership for the OpenClaw container (uid 1000) — same as the
    // write_event path. The regen rewrites files as root; this keeps the
    // container's read access uniform across all four MCP write tools. Non-fatal.
    spawnSync('chown', ['-R', '1000:1000', join(SILO_BASE, 'events')], { encoding: 'utf-8' });
    // Invalidate caches the regen affects.
    indexCache = { content: null, mtime: null, slugs: null, topics: null };
  }
  return r.status === 0;
}

// ── Tool Registration ─────────────────────────────────────────────────────

function registerTools(server) {

// ── Tool: silo_bootstrap (Stage 2 — universal-client compat) ───────────────
//
// Returns the structured contract describing Silo's memory model, retrieval
// rules, write policy, and tool catalog. Generic MCP clients (e.g. ChatGPT)
// call this ONCE per session to learn the rules that CLAUDE.md gives a
// Claude Code session — there is no equivalent project-side instruction
// surface for non-Claude-Code clients.
//
// registerTool (vs. tool()) so the response declares outputSchema. The
// handler returns BOTH structuredContent (machine-readable) AND
// content[0].text (JSON-encoded) per OpenAI MCP guidance — older clients
// that ignore structuredContent still get the JSON payload as text.

server.registerTool(
  'silo_bootstrap',
  {
    description: 'Return Silo\'s universal-client contract: memory model, retrieval rules, write policy, and tool catalog. Read-only. Call ONCE per new client session and cache the result; do not call repeatedly. This is the rule book non-Claude-Code clients need before invoking other Silo tools.',
    inputSchema: {},
    outputSchema: {
      system: z.string(),
      purpose: z.string(),
      contract_version: z.string(),
      capabilities: z.object({}).passthrough(),
      rules: z.object({}).passthrough(),
      memory_model: z.object({}).passthrough(),
      tools: z.object({}).passthrough(),
    },
    annotations: READ_ONLY,
  },
  async () => {
    const contract = buildBootstrapContract();
    return {
      structuredContent: contract,
      content: [{ type: 'text', text: JSON.stringify(contract, null, 2) }],
    };
  },
);

// ── Tool: silo_context_pack_v0 (Stage 2 — universal-client compat) ─────────
//
// Given a free-form task description, return a small curated bundle of
// relevant topics + Layer 2 excerpts. Ranking is delegated to the existing
// `silo search --mode=context` CLI (BM25 backend via minisearch), so v0
// stays consistent with what `search` already produces — Stage 3 can
// replace the subprocess call with smarter ranking (semantic, hybrid)
// without changing this tool's API surface.
//
// Implementation lives in silo-mcp/context-pack.js (pure-data + injectable
// spawn) for test isolation. Layer 2 is loaded here from the projection
// because extractLayer2 / loadTopicIndex already exist in server.js.

server.registerTool(
  'silo_context_pack_v0',
  {
    description: 'Given a task description, return a small curated bundle of relevant Silo topics (slug + Layer 2 excerpt) plus a confidence rating and recommended next tool calls. Read-only. Best FIRST call for a vague task when the relevant slug is unknown. Ranking is BM25-deterministic via the silo CLI; semantic ranking is reserved for v1+.',
    inputSchema: {
      task: z.string().min(1).max(500).describe('Free-form task description — the user\'s ask, in their words'),
      max_topics: z.number().int().min(1).max(10).optional().describe('Max topics to return (default 3)'),
      max_search_results: z.number().int().min(1).max(20).optional().describe('Reserved for v1+ (split search vs. topic budgets); v0 ignores this'),
    },
    outputSchema: {
      task: z.string(),
      selected_topics: z.array(z.object({
        slug: z.string(),
        title: z.string(),
        score: z.number(),
        why_selected: z.string(),
        curated_facts_excerpt: z.string(),
        metadata: z.object({}).passthrough(),
      })),
      confidence: z.enum(['high', 'medium', 'low']),
      recommended_next_tool_calls: z.array(z.string()),
      _silo_notices: z.array(z.object({}).passthrough()).optional(),
    },
    annotations: READ_ONLY,
  },
  async ({ task, max_topics }) => {
    const maxTopics = max_topics ?? 3;
    const ranked = rankTopicsByBM25({
      task,
      maxTopics,
      siloDir: SILO_DIR,
      siloCli: SILO_CLI,
    });
    if (ranked.error) {
      return errorResult(ranked.error.code, ranked.error.message);
    }

    // Load Layer 2 for each ranked slug. Skipping missing files keeps the
    // envelope robust against a regen race (CLI ranked a topic before its
    // projection caught up).
    const detailsBySlug = new Map();
    let knownSlugs;
    try {
      const idx = await loadTopicIndex();
      knownSlugs = idx.slugs;
      // Build a slug → summary lookup so titles in the envelope are friendlier
      // than the raw slug.
      const summaryBySlug = new Map(idx.topics.map(t => [t.slug, t.summary]));
      for (const r of ranked.results) {
        if (!knownSlugs.has(r.slug)) continue;
        try {
          const text = await readFile(join(TOPICS_DIR, `${r.slug}.md`), 'utf-8');
          detailsBySlug.set(r.slug, {
            title: summaryBySlug.get(r.slug) || r.slug,
            layer2: extractLayer2(text),
          });
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          // Missing projection file — skip silently (regen race).
        }
      }
    } catch (err) {
      return errorResult(err.code || 'FS_ERROR', err.message);
    }

    const envelope = buildContextPackEnvelope({
      task,
      ranked: ranked.results,
      detailsBySlug,
    });
    const notices = await siloNoticesForRead();
    if (notices) envelope._silo_notices = notices;
    return {
      structuredContent: envelope,
      content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    };
  },
);

// ── Tool 1: read_index ─────────────────────────────────────────────────────

server.tool(
  'read_index',
  'Discover available topics. Returns one-line summaries (slug, type, tags, status, summary) — NOT full topic content. Call FIRST when you need to identify which topic is relevant before loading it. Safe to call without context.',
  {},
  READ_ONLY,
  async () => {
    try {
      const idx = await loadTopicIndex();
      const result = { topics: idx.topics };
      const notices = await siloNoticesForRead();
      if (notices) result._silo_notices = notices;
      return successResult(result);
    } catch (err) {
      return errorResult(err.code || 'FS_ERROR', err.message);
    }
  }
);

// ── Tool 2: get_topic ──────────────────────────────────────────────────────

server.tool(
  'get_topic',
  'Load a single topic\'s curated memory (Layer 2 + header). Does NOT return Layer 3 raw source material — use `search` or `fetch` with a Layer-3 ID for that. Prefer this over search when the slug is known. Call AFTER read_index identifies the slug.',
  { slug: z.string().describe('Topic slug — must exist in TOPIC-INDEX.md') },
  READ_ONLY,
  async ({ slug }) => {
    try {
      const idx = await loadTopicIndex();
      if (!idx.slugs.has(slug)) {
        return errorResult('SLUG_NOT_FOUND',
          `Slug "${slug}" not found in TOPIC-INDEX.md`,
          `Valid slugs: ${[...idx.slugs].join(', ')}`);
      }
      const filePath = join(TOPICS_DIR, `${slug}.md`);
      const text = await readFile(filePath, 'utf-8');
      const header = parseFrontmatter(text);
      const curated = extractLayer2(text);
      return successResult({ slug, header, curated });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return errorResult('FILE_NOT_FOUND', `Topic file topics/${slug}.md not found on disk`);
      }
      return errorResult(err.code || 'FS_ERROR', err.message || String(err));
    }
  }
);

// ── Tool 3: read_events ────────────────────────────────────────────────────

server.tool(
  'read_events',
  'Read tagged event log entries by date. Defaults to today. Each entry is a single line `[TAG] slug: content`. Filters available for source and slug. Read-only.',
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Most recent date (YYYY-MM-DD, default: today)'),
    days_back: z.number().int().min(1).max(30).optional().describe('How many days of history (default: 1)'),
    exclude_source: z.string().optional().describe('Filter out entries from this source tag'),
    slug_filter: z.string().optional().describe('Only return entries matching this topic slug'),
  },
  READ_ONLY,
  async ({ date, days_back, exclude_source, slug_filter }) => {
    const endDate = date || todayStr();
    const numDays = days_back || 1;
    const entries = [];

    for (let i = 0; i < numDays; i++) {
      const d = new Date(endDate + 'T12:00:00Z');
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const filePath = join(EVENTS_DIR, `${dateStr}.md`);

      try {
        const text = await readFile(filePath, 'utf-8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('<!--')) continue;
          const parsed = parseEventLine(trimmed);
          if (!parsed) continue;
          if (exclude_source && parsed.source === exclude_source) continue;
          if (slug_filter && parsed.slug !== slug_filter) continue;
          entries.push({ date: dateStr, ...parsed });
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // Non-missing-file error — skip but don't crash
        }
      }
    }
    return successResult({ entries, total_count: entries.length });
  }
);

// ── Tool 4: search ─────────────────────────────────────────────────────────

server.tool(
  'search',
  'Full-text keyword search across all Silo content. Returns results with OpenAI-compatible shape (id, title, text, url, metadata) — so callers can follow up with `fetch` for full content. Results MAY include raw Layer 3 / source material; treat as EVIDENCE, not curated truth. Use when topic relevance is unknown; prefer `get_topic` when you already know the slug.',
  {
    query: z.string().min(1).max(200).describe('Search query'),
    limit: z.number().int().min(1).max(20).optional().describe('Max results (default: 5)'),
  },
  READ_ONLY,
  async ({ query, limit }) => {
    const maxResults = limit || 5;
    // spawnSync with argv (no shell — see Stage-1 security audit response).
    const r = spawnSync('docker', [
      'exec', 'clawdbot-v3-openclaw-gateway-1',
      'node', '/home/node/clawd/bin/memory_search_fts',
      query,
      '--limit', String(maxResults),
    ], { timeout: 10000, encoding: 'utf-8' });

    if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
      return errorResult('SEARCH_TIMEOUT', 'BM25 search timed out after 10 seconds');
    }
    if (r.error) {
      return errorResult('DOCKER_ERROR', `Docker exec failed: ${r.error.message}`);
    }
    if (r.status !== 0) {
      return errorResult('DOCKER_ERROR', `Docker exec exit ${r.status}: ${r.stderr || r.stdout || 'unknown'}`);
    }

    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const rawResults = lines.map((line) => {
      const scoreMatch = line.match(/^score:\s*([\d.]+)\s*\|\s*(.+)$/);
      if (scoreMatch) {
        return { score: parseFloat(scoreMatch[1]), text: scoreMatch[2] };
      }
      return { score: 0, text: line };
    });
    // OpenAI-compatible enrichment: id/title/url/metadata per result.
    // Existing score+text fields preserved for backward compat (the
    // OpenClaw bundle-mcp client reads them directly).
    const results = enrichSearchResults(rawResults, query);
    const out = { results, query, total_matches: results.length };
    const notices = await siloNoticesForRead();
    if (notices) out._silo_notices = notices;
    return successResult(out);
  }
);

// ── Tool: fetch (Stage 1 — universal-client compat) ────────────────────────
//
// OpenAI Apps SDK MCP guidance describes a `fetch` tool that takes an ID
// and returns full content by canonical reference. Silo's `fetch` supports:
//   - topic:<slug>          → curated Layer 2
//   - topic:<slug>#layer-1  → topic header metadata
//   - topic:<slug>#layer-2  → curated Layer 2 (explicit)
// event: and handoff: IDs are reserved for Stage 2.
//
// registerTool used (vs. tool()) so the response declares outputSchema —
// strict MCP clients can validate the shape.

server.registerTool(
  'fetch',
  {
    description: 'Retrieve full content for a known ID. Supports `topic:<slug>` and `topic:<slug>#layer-1|layer-2`. Returns OpenAI-compatible shape: { id, title, text, url, metadata }. Read-only.',
    inputSchema: {
      id: z.string().describe('Canonical Silo ID — e.g. `topic:hs-crm` or `topic:hs-crm#layer-1`'),
    },
    outputSchema: {
      id: z.string(),
      title: z.string(),
      text: z.string(),
      url: z.string(),
      metadata: z.object({
        source_type: z.string(),
        topic_slug: z.string().optional(),
        layer: z.number().int().optional(),
      }).passthrough(),
    },
    annotations: READ_ONLY,
  },
  async ({ id }) => {
    const descriptor = parseFetchId(id);
    if (!descriptor) {
      return errorResult(
        'FETCH_UNKNOWN_ID',
        `Unrecognized fetch ID format: "${id}". Supported: topic:<slug>[#layer-1|layer-2].`,
      );
    }
    if (descriptor.kind === 'event' || descriptor.kind === 'handoff') {
      return errorResult(
        'FETCH_KIND_DEFERRED',
        `Fetch by ${descriptor.kind} ID is reserved for Stage 2; not yet implemented.`,
      );
    }
    if (descriptor.kind === 'topic') {
      try {
        const idx = await loadTopicIndex();
        const out = await fetchTopic({
          descriptor,
          topicsDir: TOPICS_DIR,
          knownSlugs: idx.slugs,
        });
        if (out.error) {
          return errorResult(out.error.code, out.error.message);
        }
        return successResult(out);
      } catch (err) {
        return errorResult(err.code || 'FS_ERROR', err.message);
      }
    }
    return errorResult('FETCH_KIND_UNKNOWN', `Unhandled descriptor kind: ${descriptor.kind}`);
  },
);

// ── Tool 5: list_handoffs ──────────────────────────────────────────────────

server.tool(
  'list_handoffs',
  'List handoff reports (pending or processed). Each report is a markdown file the curator processes manually. Read-only.',
  {
    status: z.enum(['pending', 'processed']).optional().describe('Filter by status (default: pending)'),
  },
  READ_ONLY,
  async ({ status }) => {
    const which = status || 'pending';
    const dir = which === 'processed' ? HANDOFF_PROCESSED_DIR : HANDOFF_DIR;
    try {
      const allFiles = await readdir(dir);
      // For pending, exclude the 'processed' subdirectory
      const files = [];
      for (const f of allFiles) {
        if (f === 'processed') continue;
        const filePath = join(dir, f);
        try {
          const st = await stat(filePath);
          if (st.isFile()) {
            files.push({
              filename: f,
              size_bytes: st.size,
              modified_at: st.mtime.toISOString(),
            });
          }
        } catch { /* skip unreadable files */ }
      }
      const out = { files };
      const notices = await siloNoticesForRead();
      if (notices) out._silo_notices = notices;
      return successResult(out);
    } catch (err) {
      if (err.code === 'ENOENT') {
        const out = { files: [] };
        const notices = await siloNoticesForRead();
        if (notices) out._silo_notices = notices;
        return successResult(out);
      }
      return errorResult('FS_ERROR', `Failed to list handoffs: ${err.message}`);
    }
  }
);

// ── Tool 6: write_event ────────────────────────────────────────────────────

server.tool(
  'write_event',
  'Append a memory event through Silo\'s operation log. WRITE — requires explicit user intent. Confirm with the user before recording decisions, user facts, or project updates. Server validates format, checks for duplicates, and enforces slug validity. NEVER edit projection files directly; always go through this tool.',
  {
    tag: z.enum(VALID_TAGS).describe('Event tag'),
    slug: z.string().describe('Topic slug — must exist in TOPIC-INDEX.md or be "general"'),
    content: z.string().min(1).max(500).describe('Event content (single line, max 500 chars)'),
    confidence: z.enum(VALID_CONFIDENCES).optional().describe('Confidence level (omit for standard entries)'),
  },
  WRITE_SIDE_EFFECT,
  async ({ tag, slug, content, confidence }) => {
    const warnings = [];

    // Validation 1: tag — handled by zod enum
    // Validation 2: slug
    try {
      const idx = await loadTopicIndex();
      if (slug !== 'general' && !idx.slugs.has(slug)) {
        return errorResult('SLUG_NOT_FOUND',
          `Slug "${slug}" not found in TOPIC-INDEX.md`,
          `Valid slugs: general, ${[...idx.slugs].join(', ')}`);
      }
    } catch (err) {
      return errorResult(err.code || 'FS_ERROR', err.message);
    }

    // Validation 3 & 4: content length — handled by zod

    // Validation 5: no newlines
    if (content.includes('\n') || content.includes('\r')) {
      return errorResult('CONTENT_MULTILINE', 'Events must be single-line entries.');
    }

    // Validation 6: confidence — handled by zod enum

    // Read existing entries for duplicate check
    const today = todayStr();
    const eventFile = join(EVENTS_DIR, `${today}.md`);
    let existingText = '';
    try {
      existingText = await readFile(eventFile, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return errorResult('FS_ERROR', `Failed to read event file: ${err.message}`);
      }
    }

    // Validation 7 & 8: Jaccard duplicate check against same-slug entries
    const existingLines = existingText.split('\n').filter(l => l.trim());
    for (const line of existingLines) {
      const parsed = parseEventLine(line.trim());
      if (!parsed || parsed.slug !== slug) continue;
      const sim = jaccard(content, parsed.content);
      if (sim >= 0.8) {
        return errorResult('DUPLICATE_ENTRY',
          'Near-duplicate detected.',
          `Existing entry: ${parsed.raw_line}`);
      }
      if (sim >= 0.6) {
        warnings.push(`Possible duplicate (similarity ${(sim * 100).toFixed(0)}%) — verify this is intentionally distinct. Existing: "${parsed.content}"`);
      }
    }

    // Format the line
    const confPart = confidence ? `:${confidence}` : '';
    const formattedLine = `[${tag}${confPart}] ${slug}: [desktop-claude] ${content}`;

    // SILO_CUTOVER_ROUTED — write_event routes through Silo's operation log
    // (v12.5 cutover 2026-04-22). The log is the authority; regen rewrites files.
    // Paths use the SILO_DIR / SILO_BASE / SILO_CLI constants defined at the
    // top of the file so local dev + production share one code path.
    try {
      const bodyWithPrefix = `[desktop-claude] ${content}`;
      const writeCmd = spawnSync('node', [
        SILO_CLI,
        'write',
        `--silo-dir=${SILO_DIR}`,
        '--slug=' + slug,
        '--tag=' + tag,
        '--content=' + bodyWithPrefix,
        `--principal=${MCP_PRINCIPAL}`,
        ...(confidence ? ['--confidence=' + confidence] : []),
      ], { encoding: 'utf-8' });
      if (writeCmd.status !== 0) {
        const admissionCode = extractAdmissionCode(writeCmd.stderr);
        if (admissionCode) {
          return errorResult(admissionCode,
            'admission gate refused write: ' + (writeCmd.stderr || 'unknown'));
        }
        return errorResult('SILO_WRITE_FAILED',
          'silo CLI rejected write: ' + (writeCmd.stderr || writeCmd.stdout || 'unknown'));
      }
      const regenCmd = spawnSync('node', [
        SILO_CLI,
        'regenerate',
        `--silo-dir=${SILO_DIR}`,
        `--to=${SILO_BASE}`,
      ], { encoding: 'utf-8' });
      if (regenCmd.status !== 0) {
        return errorResult('SILO_REGEN_FAILED',
          'regen after write failed: ' + (regenCmd.stderr || regenCmd.stdout || 'unknown'));
      }
      // Restore ownership for the OpenClaw container (uid 1000) via argv-form
      // spawnSync — no shell, no injection surface. Non-fatal on failure.
      spawnSync('chown', ['-R', '1000:1000', join(SILO_BASE, 'events')], { encoding: 'utf-8' });
    } catch (err) {
      return errorResult('FS_ERROR', `Failed to route event through Silo: ${err.message}`);
    }

    const result = { success: true, line: formattedLine };
    if (warnings.length) result.warnings = warnings;
    return successResult(result);
  }
);

// ── Tool 7: write_handoff ──────────────────────────────────────────────────

const HANDOFF_FILENAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/;

server.tool(
  'write_handoff',
  'Write a handoff report for the curator to process. WRITE — requires user intent. Use for complex architectural changes, multi-topic updates, or anything needing human review before entering topic files. For simple facts/events, use write_event instead.',
  {
    filename: z.string().describe('Filename (must match YYYY-MM-DD-slug-name.md)'),
    content: z.string().min(1).max(50000).describe('Handoff content (max 50000 chars)'),
  },
  WRITE_SIDE_EFFECT,
  async ({ filename, content }) => {
    // Validation 1: filename format
    if (!HANDOFF_FILENAME_RE.test(filename)) {
      return errorResult('INVALID_FILENAME',
        `Filename "${filename}" doesn't match expected format.`,
        'Expected: YYYY-MM-DD-slug-name.md (e.g., 2026-04-13-hs-crm-refactor.md)');
    }

    // Validation 2: content non-empty — handled by zod
    // Validation 3: content length — handled by zod

    // Validation 4: source tag
    if (!content.includes('[desktop-claude]')) {
      return errorResult('MISSING_SOURCE_TAG',
        'Handoffs must contain source tag [desktop-claude].');
    }

    // Validation 5: file doesn't already exist
    const targetPath = join(HANDOFF_DIR, filename);
    try {
      await access(targetPath);
      return errorResult('FILE_EXISTS',
        'File already exists. Choose a different filename.');
    } catch {
      // Good — file doesn't exist
    }

    // Write
    try {
      await writeFile(targetPath, content, 'utf-8');
      spawnSync('chown', ['1000:1000', targetPath], { encoding: 'utf-8' });
      const st = await stat(targetPath);
      return successResult({ success: true, path: targetPath, size_bytes: st.size });
    } catch (err) {
      return errorResult('FS_ERROR', `Failed to write handoff: ${err.message}`);
    }
  }
);

// ── Tool 8: list_pending_suggestions (Phase 2.2 §7.1) ──────────────────────

server.tool(
  'list_pending_suggestions',
  'List topic suggestions awaiting accept/dismiss. Returns the envelope with count, cap_reached, and detector_status. Surface to the user when convenient — they can accept_suggestion or dismiss_suggestion. Read-only.',
  {},
  READ_ONLY,
  async () => {
    const envelope = await loadPendingSuggestions(PENDING_SUGGESTIONS_PATH);
    if (!envelope) {
      return successResult({
        schema_version: 1,
        suggestions: [],
        count: 0,
        cap: 10,
        cap_reached: false,
        detector_status: null,
      });
    }
    return successResult(envelope);
  }
);

// ── Tool 9: accept_suggestion (Phase 2.2 §7.2) ─────────────────────────────

server.tool(
  'accept_suggestion',
  'Accept a pending topic suggestion. WRITE — only use after the user clearly approves. Server emits TOPIC_METADATA_SET + TOPIC_SUGGESTION_ACCEPTED as an atomic batch under the operation-log lock, then regenerates projections. Optional overrides let the user refine the slug, summary, type, or tags before the topic file is created.',
  {
    suggestion_seq: z.number().int().positive().describe('Seq of the TOPIC_SUGGESTED event being accepted'),
    slug: z.string().optional().describe('Override the suggested slug'),
    description: z.string().optional().describe('Override the topic summary'),
    type: z.enum(['reference', 'project', 'feedback', 'personal', 'archive', 'business', 'hobby']).optional(),
    tags: z.array(z.string()).optional(),
  },
  WRITE_SIDE_EFFECT,
  async ({ suggestion_seq, slug, description, type, tags }) => {
    const args = [
      SILO_CLI, 'suggest',
      '--accept', String(suggestion_seq),
      `--silo-dir=${SILO_DIR}`,
      `--principal=${MCP_PRINCIPAL}`,
    ];
    if (slug) args.push(`--slug=${slug}`);
    if (description) args.push(`--description=${description}`);
    if (type) args.push(`--type=${type}`);
    if (tags?.length) args.push(`--tags=${tags.join(',')}`);
    const r = spawnSync('node', args, { encoding: 'utf-8' });
    if (r.status !== 0) {
      return cliSpawnError(r, /silo suggest --accept: ([A-Z0-9_]+) —/, 'ACCEPT_FAILED', 'accept failed');
    }
    const accepted = JSON.parse(r.stdout);
    const regenerated = regenerateAfterWrite();
    let topic_visible_in_index = false;
    if (regenerated) {
      try {
        const idx = await loadTopicIndex();
        topic_visible_in_index = idx.slugs.has(accepted.slug);
      } catch { /* index unreadable — leave false */ }
    }
    return successResult({
      accepted: true,
      accepted_seq: accepted.accepted_seq,
      metadata_seq: accepted.metadata_seq,
      slug: accepted.slug,
      regenerated,
      topic_visible_in_index,
    });
  }
);

// ── Tool 10: dismiss_suggestion (Phase 2.2 §7.3) ───────────────────────────

server.tool(
  'dismiss_suggestion',
  'Reject pending topic suggestions. WRITE — only use after the user clearly approves dismissal. All-or-nothing: any invalid seq aborts the whole call with a structured error. Default cooldown 90 days; the same slug (normalized) cannot re-propose until the cooldown expires.',
  {
    suggestion_seqs: z.array(z.number().int().positive()).min(1).max(50),
    cooldown_days: z.number().int().min(1).max(365).optional().describe('Default 90'),
    reason: z.string().max(120).optional(),
  },
  WRITE_SIDE_EFFECT,
  async ({ suggestion_seqs, cooldown_days, reason }) => {
    const args = [
      SILO_CLI, 'suggest',
      '--dismiss', suggestion_seqs.join(','),
      `--silo-dir=${SILO_DIR}`,
      `--principal=${MCP_PRINCIPAL}`,
    ];
    if (cooldown_days != null) args.push(`--cooldown-days=${cooldown_days}`);
    if (reason) args.push(`--reason=${reason}`);
    const r = spawnSync('node', args, { encoding: 'utf-8' });
    if (r.status !== 0) {
      return cliSpawnError(r, /silo suggest --dismiss: ([A-Z0-9_]+) —/, 'DISMISS_FAILED', 'dismiss failed');
    }
    const dismissed = JSON.parse(r.stdout);
    regenerateAfterWrite();
    return successResult(dismissed);
  }
);

// ── Tool 11: retire_bullet (proposals/retire-primitive.md §4.3, v0.2.2) ─────

server.tool(
  'retire_bullet',
  'Retire one or more active curated (Layer-2) bullets by seq, on a single topic. WRITE — only use after the user clearly intends to remove those specific facts. Retires the ENTIRE write_event payload at each seq: for import-origin writes that is a whole "## Heading" section, not a single line. Emits one TOPIC_BULLETS_RETIRED event under the operation-log lock after re-validating that every seq is a currently-active CURATED bullet on the named topic, then regenerates projections. All-or-nothing: any invalid seq aborts the whole call. There is no un-retire; to restore, re-curate the bullet (write a new CURATED bullet).',
  {
    slug: z.string().describe('Topic slug owning the bullet(s)'),
    seqs: z.array(z.number().int().positive()).min(1).max(256)
      .describe('Seq(s) of active CURATED write_events to retire (one topic, all-or-nothing). Retires the WHOLE payload at each seq.'),
    reason: z.string()
      .min(1)
      .max(120)
      .refine((s) => !/[\r\n]/.test(s), { message: 'reason must be a single line' })
      .optional()
      .describe('Why it is being retired (non-blank, single line, <=120 chars)'),
  },
  WRITE_DESTRUCTIVE,
  async ({ slug, seqs, reason }) => {
    const args = [
      SILO_CLI, 'retire',
      `--slug=${slug}`,
      ...seqs.map((s) => `--seq=${String(s)}`), // repeatable; CLI also accepts comma form
      `--silo-dir=${SILO_DIR}`,
      `--principal=${MCP_PRINCIPAL}`,
    ];
    if (reason) args.push(`--reason=${reason}`);
    const r = spawnSync('node', args, { encoding: 'utf-8' });
    if (r.status !== 0) {
      return cliSpawnError(r, /silo retire: ([A-Z0-9_]+) —/, 'RETIRE_FAILED', 'retire failed');
    }
    const out = JSON.parse(r.stdout);
    const regenerated = regenerateAfterWrite();
    return successResult({ ...out, regenerated });
  }
);

} // end registerTools

// ── HTTP Transport + Auth ──────────────────────────────────────────────────

const SILO_MCP_TOKEN = process.env.SILO_MCP_TOKEN;
if (!SILO_MCP_TOKEN) {
  console.error('FATAL: SILO_MCP_TOKEN environment variable is required');
  process.exit(1);
}

const app = express();
app.use(express.json());

// Bearer token auth middleware — accept token from EITHER header OR ?token= URL.
// MUST be OR-semantic (not else-if): some clients (OpenClaw bundle-mcp) send a
// malformed Authorization header alongside a working URL token; we need either
// path to authenticate independently.
app.use('/mcp', (req, res, next) => {
  const auth = req.headers.authorization;
  const tokenFromHeader = (auth && auth.startsWith('Bearer ')) ? auth.slice(7) : null;
  const tokenFromQuery = (typeof req.query.token === 'string' && req.query.token.length > 0) ? req.query.token : null;
  if (tokenFromHeader === SILO_MCP_TOKEN || tokenFromQuery === SILO_MCP_TOKEN) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
});

// Ensure Accept header includes text/event-stream for StreamableHTTP compatibility
app.use("/mcp", (req, res, next) => {
  if (!req.headers.accept || !req.headers.accept.includes("text/event-stream")) {
    req.headers.accept = "application/json, text/event-stream";
  }
  next();
});

// Stateless mode: each request creates its own transport.
// No session map, no TTL eviction, no client-state mismatch.

app.post('/mcp', async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const serverInstance = new McpServer({ name: 'silo', version: '1.0.0' });
    registerTools(serverInstance);
    await serverInstance.connect(transport);
    res.on('close', () => {
      try { transport.close(); } catch {}
      try { serverInstance.close(); } catch {}
    });
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Stateless: GET (SSE long-poll) and DELETE (session terminate) are not supported.
app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Method Not Allowed (stateless server)' });
});
app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Method Not Allowed (stateless server)' });
});

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'silo-mcp', version: '1.0.0' });
});

const PORT = 18795;
const HOST = '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Silo MCP server listening on ${HOST}:${PORT}`);
});

process.on('SIGTERM', () => process.exit(0));
