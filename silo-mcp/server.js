import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { readFile, writeFile, stat, readdir, access } from 'fs/promises';
import { execSync } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

// ── Constants ──────────────────────────────────────────────────────────────

const SILO_BASE = '/root/clawd-v3';
const TOPIC_INDEX_PATH = join(SILO_BASE, 'TOPIC-INDEX.md');
const TOPICS_DIR = join(SILO_BASE, 'topics');
const EVENTS_DIR = join(SILO_BASE, 'events');
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

function todayStr() {
  // Use BRT (UTC-3)
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

// ── Tool Registration ─────────────────────────────────────────────────────

function registerTools(server) {

// ── Tool 1: read_index ─────────────────────────────────────────────────────

server.tool(
  'read_index',
  'Returns all topics from TOPIC-INDEX.md with slug, type, tags, status, and summary. Use this FIRST to find which topic to load.',
  {},
  async () => {
    try {
      const idx = await loadTopicIndex();
      return successResult({ topics: idx.topics });
    } catch (err) {
      return errorResult(err.code || 'FS_ERROR', err.message);
    }
  }
);

// ── Tool 2: get_topic ──────────────────────────────────────────────────────

server.tool(
  'get_topic',
  'Returns the YAML header and curated facts (Layer 2) of a topic file. Does NOT return Layer 3 source material — use search for that.',
  { slug: z.string().describe('Topic slug — must exist in TOPIC-INDEX.md') },
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
  'Returns event log entries. Defaults to today. Use days_back to include previous days. Use exclude_source to filter (e.g., exclude your own entries to see only what Jarvis logged).',
  {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Most recent date (YYYY-MM-DD, default: today)'),
    days_back: z.number().int().min(1).max(30).optional().describe('How many days of history (default: 1)'),
    exclude_source: z.string().optional().describe('Filter out entries from this source tag'),
    slug_filter: z.string().optional().describe('Only return entries matching this topic slug'),
  },
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
  'Full-text keyword search across all Silo content. Returns matching lines with context. Use for finding information when you don\'t know which topic file to load.',
  {
    query: z.string().min(1).max(200).describe('Search query'),
    limit: z.number().int().min(1).max(20).optional().describe('Max results (default: 5)'),
  },
  async ({ query, limit }) => {
    const maxResults = limit || 5;
    try {
      const escaped = query.replace(/"/g, '\\"');
      const cmd = `docker exec clawdbot-v3-openclaw-gateway-1 node /home/node/clawd/bin/memory_search_fts "${escaped}" --limit ${maxResults}`;
      const stdout = execSync(cmd, { timeout: 10000, encoding: 'utf-8' });
      // Parse BM25 output — format varies, return raw results
      const lines = stdout.trim().split('\n').filter(Boolean);
      const results = lines.map(line => {
        // Try to parse "score: N.NN | text" format
        const scoreMatch = line.match(/^score:\s*([\d.]+)\s*\|\s*(.+)$/);
        if (scoreMatch) {
          return { score: parseFloat(scoreMatch[1]), text: scoreMatch[2] };
        }
        return { score: 0, text: line };
      });
      return successResult({ results, query, total_matches: results.length });
    } catch (err) {
      if (err.killed) {
        return errorResult('SEARCH_TIMEOUT', 'BM25 search timed out after 10 seconds');
      }
      return errorResult('DOCKER_ERROR', `Docker exec failed: ${err.message}`);
    }
  }
);

// ── Tool 5: list_handoffs ──────────────────────────────────────────────────

server.tool(
  'list_handoffs',
  'List handoff reports. Use to check if there are unprocessed handoffs.',
  {
    status: z.enum(['pending', 'processed']).optional().describe('Filter by status (default: pending)'),
  },
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
      return successResult({ files });
    } catch (err) {
      if (err.code === 'ENOENT') return successResult({ files: [] });
      return errorResult('FS_ERROR', `Failed to list handoffs: ${err.message}`);
    }
  }
);

// ── Tool 6: write_event ────────────────────────────────────────────────────

server.tool(
  'write_event',
  'Write a structured event to today\'s log. Server validates format, checks for duplicates, and enforces slug validity.',
  {
    tag: z.enum(VALID_TAGS).describe('Event tag'),
    slug: z.string().describe('Topic slug — must exist in TOPIC-INDEX.md or be "general"'),
    content: z.string().min(1).max(500).describe('Event content (single line, max 500 chars)'),
    confidence: z.enum(VALID_CONFIDENCES).optional().describe('Confidence level (omit for standard entries)'),
  },
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
    try {
      const { spawnSync } = await import('node:child_process');
      const bodyWithPrefix = `[desktop-claude] ${content}`;
      const writeCmd = spawnSync('node', [
        '/root/silo/src/cli/silo.js',
        'write',
        '--silo-dir=/root/.silo',
        '--slug=' + slug,
        '--tag=' + tag,
        '--content=' + bodyWithPrefix,
        '--principal=desktop-claude',
        ...(confidence ? ['--confidence=' + confidence] : []),
      ], { encoding: 'utf-8' });
      if (writeCmd.status !== 0) {
        return errorResult('SILO_WRITE_FAILED',
          'silo CLI rejected write: ' + (writeCmd.stderr || writeCmd.stdout || 'unknown'));
      }
      const regenCmd = spawnSync('node', [
        '/root/silo/src/cli/silo.js',
        'regenerate',
        '--silo-dir=/root/.silo',
        '--to=/root/clawd-v3',
      ], { encoding: 'utf-8' });
      if (regenCmd.status !== 0) {
        return errorResult('SILO_REGEN_FAILED',
          'regen after write failed: ' + (regenCmd.stderr || regenCmd.stdout || 'unknown'));
      }
      try { execSync(`chown -R 1000:1000 /root/clawd-v3/events/`); } catch { /* non-fatal */ }
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
  'Write a handoff report for the curator to process. Use for complex architectural changes, multi-topic updates, or anything that needs human review before entering topic files. For simple facts/events, use write_event instead.',
  {
    filename: z.string().describe('Filename (must match YYYY-MM-DD-slug-name.md)'),
    content: z.string().min(1).max(50000).describe('Handoff content (max 50000 chars)'),
  },
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
      try { execSync(`chown 1000:1000 "${targetPath}"`); } catch { /* non-fatal */ }
      const st = await stat(targetPath);
      return successResult({ success: true, path: targetPath, size_bytes: st.size });
    } catch (err) {
      return errorResult('FS_ERROR', `Failed to write handoff: ${err.message}`);
    }
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
