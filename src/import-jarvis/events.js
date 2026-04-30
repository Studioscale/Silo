/**
 * Jarvis event log import — parses daily event-log files (`YYYY-MM-DD.md`)
 * and emits v12.5 write_events.
 *
 * Jarvis event log format (observed in real corpus):
 *   [TAG] slug: content
 *   [TAG:CONFIDENCE] slug: content
 *   [AUTO-TAG:CONFIDENCE] slug: content
 *
 * Tags: EVENT, FACT, DECISION, CHANGED, TODO, PROCEDURE, CURATION, SECURITY
 * Confidence: CONFIRMED, TENTATIVE, CONTEXT
 * AUTO- prefix: auto-extracted by session-extract.js
 *
 * Content may include a `[principal]` prefix which we extract to entry.principal.
 *
 * Comments like `<!-- auto-extracted: ISO_TIMESTAMP -->` are preserved in
 * payload for traceability but don't become events themselves.
 */

import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

const TAG_LINE_RE = /^\[(?<auto>AUTO-)?(?<tag>[A-Z]+)(?::(?<conf>[A-Z]+))?\]\s+(?<slug>[a-z0-9][a-z0-9_-]*)\s*:\s*(?<rest>.*)$/;
const COMMENT_LINE_RE = /^<!--\s*(.*?)\s*-->$/;
const HEADER_LINE_RE = /^#+\s+.+$/; // markdown heading (e.g. `# Event Log — 2026-04-04`)
const PRINCIPAL_PREFIX_RE = /^\[(?<principal>[a-zA-Z0-9._-]+)\]\s*(?<content>.*)$/;

/**
 * Parse one line of a Jarvis event log. Returns null for comments/blank lines.
 */
export function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const commentMatch = COMMENT_LINE_RE.exec(trimmed);
  if (commentMatch) {
    return { kind: 'comment', comment: commentMatch[1] };
  }

  if (HEADER_LINE_RE.test(trimmed)) {
    return { kind: 'header', raw: trimmed };
  }

  const m = TAG_LINE_RE.exec(trimmed);
  if (!m) return { kind: 'unrecognized', raw: trimmed };

  const { auto, tag, conf, slug, rest } = m.groups;

  // Extract principal prefix if present
  let principal = null;
  let content = rest;
  const pm = PRINCIPAL_PREFIX_RE.exec(rest);
  if (pm) {
    principal = pm.groups.principal;
    content = pm.groups.content;
  }

  return {
    kind: 'event',
    tag, // base tag (FACT / DECISION / ...)
    auto_extracted: Boolean(auto),
    confidence: conf || null, // CONFIRMED / TENTATIVE / CONTEXT, or null
    slug,
    principal,
    content: content.trim(),
  };
}

/**
 * Derive an ISO timestamp for a line based on the file's date and the line
 * index within the day. Creates monotonic ordering within the day.
 */
function tsForLine(date, lineIndex) {
  // Use seconds offset 0..59 then rollover (we don't expect > 3600 entries/day)
  const minute = Math.min(Math.floor(lineIndex / 60), 23);
  const second = lineIndex % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date}T12:${pad(minute)}:${pad(second)}Z`;
}

/**
 * Import a single event-log file. Returns count of events emitted.
 */
export async function importEventLogFile({ path, writer, defaultPrincipal = 'helder' }) {
  const filename = basename(path);
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!dateMatch) {
    return { skipped: true, reason: 'filename not YYYY-MM-DD.md' };
  }
  const date = dateMatch[1];

  const text = await fs.readFile(path, 'utf8');
  const lines = text.split('\n');
  let eventCount = 0;
  let unrecognizedCount = 0;
  let contextComment = null; // most recent <!-- auto-extracted: ... --> comment
  let dateHeader = null; // `# Event Log — 2026-04-04` if present on first non-blank line
  let blankRun = 0; // number of blank lines since the last event/comment

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // Track blank-line runs directly (parseEventLine returns null for blanks)
    if (rawLine.trim() === '') {
      blankRun += 1;
      continue;
    }

    const parsed = parseEventLine(rawLine);
    if (!parsed) continue;

    if (parsed.kind === 'header') {
      // Capture the FIRST header as the date-header hint; ignore any later ones.
      if (dateHeader === null) dateHeader = parsed.raw;
      blankRun = 0;
      continue;
    }
    if (parsed.kind === 'comment') {
      // Don't reset blankRun — the blanks preceded the comment, and when
      // regenerated the comment sits inside the block that follows. Attaching
      // those blanks to the NEXT event's prefix_blanks lets the regenerator
      // reconstruct the original "blank → comment → events" layout.
      contextComment = parsed.comment;
      continue;
    }
    if (parsed.kind === 'unrecognized') {
      unrecognizedCount += 1;
      blankRun = 0;
      continue;
    }

    // parsed.kind === 'event'
    const ts = tsForLine(date, eventCount);
    const principal = parsed.principal || defaultPrincipal;

    const payload = {
      slug: parsed.slug,
      tag: parsed.tag,
      content: parsed.content,
      imported: {
        source_file: path,
        source_line: i + 1,
        date,
        auto_extracted: parsed.auto_extracted,
        context_comment: contextComment,
        // Round-trip hint: whether the original line carried `[principal]` as a
        // content prefix (so regenerate-event-log can restore it byte-perfect).
        principal_was_prefixed: parsed.principal != null,
        // Verbatim original line — authoritative source for regeneration.
        raw_line: rawLine.trimEnd(),
        // Layout hints for byte-parity regeneration
        prefix_blanks: blankRun,
        first_of_date: eventCount === 0,
        date_header: eventCount === 0 ? dateHeader : null,
      },
    };
    if (parsed.confidence) payload.confidence = parsed.confidence;
    blankRun = 0;

    await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal,
      payload,
      ts,
    });
    eventCount += 1;
  }

  return { date, eventCount, unrecognizedCount, filename };
}

/**
 * Import all event-log files in a directory.
 */
export async function importEventLogDirectory({ fromDir, writer, defaultPrincipal = 'helder' }) {
  const entries = await fs.readdir(fromDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const results = [];
  let totalEvents = 0;
  for (const file of files) {
    const result = await importEventLogFile({
      path: join(fromDir, file.name),
      writer,
      defaultPrincipal,
    });
    results.push(result);
    totalEvents += result.eventCount || 0;
  }
  return { filesProcessed: results.length, totalEvents, results };
}
