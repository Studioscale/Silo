/**
 * distill() — take a transcript + recent-history tokens, call the injected LLM
 * client, parse + validate its output, then dedup against recent history.
 *
 * This is the sync'ed Silo replacement for Jarvis's session-extract.js (which
 * does the same thing but writes straight to topic files). In Silo, distill()
 * returns structured entries — the caller is responsible for appending them
 * via the LogWriter so they flow through admission + matrix checks.
 *
 * The LLM client is pluggable (LLM = { complete(systemPrompt, userPrompt) }).
 * Tests inject a mock; the CLI wires a real OpenAI client.
 */

import { parseExtractedBatch } from './parse.js';
import { tokenize, isDuplicate } from './tokenize.js';
import { transcriptBody } from './transcript.js';

export const DISTILL_DEDUP_THRESHOLD = 0.8;
export const DEFAULT_SYSTEM_PROMPT_HEADER = `You are a memory extraction assistant. Read a conversation transcript and extract facts, decisions, and durable state changes worth remembering long-term. Be selective — extract only genuinely important, durable information.

EXTRACT:
- Architecture / deployment changes (e.g. "switched to Gunicorn 4 workers")
- Algorithm choices (e.g. "fuzzy phone matcher with Levenshtein ≤ 2")
- Security fixes — be specific about WHICH vulnerability (XSS in field X, SSRF via webhook Y, not "security audit")
- Data model decisions (constraints, invariants, migrations)
- Dropped/abandoned features with rationale
- Integrations + their auth model
- Specific bug fixes that reveal hidden assumptions
- Design-language decisions (e.g. "adopted Pipedrive-style Kanban") — capture the choice itself, not the iteration toward it

DO NOT extract:
- Low-information UI iteration: sequential tweaks to color, padding, dividers, shadows, spacing, font size
- Pleasantries, confirmations ("ok", "yes", "got it")
- Status updates already reflected in actions taken
- Repetitions of already-known facts
- Debugging noise (stack traces, error output)
- Transient instructions immediately acted on

ANTI-BUNDLING: when multiple distinct decisions exist (e.g. a security audit covering 4 separate vulnerabilities), write one entry per decision. Don't compress "audit v1.13.26→29" — write XSS-fix, SSRF-fix, superadmin-filter-fix, soft-delete-fix as separate entries.

For each item, assign:
1. A TAG: one of FACT, DECISION, CHANGED, PROCEDURE, TODO, EVENT
2. A CONFIDENCE: CONFIRMED (clear decisions / verified facts), TENTATIVE (considerations, open questions, "thinking about", "talvez"), or CONTEXT (background info worth remembering)
3. A TOPIC SLUG from the TOPIC-INDEX below (exact match). If unsure, use: general

Output format — ONE ENTRY PER LINE, exactly this shape (replace the uppercase placeholders with real values; never write the literal word TAG or CONFIDENCE):

    [AUTO-<tag>:<confidence>] <slug>: <content>

Examples of correctly formatted entries:
[AUTO-DECISION:CONFIRMED] acme-crm: Chose Flask/SQLite for backend. Django rejected as too heavy for our scale.
[AUTO-FACT:CONFIRMED] business: Acme Corp changed ownership — new owner Maria, starts 2026-05.
[AUTO-CHANGED:CONFIRMED] workshop: Equipment hours updated to 4200 (was 3800).
[AUTO-TODO:CONFIRMED] finance: Follow up with accountant re Q2 tax filing; due 2026-04-15.
[AUTO-DECISION:TENTATIVE] product: Considering per-employee AI assistants. No decision yet — evaluating cost vs. value.
[AUTO-FACT:CONTEXT] people: Ana is the main contact handling the Acme account.

If nothing worth extracting, output exactly: NOTHING_TO_EXTRACT

Do not number entries. Do not repeat an entry verbatim.

LANGUAGE: write entries in ENGLISH by default, even when the source transcript is in another language. Translate non-English content to English for the entry. Quote original-language terms verbatim only when they're proper nouns or untranslatable domain jargon.

TOPIC-INDEX:`;

/**
 * @param {Object} args
 * @param {Array<{role:string,text:string}>} args.messages  transcript messages
 * @param {string} [args.topicIndex]  topic index body injected into system prompt
 * @param {Array<Array<string>>} [args.recentTokens]  tokenized recent entries for dedup
 * @param {Object} args.llm  pluggable LLM client — must expose async complete(system, user)
 * @param {number} [args.threshold]  jaccard dedup threshold
 * @param {string} [args.systemPromptHeader]
 * @returns {Promise<{entries: Array, candidates: number, deduped: number, rawResponse: string|null, usage: Object|null}>}
 */
export async function distill({
  messages,
  topicIndex = '',
  recentTokens = [],
  llm,
  threshold = DISTILL_DEDUP_THRESHOLD,
  systemPromptHeader = DEFAULT_SYSTEM_PROMPT_HEADER,
}) {
  if (!llm || typeof llm.complete !== 'function') {
    throw new Error('distill: llm client with .complete(system, user) required');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { entries: [], candidates: 0, deduped: 0, rawResponse: null, usage: null };
  }

  const systemPrompt = `${systemPromptHeader}\n${topicIndex}`;
  const userPrompt = `Extract memory entries from this conversation transcript:\n\n${transcriptBody(messages)}`;

  const response = await llm.complete(systemPrompt, userPrompt);
  const rawResponse = response?.content ?? null;
  const usage = response?.usage ?? null;

  const candidates = parseExtractedBatch(rawResponse ?? '');
  const survived = [];
  const survivorTokens = [...recentTokens];

  for (const candidate of candidates) {
    const tokens = tokenize(candidate.content);
    if (isDuplicate(tokens, survivorTokens, threshold)) continue;
    survived.push(candidate);
    survivorTokens.push(tokens);
  }

  return {
    entries: survived,
    candidates: candidates.length,
    deduped: candidates.length - survived.length,
    rawResponse,
    usage,
  };
}

/**
 * Convert distilled entries into write_event inputs for LogWriter.append().
 * One entry per write_event.
 */
export function entriesToWriteEvents(entries, { principal, sourceTag = 'distill' } = {}) {
  if (!principal) throw new Error('entriesToWriteEvents: principal required');
  return entries.map((entry) => ({
    type: 'write_event',
    isStateBearing: true,
    intentId: null, // caller assigns
    principal,
    payload: {
      slug: entry.slug,
      tag: entry.tag,
      content: entry.content,
      confidence: entry.confidence,
      auto_extracted: true,
      source: sourceTag,
    },
  }));
}
