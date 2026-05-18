/**
 * Topic-proposal detection — Phase 2.2 §9.
 *
 * Scans `general`-slug events for clusters that should become their own
 * topic. Emits TOPIC_SUGGESTED events for valid clusters.
 *
 * Cron wrapper (silo-detect.sh, §15 step 10) calls into this module via
 * `silo suggest --run-now` (CLI subcommand, §15 step 8). Bash-side wraps
 * the run with `[FACT] silo-detect run started/complete` events under
 * `system`; this module emits in-progress status events for insufficient
 * events, sampled-on-overflow, first-run-deferred, and (of course) the
 * TOPIC_SUGGESTED events themselves.
 *
 * Determinism: detection uses an LLM (non-deterministic). To make
 * duplicate cron runs land identical intent_ids (the replay sees them in
 * state.skipped rather than as new events), intent_id is built from the
 * UTC date + the cluster's support fingerprint.
 */

import { v7 as uuidv7 } from 'uuid';
import { interpret } from '../interpret/index.js';
import { normalizeSlugKey, isValidSlug } from '../admission/slug.js';
import { computeSupportFingerprint } from '../util/support-fingerprint.js';

const DEFAULT_SCAN_SLUGS = ['general'];
const DEFAULT_DAYS_BACK = 30;
const DEFAULT_MIN_EVENTS = 3;
const DEFAULT_MAX_INPUT_CHARS = 200_000; // ~50k tokens at 4 chars/token
const DEFAULT_MAX_SUGGESTIONS_PER_RUN = 3;
const DEFAULT_FINGERPRINT_OVERLAP_THRESHOLD = 0.65;
const DEFERRAL_GENERAL_COUNT_THRESHOLD = 50;
const DETECTOR_SOURCE = 'silo-topic-detector';
const DETECTOR_PRINCIPAL = 'topic-detector';

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * Pure helper exported so external consumers (CLI status output, MCP
 * server health checks) can ask "is this cooldown still active?" against
 * a record from `state.cooldowns_by_normalized_slug`.
 *
 * Wall-clock comparison happens HERE — never inside interpret().
 */
export function isCooldownActive(record, now = Date.now()) {
  if (!record) return false;
  if (record.cleared_by_accept_seq != null) return false;
  return now < record.until_ts;
}

/**
 * Run one detection pass.
 *
 * @param {Object} args
 * @param {LogWriter} args.writer
 * @param {Object} [args.state] - if omitted, interpret(writer) runs fresh
 * @param {Object} args.llm    - duck-typed: {complete(systemPrompt, userPrompt)}
 * @param {Object} [args.options]
 * @param {Array<string>} [args.options.scan_slugs]
 * @param {number} [args.options.days_back]
 * @param {number} [args.options.min_events]
 * @param {number} [args.options.max_input_chars]
 * @param {number} [args.options.max_suggestions_per_run]
 * @param {number} [args.options.fingerprint_overlap_threshold]
 * @param {string} [args.options.principal]  - principal for status events
 * @param {boolean} [args.bulkScan] - bypass the first-run deferral gate
 * @param {string} [args.runId]
 * @param {boolean} [args.dryRun]
 * @param {number} [args.now]
 * @returns {Promise<Object>} result summary
 */
export async function detectTopicClusters({
  writer,
  state: providedState,
  llm,
  options = {},
  bulkScan = false,
  runId,
  dryRun = false,
  now = Date.now(),
}) {
  const opts = {
    scan_slugs: options.scan_slugs ?? DEFAULT_SCAN_SLUGS,
    days_back: options.days_back ?? DEFAULT_DAYS_BACK,
    min_events: options.min_events ?? DEFAULT_MIN_EVENTS,
    max_input_chars: options.max_input_chars ?? DEFAULT_MAX_INPUT_CHARS,
    max_suggestions_per_run: options.max_suggestions_per_run ?? DEFAULT_MAX_SUGGESTIONS_PER_RUN,
    fingerprint_overlap_threshold:
      options.fingerprint_overlap_threshold ?? DEFAULT_FINGERPRINT_OVERLAP_THRESHOLD,
    principal: options.principal ?? DETECTOR_PRINCIPAL,
  };

  const state = providedState ?? (await interpret(writer));

  // First-run deferral: if no prior TOPIC_SUGGESTED + general event count > 50,
  // skip and emit a deferral status. The `--bulk-scan` flag overrides.
  if (!bulkScan && shouldDeferFirstRun(state, opts.scan_slugs)) {
    const generalCount = countSlugEvents(state, opts.scan_slugs);
    const message = `silo-detect first run deferred (general_count=${generalCount}, run silo suggest --bulk-scan to onboard)`;
    if (!dryRun) await emitStatus(writer, message, opts.principal);
    return { status: 'first_run_deferred', skipped: true, message, suggested: [] };
  }

  // Collect candidate events (filter out detector-sourced — anti-self-citation).
  const candidates = selectScanEvents(state, opts.scan_slugs, opts.days_back, now);
  if (candidates.length < opts.min_events) {
    const message = `silo-detect: insufficient events, no clusters (count=${candidates.length}, min=${opts.min_events})`;
    if (!dryRun) await emitStatus(writer, message, opts.principal);
    return { status: 'insufficient_events', skipped: true, message, suggested: [] };
  }

  // Cap to max_input_chars via stratified sampling.
  const sampled = stratifiedSample(candidates, opts.max_input_chars);
  if (sampled.length < candidates.length) {
    const message = `silo-detect: sampled ${sampled.length} of ${candidates.length} events`;
    if (!dryRun) await emitStatus(writer, message, opts.principal);
  }

  // Build prompt + call LLM.
  const topicIndex = [...state.topic_index.entries()]
    .filter(([, m]) => m.topic_type)
    .map(([slug, m]) => `${slug} | ${m.topic_type} | ${m.topic_summary ?? ''}`)
    .join('\n');
  const { systemPrompt, userPrompt } = buildDetectionPrompt(sampled, topicIndex, opts);

  let llmRaw = '';
  let llmUsage = null;
  if (!dryRun) {
    const response = await llm.complete(systemPrompt, userPrompt);
    llmRaw = response?.content ?? '';
    llmUsage = response?.usage ?? null;
  }

  const proposals = dryRun ? [] : parseDetectionResponse(llmRaw);

  // Validate each proposal.
  const validated = [];
  const rejected = [];
  for (const p of proposals) {
    const reject = validateClusterProposal(p, state, opts, now);
    if (reject) {
      rejected.push({ proposal: p, reason: reject });
      continue;
    }
    validated.push(p);
    if (validated.length >= opts.max_suggestions_per_run) break;
  }

  // Emit TOPIC_SUGGESTED events.
  const todayUtc = new Date(now).toISOString().slice(0, 10);
  const suggestedRecords = [];
  if (!dryRun) {
    for (const p of validated) {
      const fp = computeSupportFingerprint(p.supporting_seqs);
      const intentId = `intent:silo-detect:${todayUtc}:cluster-${fp}`;
      const r = await writer.append({
        type: 'TOPIC_SUGGESTED',
        isStateBearing: true,
        intentId,
        principal: opts.principal,
        payload: {
          slug: p.slug,
          name: p.name,
          description: p.description,
          supporting_seqs: p.supporting_seqs,
          rationale: p.rationale,
          source: DETECTOR_SOURCE,
        },
      });
      suggestedRecords.push({ seq: r.seq, slug: p.slug, fingerprint: fp });
    }
  }

  return {
    status: 'ok',
    skipped: false,
    candidates: candidates.length,
    sampled: sampled.length,
    proposed: proposals.length,
    validated: validated.length,
    rejected,
    suggested: suggestedRecords,
    runId,
    llmUsage,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function shouldDeferFirstRun(state, scanSlugs) {
  const hasAnyPriorSuggested = state.topic_suggestions.size > 0;
  if (hasAnyPriorSuggested) return false;
  // Check for prior deferral marker in system events — once deferred, stay
  // deferred until --bulk-scan runs (which bypasses this gate).
  const sys = state.topic_content.get('system') ?? [];
  const alreadyDeferred = sys.some(
    (e) => typeof e.content === 'string' && e.content.includes('first run deferred'),
  );
  if (alreadyDeferred) return true;
  // First time we see a deferral-worthy state: count current scan-slug events.
  const count = countSlugEvents(state, scanSlugs);
  return count > DEFERRAL_GENERAL_COUNT_THRESHOLD;
}

export function countSlugEvents(state, scanSlugs) {
  let n = 0;
  for (const slug of scanSlugs) {
    const events = state.topic_content.get(slug) ?? [];
    n += events.length;
  }
  return n;
}

/**
 * Select scan-slug write_events within `days_back`, excluding detector-
 * sourced entries (anti-self-citation per §9.2 step 2).
 */
export function selectScanEvents(state, scanSlugs, daysBack, now) {
  const cutoffMs = now - daysBack * 86400000;
  const out = [];
  for (const slug of scanSlugs) {
    const events = state.topic_content.get(slug) ?? [];
    for (const e of events) {
      if (!e.ts) continue;
      const ms = Date.parse(e.ts);
      if (Number.isNaN(ms) || ms < cutoffMs) continue;
      // Cross-reference seq_to_event for the source field — topic_content
      // doesn't carry source. If seq lookup fails, keep the event (it's at
      // least real — replay edge cases shouldn't drop scan candidates).
      const detail = state.seq_to_event.get(e.seq);
      const source = detail?.source ?? null;
      if (source === DETECTOR_SOURCE) continue;
      out.push({
        seq: e.seq,
        slug,
        tag: e.tag || null,
        content: e.content,
        ts: e.ts,
        source,
      });
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/**
 * Cap events to fit within `maxChars`. When over, retain first + last and
 * every-Kth from the middle (deterministic sampling — same input → same
 * output, no randomness).
 */
export function stratifiedSample(events, maxChars) {
  const totalChars = events.reduce((n, e) => n + (e.content?.length ?? 0) + 32, 0);
  if (totalChars <= maxChars || events.length <= 2) return events.slice();
  // Estimate keep count from ratio.
  const avgPerEvent = totalChars / events.length;
  const targetCount = Math.max(2, Math.floor(maxChars / avgPerEvent));
  if (targetCount >= events.length) return events.slice();
  // Always keep first and last; pick every-Kth from the middle.
  const middleNeeded = targetCount - 2;
  if (middleNeeded <= 0) return [events[0], events[events.length - 1]];
  const middle = events.slice(1, -1);
  const step = middle.length / middleNeeded;
  const picked = [events[0]];
  for (let i = 0; i < middleNeeded; i++) {
    const idx = Math.floor((i + 0.5) * step);
    picked.push(middle[idx]);
  }
  picked.push(events[events.length - 1]);
  return picked;
}

export function buildDetectionPrompt(events, topicIndex, opts) {
  const eventsFormatted = events
    .map((e) => `[seq ${e.seq}] [${(e.ts || '').slice(0, 10)}] [${e.tag || 'EVENT'}] ${e.content}`)
    .join('\n');

  const systemPrompt = `You are a topic-clustering analyst for the Silo memory system. Your job is to look at recent \`general\`-slug events and propose NEW topic files for clusters that deserve their own domain.

EXISTING TOPICS (do NOT propose any of these slugs — these already have their own files):
${topicIndex || '(none yet)'}

ANTI-FRAGMENTATION RULES (apply STRICTLY):
- Prefer fewer, broader topics over many narrow ones
- A cluster needs at least ${opts.min_events} supporting events with consistent subject matter
- Reject clusters whose slug matches or near-matches an existing topic
- Reject thin/incidental groupings — one-off mentions don't justify a new file
- Reject clusters whose evidence is purely transient (single-day burst with no follow-up)

OUTPUT FORMAT — strict JSON array, in a fenced \`\`\`json block, OR exactly the literal \`NOTHING_TO_PROPOSE\`:

\`\`\`json
[
  {
    "slug": "lowercase-kebab-slug",
    "name": "Short Title Case Name",
    "description": "One-line description ≤240 chars, no newlines",
    "rationale": "Why this cluster deserves its own topic — ≤500 chars, single line",
    "supporting_seqs": [1421, 1438, 1502]
  }
]
\`\`\`

OUTPUT RULES:
- slug: kebab-case, 2..40 chars, /^[a-z0-9]+(-[a-z0-9]+)*$/
- supporting_seqs: must be a subset of the seq numbers you see below; strictly ascending; 1..100 entries; ALL real
- At most ${opts.max_suggestions_per_run} proposals per run
- DO NOT invent supporting_seqs — every seq must appear in the events list below
- If nothing strong, output exactly: NOTHING_TO_PROPOSE`;

  const userPrompt = `Recent events from scan slugs ${opts.scan_slugs.join(', ')} (last ${opts.days_back}d):

${eventsFormatted}`;

  return { systemPrompt, userPrompt };
}

/**
 * Extract JSON array from a fenced ```json``` block, or 'NOTHING_TO_PROPOSE'.
 * Returns Array<proposal> or [] on parse failure / sentinel.
 */
export function parseDetectionResponse(raw) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === 'NOTHING_TO_PROPOSE') return [];
  // First fenced JSON block wins.
  const blockMatch = trimmed.match(/```json\s*([\s\S]+?)```/i);
  const jsonText = blockMatch ? blockMatch[1].trim() : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p) => p && typeof p === 'object');
}

/**
 * Validate one cluster proposal. Returns a rejection-reason string if the
 * proposal should be rejected, or null if it passes.
 */
export function validateClusterProposal(proposal, state, opts, now) {
  // 1. Shape — supporting_seqs array, slug/name/description/rationale strings
  if (!proposal || typeof proposal !== 'object') return 'invalid_shape';
  const { slug, name, description, rationale, supporting_seqs } = proposal;
  if (typeof slug !== 'string') return 'slug_missing';
  if (typeof name !== 'string' || name.length === 0) return 'name_missing';
  if (typeof description !== 'string' || description.length === 0) return 'description_missing';
  if (typeof rationale !== 'string' || rationale.length === 0) return 'rationale_missing';
  if (!Array.isArray(supporting_seqs) || supporting_seqs.length === 0) return 'supporting_seqs_missing';

  // 2. Slug regex
  if (!isValidSlug(slug)) return 'slug_invalid_regex';

  // 3. Slug already exists in TOPIC-INDEX
  const existingMeta = state.topic_index.get(slug);
  if (existingMeta?.topic_type) return 'slug_collision_with_topic_index';

  // 4. Cooldown
  const normalized = normalizeSlugKey(slug);
  const cd = state.cooldowns_by_normalized_slug.get(normalized);
  if (isCooldownActive(cd, now)) return 'cooldown_active';

  // 5. Supporting seqs: each must exist in seq_to_event, be a write_event,
  //    have slug in scan_slugs (anti-hallucination).
  const seenSeqs = new Set();
  for (const s of supporting_seqs) {
    if (!Number.isSafeInteger(s) || s < 1) return 'supporting_seq_invalid';
    if (seenSeqs.has(s)) return 'supporting_seq_duplicate';
    seenSeqs.add(s);
    const ev = state.seq_to_event.get(s);
    if (!ev) return 'supporting_seq_not_found';
    if (!opts.scan_slugs.includes(ev.slug)) return 'supporting_seq_wrong_slug';
    if (ev.source === DETECTOR_SOURCE) return 'supporting_seq_self_citation';
  }

  // 6. Strictly ascending unique
  const sorted = [...supporting_seqs].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= sorted[i - 1]) return 'supporting_seqs_not_strictly_ascending';
  }
  if (JSON.stringify(sorted) !== JSON.stringify(supporting_seqs)) {
    // Normalize: take the sorted version
    proposal.supporting_seqs = sorted;
  }

  // 7. Support-fingerprint overlap (Jaccard) against pending + cooldown-active
  const proposalSet = new Set(supporting_seqs);
  for (const [otherSeq, otherSug] of state.topic_suggestions.entries()) {
    if (otherSug.status === 'pending') {
      const overlap = jaccardOverlap(proposalSet, new Set(otherSug.supporting_seqs));
      if (overlap >= opts.fingerprint_overlap_threshold) {
        return `support_overlap_pending_seq_${otherSeq}`;
      }
    }
  }
  // Cooldown-active dismissed: walk history records that are uncleared and not expired.
  for (const [normSlug, history] of state.dismissed_topic_suggestion_history.entries()) {
    for (const rec of history) {
      if (rec.cleared_by_accept_seq != null) continue;
      if (now >= rec.until_ts) continue;
      const sug = state.topic_suggestions.get(rec.suggestion_seq);
      if (!sug) continue;
      const overlap = jaccardOverlap(proposalSet, new Set(sug.supporting_seqs));
      if (overlap >= opts.fingerprint_overlap_threshold) {
        return `support_overlap_cooldown_active_${normSlug}`;
      }
    }
  }

  return null;
}

export function jaccardOverlap(a, b) {
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function emitStatus(writer, content, principal) {
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: `intent:${uuidv7()}`,
    principal,
    payload: {
      slug: 'system',
      tag: 'FACT',
      content,
      source: DETECTOR_SOURCE,
    },
  });
}

export {
  DEFAULT_SCAN_SLUGS,
  DEFAULT_DAYS_BACK,
  DEFAULT_MIN_EVENTS,
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_MAX_SUGGESTIONS_PER_RUN,
  DEFAULT_FINGERPRINT_OVERLAP_THRESHOLD,
  DEFERRAL_GENERAL_COUNT_THRESHOLD,
  DETECTOR_SOURCE,
  DETECTOR_PRINCIPAL,
};
