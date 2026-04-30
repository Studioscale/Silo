/**
 * Daily event log regenerator — v12.5 Zone B projection.
 *
 * Output path: <jarvis_root>/events/YYYY-MM-DD.md
 *
 * Native Jarvis format (byte-parity target):
 *
 *   <!-- auto-extracted: 2026-04-22T03:00:01.666Z -->
 *   [AUTO-FACT:CONFIRMED] slug: content
 *   [AUTO-DECISION:TENTATIVE] slug: content
 *
 *   <!-- auto-extracted: 2026-04-22T03:07:21.529Z -->
 *   [AUTO-FACT:CONFIRMED] slug: content
 *
 *   [FACT] slug: manual content (no comment block)
 *   [DECISION] slug: another manual line
 *
 * Grouping rule: events sharing an `imported.context_comment` are emitted
 * under that comment in seq order; events with no comment are emitted at the
 * bottom (the "manual" block).
 *
 * For events imported from real Jarvis logs, `imported.raw_line` carries the
 * verbatim original line — the regenerator uses it verbatim for lossless
 * round-trip. For native Silo writes (no imported hint), the line is
 * reconstructed from payload fields.
 */

/**
 * Group events by ISO date (UTC).
 * Returns Map<YYYY-MM-DD, Array<event>>.
 */
function groupByDate(events) {
  const groups = new Map();
  for (const e of events) {
    if (!e.ts) continue;
    const date = e.ts.split('T')[0];
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(e);
  }
  return groups;
}

/**
 * Reconstruct a single event line from payload fields. Used when no
 * `imported.raw_line` hint is available (native Silo writes).
 *
 *   [AUTO-TAG:CONF] slug: [principal] content   <- principal prefixed
 *   [TAG] slug: content                          <- plain
 */
function reconstructEventLine(entry) {
  const p = entry.payload ?? {};
  const auto = p.imported?.auto_extracted ? 'AUTO-' : '';
  const tag = p.tag || 'EVENT';
  const conf = p.confidence ? `:${p.confidence}` : '';
  const slug = p.slug || 'general';
  const content = (p.content ?? '').split('\n')[0];

  const principalPrefix = p.imported?.principal_was_prefixed && entry.principal
    ? `[${entry.principal}] `
    : '';

  return `[${auto}${tag}${conf}] ${slug}: ${principalPrefix}${content}`;
}

/**
 * Preferred line body: use the round-trip hint when present, reconstruct
 * otherwise.
 */
function lineForEvent(entry) {
  const hint = entry.payload?.imported?.raw_line;
  if (typeof hint === 'string' && hint.length > 0) return hint;
  return reconstructEventLine(entry);
}

/**
 * Regenerate the event log file for one date. Preserves the author's original
 * layout when events carry `imported.*` hints (date_header, prefix_blanks,
 * context_comment). For native Silo writes (no hints), falls back to a
 * sensible default: auto-extracted comment blocks, then manual events.
 */
export function regenerateEventLogForDate(date, events) {
  events.sort((a, b) => a.seq - b.seq);

  const parts = [];
  let lastCommentEmitted = null;
  const dateHeader = events[0]?.payload?.imported?.date_header ?? null;

  if (dateHeader) parts.push(dateHeader);

  for (let idx = 0; idx < events.length; idx++) {
    const entry = events[idx];
    const imported = entry.payload?.imported ?? {};
    const comment = imported.context_comment ?? null;
    const prefixBlanks = typeof imported.prefix_blanks === 'number' ? imported.prefix_blanks : null;
    const commentChanges = comment && comment !== lastCommentEmitted;

    // Emit blanks BEFORE the comment (the author's blanks preceded the comment
    // in the source, not the event that follows it).
    if (prefixBlanks !== null) {
      for (let k = 0; k < prefixBlanks; k++) parts.push('');
    } else if (idx === 0 && dateHeader) {
      parts.push('');
    } else if (idx > 0 && commentChanges) {
      parts.push(''); // fallback: blank line between blocks
    }

    if (commentChanges) {
      parts.push(`<!-- ${comment} -->`);
      lastCommentEmitted = comment;
    }

    parts.push(lineForEvent(entry));
  }

  return parts.join('\n') + '\n';
}

/**
 * Regenerate all daily event log files.
 *
 * @param {LogWriter} logReader
 * @returns {Promise<Map<string, string>>} map YYYY-MM-DD -> file content
 */
export async function regenerateAllEventLogs(logReader) {
  const all = [];
  for await (const { entry } of logReader.readAll()) {
    if (entry.type !== 'write_event') continue;
    // Exclude topic-file imports (they belong in the topic file, not event log)
    if (entry.payload?.imported?.field) continue;
    all.push(entry);
  }

  const groups = groupByDate(all);
  const out = new Map();
  for (const [date, events] of groups) {
    out.set(date, regenerateEventLogForDate(date, events));
  }
  return out;
}
