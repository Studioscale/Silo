/**
 * Bootstrap curate — Phase 2.2 §10.
 *
 * When `accept_suggestion` creates a topic, the new topic has no own-slug
 * events (the supporting evidence still lives under `general`). Normal
 * `silo curate` is conditioned on the topic having recent events under
 * its OWN slug; without bootstrap, the new topic would never get a Layer 2.
 *
 * Bootstrap runs as a pre-loop pass inside `silo curate`. For each
 * eligible accepted-but-empty topic, it feeds the suggestion's
 * supporting_seqs to the LLM with a dedicated prompt that frames the
 * task as "seed Layer 2 from the original `general` evidence".
 *
 * After bootstrap, the topic has ≥1 CURATED bullet, so the eligibility
 * predicate returns false and the pass is a no-op on subsequent runs.
 */

const BOOTSTRAP_MAX_AGE_DAYS = 60;
const DEFAULT_MAX_BULLETS = 12;
const SUPPORTING_SEQS_TRUNCATION = 50;

/**
 * @param {string} slug
 * @param {Object} state - interpret() output
 * @param {number} [now] - wall-clock ms (test seam)
 * @returns {boolean}
 */
export function isBootstrapEligible(slug, state, now = Date.now()) {
  // 1. Topic must have metadata (otherwise it's an event-log-only slug)
  const meta = state.topic_index.get(slug);
  if (!meta?.topic_type) return false;

  // 2. Topic must trace back to an accepted suggestion (bootstrap index hit)
  const suggestionSeq = state.accepted_topic_suggestion_by_slug.get(slug);
  if (!suggestionSeq) return false;

  // 3. Suggestion must be in `accepted` status
  const suggestion = state.topic_suggestions.get(suggestionSeq);
  if (!suggestion || suggestion.status !== 'accepted') return false;

  // 4. Topic must currently have ZERO active curated bullets — bootstrap
  //    has not run yet. Retired bullets don't count (they were "active"
  //    before retirement and bootstrap has already happened in that case).
  const ownEvents = state.topic_content.get(slug) ?? [];
  const ownCurated = ownEvents.filter(
    (h) => h.tag === 'CURATED' && !state.retired_curated_seqs.has(h.seq),
  );
  if (ownCurated.length > 0) return false;

  // 5. Don't bootstrap stale acceptances — if the operator accepted a
  //    suggestion months ago and never ran curate, the original
  //    supporting events may no longer reflect current intent.
  const resolvedAt = suggestion.resolved_at;
  if (!resolvedAt) return false;
  const ageDays = (now - Date.parse(resolvedAt)) / 86400000;
  if (ageDays > BOOTSTRAP_MAX_AGE_DAYS) return false;

  return true;
}

/**
 * Resolve the supporting events for bootstrap. Returns the most-recent
 * SUPPORTING_SEQS_TRUNCATION events (by seq descending, then re-sorted
 * ascending for the prompt). Drops seqs missing from state.seq_to_event
 * (defensive — the admission validator pins supporting_seqs to real
 * write_events, so this should only matter under exotic replay edge cases).
 */
export function resolveBootstrapEvents(supporting_seqs, state) {
  const all = supporting_seqs
    .map((seq) => {
      const ev = state.seq_to_event.get(seq);
      if (!ev) return null;
      return { seq, ...ev };
    })
    .filter(Boolean);
  // Take the SUPPORTING_SEQS_TRUNCATION most-recent (highest seq), then
  // present to LLM in chronological order (ts ascending → most-recent last).
  const recent = all.slice(-SUPPORTING_SEQS_TRUNCATION);
  recent.sort((a, b) => {
    const ta = a.ts ?? '';
    const tb = b.ts ?? '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return a.seq - b.seq;
  });
  return recent;
}

/**
 * @param {Object} args
 * @param {string} args.slug
 * @param {string} args.name
 * @param {string} args.summary
 * @param {string} args.type
 * @param {Array<string>} [args.tags]
 * @param {Array<{seq, slug, tag, content, ts}>} args.events
 * @param {number} [args.maxBullets]
 * @returns {{systemPrompt: string, userPrompt: string}}
 */
export function buildBootstrapPrompt({ slug, name, summary, type, tags = [], events, maxBullets = DEFAULT_MAX_BULLETS }) {
  const eventsFormatted = events
    .map((e) => `[${(e.ts || '').slice(0, 10)}] [${e.tag || 'EVENT'}] ${e.content}`)
    .join('\n');

  const systemPrompt = `You are bootstrapping a brand-new topic with no curated content. The user just
created the topic "${slug}" (type=${type}) from a topic-detector suggestion.

Below are the original events from \`general\` that triggered the detection.
They are the seed material for this topic.

Your task: write durable curated bullets (Layer 2) that capture what's worth
remembering ABOUT THE TOPIC LONG-TERM. Phrase bullets as facts/decisions
about ${slug}, not as event timestamps.

Topic name: ${name}
Topic summary: ${summary}
Tags: ${tags.length ? tags.join(', ') : '(none)'}

OUTPUT RULES:
- New bullets only, one per line, each starting with "- "
- Each bullet ≤200 chars, single line, no newlines mid-bullet
- No headings, no numbering, no prose before/after
- At most ${maxBullets} bullets
- If nothing is durable enough to write, output exactly: NOTHING_TO_ADD`;

  const userPrompt = `Seed events from \`general\` (sorted oldest→newest):
${eventsFormatted}`;

  return { systemPrompt, userPrompt };
}

/**
 * Parse the LLM's bootstrap response. Returns:
 *   - 'NOTHING_TO_ADD' literal when that sentinel appears alone
 *   - Array<string> of bullet bodies (stripped of leading "- "; each ≤200
 *     chars, single line). Empty / over-cap lines are silently dropped.
 *
 * @param {string} raw
 * @param {number} [maxBullets]
 * @returns {'NOTHING_TO_ADD' | Array<string>}
 */
export function parseBootstrapResponse(raw, maxBullets = DEFAULT_MAX_BULLETS) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === 'NOTHING_TO_ADD') return 'NOTHING_TO_ADD';
  const bullets = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((b) => b.length > 0 && b.length <= 200 && !/[\r\n]/.test(b))
    .slice(0, maxBullets);
  return bullets;
}

export { BOOTSTRAP_MAX_AGE_DAYS, DEFAULT_MAX_BULLETS, SUPPORTING_SEQS_TRUNCATION };
