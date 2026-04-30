/**
 * Jarvis memory import tool — v12.5 M1.
 *
 * Reads existing Jarvis memory (topic files under `topics/*.md`) and emits
 * v12.5-spec write_events into a fresh silo. Intended as a one-time migration
 * from Jarvis v3.x to v12.5.
 *
 * Mapping:
 *   topic file YAML frontmatter → write_event with tag=FACT, content=summary
 *   Layer 2 (CURATED) sections → one write_event per section (tag=CURATED)
 *   Layer 3 (SOURCE) blocks    → one write_event per block (tag=SOURCE)
 *   topic.sensitivity=private  → emits ACL_SEALED restricting to operator
 *
 * M1 scope: topic files only. Event-log parsing deferred to M2.
 */

import { promises as fs } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import yaml from 'js-yaml';
import { importEventLogDirectory } from './events.js';

const CURATED_START = '<!-- CURATED_START -->';
const CURATED_END = '<!-- CURATED_END -->';
const SOURCE_START = '<!-- SOURCE_START -->';
const SOURCE_END = '<!-- SOURCE_END -->';

/**
 * Normalize a value (Date, string, or undefined) to an ISO 8601 timestamp.
 * js-yaml parses YAML date fields as Date objects by default.
 */
/**
 * Extract the raw summary block from YAML frontmatter text, preserving line
 * breaks exactly as the author wrote them. Returns null if no summary field.
 *
 * Handles both folded (`summary: >`) and literal (`summary: |`) forms.
 * The returned value is de-indented (removes the 2-space body indent) and
 * trimmed of leading/trailing blank lines.
 */
function extractRawSummary(frontmatterText) {
  const match = frontmatterText.match(/^summary:\s*([>|][-+]?)?\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!match) {
    // Summary is inline (not a block scalar) — delegate to yaml.load
    return null;
  }
  const indentedBody = match[2];
  // Find the indent (first non-empty line's leading whitespace)
  const firstContentLine = indentedBody.split('\n').find((l) => l.trim());
  if (!firstContentLine) return '';
  const indentMatch = firstContentLine.match(/^[ \t]+/);
  const indent = indentMatch ? indentMatch[0] : '';
  const lines = indentedBody.split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l));
  return lines.join('\n').replace(/^\n+|\n+$/g, '');
}

/**
 * Detect whether the source file's summary block has a blank line before the
 * closing `---` marker (yaml `>` clip mode vs `>-` strip mode).
 */
function detectSummaryTrailingBlank(rawFileText) {
  // Look for the pattern: `summary: >[...]\n[indented lines]\n\n---` vs
  // `summary: >[...]\n[indented lines]\n---`
  const match = rawFileText.match(/^summary:\s*[>|][-+]?\s*\n(?:[ \t]+.*\n)+(\n?)---\n/m);
  if (!match) return true; // default true (most common)
  // match[1] is "" (no blank) or "\n" (blank present)
  return match[1] === '\n';
}

function toIsoTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    // If it's a YYYY-MM-DD date, promote to midnight UTC
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
    // Otherwise assume it's already a full ISO string
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Parse a Jarvis topic file.
 * @returns {Object} { frontmatter, curated, source, slug }
 */
export function parseTopicFile(text, filename) {
  // YAML frontmatter: starts with ---, ends with --- on its own line
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    throw new Error(`${filename}: no YAML frontmatter`);
  }
  // Use JSON_SCHEMA to avoid js-yaml auto-parsing date values into Date objects
  // (keeps YYYY-MM-DD strings as strings, which we then normalize via toIsoTimestamp).
  const frontmatter = yaml.load(fmMatch[1], { schema: yaml.JSON_SCHEMA }) ?? {};

  // Preserve the raw summary block with its original line breaks. yaml-load
  // collapses folded-scalar newlines which would force us to guess wrap points
  // on regeneration; reading raw keeps fidelity with Helder's hand-authored
  // wrapping.
  const rawSummary = extractRawSummary(fmMatch[1]);
  if (rawSummary !== null) {
    frontmatter.summary = rawSummary;
  }

  // Detect whether the source file has a blank line between the folded summary
  // and the closing `---` (yaml folded-scalar chomping mode: `>` keeps, `>-`
  // strips). This is a tiny cosmetic hint preserved so regeneration matches
  // the author's chosen style byte-for-byte.
  frontmatter._summary_trailing_blank = detectSummaryTrailingBlank(text);

  const body = text.slice(fmMatch[0].length);

  // Extract layers
  const curated = extractBetween(body, CURATED_START, CURATED_END);
  const source = extractBetween(body, SOURCE_START, SOURCE_END);

  // Slug: prefer frontmatter, fall back to filename
  const slugFromName = basename(filename, extname(filename)).replace(/\.archive$/, '');
  const slug = frontmatter.topic || slugFromName;

  return { frontmatter, curated, source, slug };
}

function extractBetween(text, start, end) {
  const startIdx = text.indexOf(start);
  if (startIdx < 0) return '';
  const after = startIdx + start.length;
  const endIdx = text.indexOf(end, after);
  if (endIdx < 0) return text.slice(after).trim();
  return text.slice(after, endIdx).trim();
}

/**
 * Parse Layer 3 source blocks. Each block starts with `### YYYY-MM-DD — Title`.
 * Returns array of { date, title, content }.
 */
export function parseSourceBlocks(sourceText) {
  if (!sourceText) return [];
  const blocks = [];
  const blockRegex = /^### (\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+?)$/gm;
  const matches = [...sourceText.matchAll(blockRegex)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : sourceText.length;
    blocks.push({
      date: m[1],
      title: m[2].trim(),
      content: sourceText.slice(start, end).trim(),
    });
  }
  return blocks;
}

/**
 * Parse Layer 2 sections. Each section starts with `## Header`.
 * Returns array of { heading, content }.
 */
export function parseCuratedSections(curatedText) {
  if (!curatedText) return [];
  const headerRegex = /^## (.+?)$/gm;
  const matches = [...curatedText.matchAll(headerRegex)];
  if (matches.length === 0) {
    // No explicit sections — pass through as a headless block. The regenerator
    // will NOT wrap this in a synthetic `## Curated` heading (matches Jarvis's
    // files which often have bulleted content directly under CURATED_START).
    const content = curatedText.trim();
    return content ? [{ heading: null, content }] : [];
  }
  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : curatedText.length;
    sections.push({
      heading: m[1].trim(),
      content: curatedText.slice(start, end).trim(),
    });
  }
  return sections;
}

/**
 * Import a single topic file into the silo.
 */
export async function importTopicFile({ path, text, writer, principal, filename }) {
  const { frontmatter, curated, source, slug } = parseTopicFile(text, filename);
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const entities = Array.isArray(frontmatter.entities) ? frontmatter.entities : [];
  const ts = toIsoTimestamp(frontmatter.created) || new Date().toISOString();

  const eventsEmitted = [];
  const summary = typeof frontmatter.summary === 'string' ? frontmatter.summary.trim() : slug;

  // 0) Set topic-level metadata FIRST (decouples "topic exists with these attrs"
  //    from "content was written to it"). Latest-wins per TOPIC_METADATA_SET.
  const metadataResult = await writer.append({
    type: 'TOPIC_METADATA_SET',
    isStateBearing: true,
    intentId: `intent:${uuidv7()}`,
    principal,
    payload: {
      topic: slug,
      type: frontmatter.type,
      tags,
      entities,
      status: frontmatter.status || 'active',
      sensitivity: frontmatter.sensitivity,
      created: toIsoTimestamp(frontmatter.created)?.split('T')[0],
      summary,
      summary_trailing_blank: frontmatter._summary_trailing_blank,
    },
    ts,
  });
  eventsEmitted.push(metadataResult.seq);

  // 0a) last_verified and last_curated as first-class events
  if (frontmatter.last_verified) {
    const verifiedTs = toIsoTimestamp(frontmatter.last_verified);
    if (verifiedTs) {
      const r = await writer.append({
        type: 'TOPIC_VERIFIED',
        isStateBearing: true,
        intentId: `intent:${uuidv7()}`,
        principal,
        payload: { topic: slug, imported: { source_file: path } },
        ts: verifiedTs,
      });
      eventsEmitted.push(r.seq);
    }
  }
  if (frontmatter.last_curated) {
    const curatedTs = toIsoTimestamp(frontmatter.last_curated);
    if (curatedTs) {
      const r = await writer.append({
        type: 'TOPIC_CURATED',
        isStateBearing: true,
        intentId: `intent:${uuidv7()}`,
        principal,
        payload: { topic: slug, imported: { source_file: path } },
        ts: curatedTs,
      });
      eventsEmitted.push(r.seq);
    }
  }

  // 1) Summary as the primary topic write_event (kept for FACT-tagged search index)
  const summaryResult = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: `intent:${uuidv7()}`,
    principal,
    payload: {
      slug,
      tag: 'FACT',
      content: summary,
      imported: { source_file: path, field: 'summary' },
    },
    ts,
  });
  eventsEmitted.push(summaryResult.seq);

  // 2) Layer 2 sections as CURATED events.
  //    If the section has a heading, prefix the content with `## heading\n\n`.
  //    If heading is null (headless block), emit the raw content verbatim.
  const sections = parseCuratedSections(curated);
  for (const section of sections) {
    if (!section.content) continue;
    const content = section.heading
      ? `## ${section.heading}\n\n${section.content}`
      : section.content;
    const result = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal,
      payload: {
        slug,
        tag: 'CURATED',
        content,
        imported: { source_file: path, field: 'curated', heading: section.heading ?? null },
      },
      ts,
    });
    eventsEmitted.push(result.seq);
  }

  // 3) Layer 3 blocks as SOURCE events
  const blocks = parseSourceBlocks(source);
  for (const block of blocks) {
    const result = await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal,
      payload: {
        slug,
        tag: 'SOURCE',
        content: `### ${block.date} — ${block.title}\n${block.content}`,
        imported: { source_file: path, field: 'source', block_date: block.date },
      },
      ts: toIsoTimestamp(block.date) || new Date().toISOString(),
    });
    eventsEmitted.push(result.seq);
  }

  // 4) Apply sensitivity → ACL_SEALED if private (admin-only per v12.5 matrix;
  //    import runs as trusted system action so emit via operator principal)
  if (frontmatter.sensitivity === 'private') {
    const sealResult = await writer.append({
      type: 'ACL_SEALED',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal: 'operator',
      payload: {
        topic: slug,
        readers: [principal, 'operator'],
        reason: 'imported: sensitivity=private',
      },
      ts,
    });
    eventsEmitted.push(sealResult.seq);
  }

  return { slug, events: eventsEmitted, curated_sections: sections.length, source_blocks: blocks.length };
}

/**
 * Import a directory of Jarvis topic files. Auto-detects layout:
 *
 *   - If fromDir contains a `topics/` subdir, imports from `topics/` and also
 *     imports event logs from `events/` when present (real Jarvis layout).
 *   - Otherwise treats fromDir itself as a topics dir (legacy / tests).
 *
 * @param {Object} args
 * @param {string} args.fromDir - Jarvis clawd-v3 root OR a topics/ dir
 * @param {LogWriter} args.writer - initialized silo log writer
 * @param {string} args.principal - principal to credit for the imported writes
 * @param {RegExp} [args.filePattern] - which topic files to include
 * @returns {Promise<{topicsImported: number, eventsEmitted: number, details: Array, events?: Object}>}
 */
export async function importDirectory({ fromDir, writer, principal, filePattern = /\.md$/ }) {
  const { topicsDir, eventsDir } = await resolveJarvisLayout(fromDir);

  const details = await importTopicsFromDir({ topicsDir, writer, principal, filePattern });
  let eventsEmitted = details.reduce((n, d) => n + (d.events?.length ?? 0), 0);
  const topicsImported = details.filter((d) => !d.error).length;

  const result = { topicsImported, eventsEmitted, details };

  if (eventsDir) {
    const eventsResult = await importEventLogDirectory({
      fromDir: eventsDir,
      writer,
      defaultPrincipal: principal,
    });
    result.events = eventsResult;
    result.eventsEmitted += eventsResult.totalEvents;
  }

  return result;
}

async function resolveJarvisLayout(fromDir) {
  const topicsCandidate = join(fromDir, 'topics');
  const eventsCandidate = join(fromDir, 'events');
  const topicsIsDir = await isDirectory(topicsCandidate);
  if (topicsIsDir) {
    const eventsIsDir = await isDirectory(eventsCandidate);
    return { topicsDir: topicsCandidate, eventsDir: eventsIsDir ? eventsCandidate : null };
  }
  return { topicsDir: fromDir, eventsDir: null };
}

async function isDirectory(path) {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function importTopicsFromDir({ topicsDir, writer, principal, filePattern }) {
  const entries = await fs.readdir(topicsDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && filePattern.test(e.name) && !e.name.includes('archive'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const details = [];
  for (const file of files) {
    const path = join(topicsDir, file.name);
    const text = await fs.readFile(path, 'utf8');
    try {
      const result = await importTopicFile({
        path,
        text,
        writer,
        principal,
        filename: file.name,
      });
      details.push(result);
    } catch (err) {
      details.push({ slug: file.name, error: err.message });
    }
  }
  return details;
}
