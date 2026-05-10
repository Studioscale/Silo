/**
 * Topic file projection regenerator — v12.5 Zone B (§5.1).
 *
 * Produces Jarvis-compatible three-layer topic files from Silo state:
 *
 *   ---
 *   topic: <slug>
 *   type: <from TOPIC_METADATA_SET>
 *   tags: [from TOPIC_METADATA_SET]     # inline flow style per Jarvis convention
 *   entities: [from TOPIC_METADATA_SET]
 *   status: active | paused | archived | reference
 *   created: YYYY-MM-DD
 *   last_verified: YYYY-MM-DD            # from latest TOPIC_VERIFIED event
 *   last_curated: YYYY-MM-DD             # from latest TOPIC_CURATED event
 *   curated_lines: <auto>
 *   source_lines: <auto>
 *   source_kb: <auto>
 *   summary: >                           # folded scalar per Jarvis convention
 *     ...
 *   [sensitivity: private]               # optional
 *   ---
 *
 *   <!-- CURATED_START -->
 *   <Layer 2 content — CURATED / DECISION events merged in seq order>
 *   <!-- CURATED_END -->
 *
 *   <!-- SOURCE_START -->
 *   <Layer 3 content — SOURCE events sorted newest-first by ts>
 *   <!-- SOURCE_END -->
 *
 * M2.1 scope: semantic fidelity with Jarvis's format. Changelog automation is
 * deferred to M2.2.
 */

const MARKERS = {
  curatedStart: '<!-- CURATED_START -->',
  curatedEnd: '<!-- CURATED_END -->',
  sourceStart: '<!-- SOURCE_START -->',
  sourceEnd: '<!-- SOURCE_END -->',
};

/**
 * Collect events relevant to a topic. Returns write_events and topic-scoped
 * metadata events (TOPIC_VERIFIED, TOPIC_CURATED, TOPIC_METADATA_SET, ACL_SEALED).
 */
async function collectSlugEvents(logReader, slug) {
  const events = [];
  for await (const { entry } of logReader.readAll()) {
    const e = entry;
    if (
      (e.type === 'write_event' && e.payload?.slug === slug) ||
      (e.type === 'TOPIC_VERIFIED' && e.payload?.topic === slug) ||
      (e.type === 'TOPIC_CURATED' && e.payload?.topic === slug) ||
      (e.type === 'TOPIC_BULLETS_RETIRED' && e.payload?.topic === slug) ||
      (e.type === 'TOPIC_METADATA_SET' && e.payload?.topic === slug) ||
      (e.type === 'ACL_SEALED' && e.payload?.topic === slug)
    ) {
      events.push(e);
    }
  }
  return events;
}

function isoDate(ts) {
  if (!ts) return null;
  if (typeof ts !== 'string') return null;
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Derive YAML frontmatter for a topic from events + State.
 * Metadata events are authoritative (latest-wins). Falls back to heuristics
 * from write_events only when no metadata was set (e.g., topics created
 * before TOPIC_METADATA_SET existed).
 */
function buildFrontmatter({ slug, events, state }) {
  const meta = state.topic_index.get(slug) ?? {};

  // Find the latest TOPIC_METADATA_SET event for this slug (metadata can be
  // refined over time). interpret() already applies latest-wins; we just
  // read the merged result from state.
  const topicType = meta.topic_type || 'reference';
  const topicTags = Array.isArray(meta.topic_tags) ? [...meta.topic_tags] : [];
  const topicEntities = Array.isArray(meta.topic_entities) ? [...meta.topic_entities] : [];
  const topicStatus = meta.topic_status || 'active';
  const topicSensitivity = meta.topic_sensitivity;
  const topicCreated = meta.topic_created;
  const topicSummary = meta.topic_summary || slug;

  // Derive dates
  const firstWrite = events.find((e) => e.type === 'write_event');
  const verifiedEvents = events.filter((e) => e.type === 'TOPIC_VERIFIED');
  const curatedEvents = events.filter((e) => e.type === 'TOPIC_CURATED');

  const created = topicCreated || isoDate(firstWrite?.ts) || '2026-04-22';
  const lastVerified =
    isoDate(verifiedEvents[verifiedEvents.length - 1]?.ts) || created;
  const lastCurated =
    isoDate(curatedEvents[curatedEvents.length - 1]?.ts) ||
    isoDate(events[events.length - 1]?.ts) ||
    created;

  // Fields — canonical order matches Jarvis's TEMPLATE.md
  const frontmatter = {
    topic: slug,
    type: topicType,
    tags: topicTags,
    entities: topicEntities,
    status: topicStatus,
  };
  if (topicSensitivity) {
    frontmatter.sensitivity = topicSensitivity;
  }
  frontmatter.created = created;
  frontmatter.last_verified = lastVerified;
  frontmatter.last_curated = lastCurated;
  frontmatter.curated_lines = 0; // recomputed post-build
  frontmatter.source_lines = 0;
  frontmatter.source_kb = 0;
  frontmatter.summary = topicSummary;

  // Honor original chomping style captured during import (preferences.md uses
  // `>-` strip which has no trailing blank before `---`; most files use `>`).
  if (meta.topic_summary_trailing_blank === false) {
    frontmatter._summary_trailing_blank = false;
  }

  return frontmatter;
}

/**
 * Build Layer 2 (CURATED) content from events.
 * Respects original sectioning: if events carry `## Heading` content, keep it.
 * Does NOT wrap bare content in a synthetic "## Curated" heading — that was a
 * regenerator bug caught during parity check with Helder's real corpus.
 */
function buildLayer2(events, retiredSeqs) {
  // Phase 2.1 hardening (Claude Finding 8): retiredSeqs is REQUIRED.
  // The previous default-arg `= new Set()` was a silent-regression hazard —
  // any caller that forgot to pass state.retired_curated_seqs would include
  // retired bullets in Layer 2 without error. Internal API; no external
  // caller exists. Fail loud instead of soft.
  if (!(retiredSeqs instanceof Set)) {
    throw new Error(
      'buildLayer2: retiredSeqs (Set<seq>) is required; pass state.retired_curated_seqs',
    );
  }
  const curatedEvents = events.filter((e) => {
    if (e.type !== 'write_event') return false;
    if (e.payload?.tag !== 'CURATED') return false;
    // Phase 2: skip seqs retired by TOPIC_BULLETS_RETIRED.
    if (retiredSeqs.has(e.seq)) return false;
    // Exclude event-log-origin writes (they carry imported.source_line but no
    // imported.field). Only topic-file imports (imported.field === 'curated')
    // and native writes (no imported hint) belong in Layer 2.
    const imp = e.payload?.imported;
    if (imp && imp.field !== 'curated') return false;
    return true;
  });
  const blocks = curatedEvents.map((e) => (e.payload?.content || '').trim()).filter(Boolean);
  return blocks.join('\n\n');
}

/**
 * Build Layer 3 (SOURCE) content from events. Newest-first by ts (Jarvis convention).
 */
function buildLayer3(events) {
  const sourceEvents = events.filter((e) => {
    if (e.type !== 'write_event') return false;
    if (e.payload?.tag !== 'SOURCE') return false;
    const imp = e.payload?.imported;
    if (imp && imp.field !== 'source') return false;
    return true;
  });
  sourceEvents.sort((a, b) => {
    const tsDiff = (b.ts || '').localeCompare(a.ts || '');
    if (tsDiff !== 0) return tsDiff;
    return b.seq - a.seq;
  });
  const blocks = sourceEvents.map((e) => (e.payload?.content || '').trim()).filter(Boolean);
  return blocks.join('\n\n');
}

function computeMechanicalFields(layer2, layer3) {
  // Jarvis counts lines INSIDE the CURATED/SOURCE markers. Empty content = 0 lines
  // (Jarvis's validator treats blank body content specially).
  const curatedLines = layer2 ? layer2.split('\n').length : 0;
  const sourceLines = layer3 ? layer3.split('\n').length : 0;
  const sourceKb = layer3 ? Math.round((Buffer.byteLength(layer3, 'utf8') / 1024) * 10) / 10 : 0;
  return { curated_lines: curatedLines, source_lines: sourceLines, source_kb: sourceKb };
}

/**
 * Format YAML frontmatter in Jarvis's preferred style:
 *   - inline flow arrays: `tags: [a, b, c]`
 *   - unquoted dates: `created: 2025-08-14`
 *   - folded summary: `summary: >\n  text`
 *
 * We hand-serialize because js-yaml's stringifier produces block arrays and
 * quoted dates by default, which diverges from Jarvis convention.
 */
function serializeFrontmatter(fm) {
  const lines = [];
  // Deterministic field order matching TEMPLATE.md
  // Matches Jarvis's TEMPLATE.md convention: sensitivity sits between
  // entities and status so it reads as a "shape" attribute of the topic.
  const fieldOrder = [
    'topic',
    'type',
    'tags',
    'entities',
    'sensitivity',
    'status',
    'created',
    'last_verified',
    'last_curated',
    'curated_lines',
    'source_lines',
    'source_kb',
    'summary',
  ];

  for (const key of fieldOrder) {
    if (!(key in fm)) continue;
    const v = fm[key];
    if (v === undefined || v === null) continue;

    if (Array.isArray(v)) {
      // Inline flow style: tags: [a, b, c]
      const items = v.map((x) => formatScalar(x));
      lines.push(`${key}: [${items.join(', ')}]`);
    } else if (key === 'summary' && typeof v === 'string' && v.trim()) {
      // Emit summary as folded scalar, preserving the author's original line
      // breaks verbatim (captured during import). No auto-wrap — respect
      // whatever structure the author chose.
      const summaryText = v.trim();
      const folded = summaryText
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
      lines.push(`${key}: >`);
      lines.push(folded);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
      // Unquoted date
      lines.push(`${key}: ${v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${key}: ${v}`);
    } else {
      // String — quote only if contains YAML-special chars
      lines.push(`${key}: ${formatScalar(v)}`);
    }
  }

  // Jarvis's corpus is inconsistent about trailing blank after summary (yaml
  // folded-scalar chomping mode varies: `>` clip keeps a blank, `>-` strip
  // removes it). If we captured the original style during import, honor it.
  if (fm._summary_trailing_blank !== false) {
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Word-wrap a summary string to ~width chars. Preserves existing newlines
 * and breaks long lines at word boundaries. Does not split mid-word.
 */
function wrapSummary(text, width = 78) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= width) {
      lines.push(paragraph);
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (!current) {
        current = word;
      } else if ((current + ' ' + word).length <= width) {
        current += ' ' + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.join('\n');
}

function formatScalar(v) {
  const s = String(v);
  // Needs quoting if contains YAML-special chars or leading/trailing whitespace
  if (/[:\[\]{},&*#?|<>=!%@`"']/.test(s) || /^\s|\s$/.test(s) || s === '') {
    // Use double quotes with escaping
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Build one layer section with Jarvis's formatting convention:
 *   <START_MARKER>
 *   \n
 *   <content — may be empty>
 *   \n
 *   <END_MARKER>
 *
 * Blank lines on BOTH sides of the body for visual separation. Empty body
 * collapses to just marker\n\nmarker (one blank between).
 */
function layerSection(startMarker, content, endMarker) {
  const body = (content || '').replace(/\n+$/, '');
  if (body === '') {
    return `${startMarker}\n\n${endMarker}`;
  }
  return `${startMarker}\n\n${body}\n\n${endMarker}`;
}

function serializeTopicFile(frontmatter, layer2, layer3) {
  const parts = [
    '---',
    serializeFrontmatter(frontmatter),
    '---',
    '',
    layerSection(MARKERS.curatedStart, layer2, MARKERS.curatedEnd),
    '',
    layerSection(MARKERS.sourceStart, layer3, MARKERS.sourceEnd),
  ];
  return parts.join('\n') + '\n';
}

export async function regenerateTopicFile({ slug, logReader, state }) {
  const events = await collectSlugEvents(logReader, slug);
  if (events.length === 0) {
    throw new Error(`regenerateTopicFile: no events for slug ${slug}`);
  }

  const frontmatter = buildFrontmatter({ slug, events, state });
  const layer2 = buildLayer2(events, state.retired_curated_seqs);
  const layer3 = buildLayer3(events);

  const mechanical = computeMechanicalFields(layer2, layer3);
  frontmatter.curated_lines = mechanical.curated_lines;
  frontmatter.source_lines = mechanical.source_lines;
  frontmatter.source_kb = mechanical.source_kb;

  return serializeTopicFile(frontmatter, layer2, layer3);
}

export async function regenerateAllTopicFiles({ logReader, state }) {
  const out = new Map();
  for (const [slug, meta] of state.topic_index.entries()) {
    // Only emit a topic file for "curated" slugs — ones that carry TOPIC_METADATA_SET
    // (from topic-file import, or future promotion via distill). Slugs that exist
    // only because event-log writes referenced them (e.g. `general`, `backup`)
    // stay event-log-only, matching Jarvis's pre-silo layout.
    if (!meta.topic_type) continue;
    const text = await regenerateTopicFile({ slug, logReader, state });
    out.set(slug, text);
  }
  return out;
}
