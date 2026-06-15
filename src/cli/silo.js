#!/usr/bin/env node
/**
 * silo CLI — v12.5 M1.
 *
 * Environment variables (override defaults so flags are optional):
 *   SILO_DIR        Default for --silo-dir       (otherwise: .silo in cwd)
 *   SILO_PRINCIPAL  Default for --principal      (otherwise: operator)
 *
 * Commands:
 *   silo init [--silo-dir=...] [--operator=<name>] [--uid=<n>]
 *     Initialize a fresh silo: creates the data dir, emits identity events.
 *
 *   silo status [--silo-dir=...]
 *     Show broker state summary (tier, principals, topic count, tail).
 *
 *   silo write --slug=<s> --tag=<t> --content="..." [--principal=<p>] [--silo-dir=...]
 *     Append a write_event.
 *
 *   silo read --slug=<s> [--silo-dir=...]
 *     Print topic history.
 *
 *   silo search <query> [--mode=exact|context|orient] [--flags=...] [--principal=<p>] [--silo-dir=...]
 *     Retrieve matching topics.
 *
 *   silo import-jarvis --from <path> [--silo-dir=...]
 *     Import existing memory (topic files + event log) as v12.5 events.
 */

import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { LogWriter } from '../log/append.js';
import { interpret } from '../interpret/index.js';
import { stateToJson } from '../interpret/state.js';
import { retrieve } from '../retrieval/index.js';
import { loadMatrix } from '../matrix/load.js';
import { importDirectory } from '../import-jarvis/index.js';
import { regenerateProjections } from '../projection/index.js';
import { readSessionDelta } from '../distill/transcript.js';
import { distill } from '../distill/distill.js';
import { tokenize, jaccardSimilarity } from '../distill/tokenize.js';
import { pickLlmClient } from '../distill/llm-factory.js';
import {
  isBootstrapEligible,
  resolveBootstrapEvents,
  buildBootstrapPrompt,
  parseBootstrapResponse,
} from '../curate/bootstrap.js';
import { detectTopicClusters, isCooldownActive } from '../topic-proposal/detect.js';
import {
  acceptSuggestion,
  dismissSuggestions,
  SuggestionOpError,
} from '../topic-proposal/suggestion-ops.js';
import {
  retireBullet,
  filterActiveCuratedSeqs,
  RetireOpError,
} from '../topic-proposal/retire-ops.js';
import {
  isOptOut as isUpdateOptOut,
  maybeFireUpdateCheck,
  performCheck,
  readCache as readUpdateCache,
  writeCache as writeUpdateCache,
  CURRENT_VERSION as SILO_VERSION,
  CACHE_FILENAME as UPDATE_CACHE_FILENAME,
  HEALTHY_FAILURE_THRESHOLD,
} from '../util/update-check.js';
import {
  deriveCuratorStatus,
  foldLiveness,
  readCurateStatus,
  writeCurateStatus,
} from '../util/curate-liveness.js';
import {
  looksLikeLlmError,
  formatLlmErrorForCli,
} from '../distill/llm-errors.js';

// Defaults can be overridden by env vars (standard CLI pattern: KUBECONFIG,
// AWS_PROFILE, EDITOR, etc.) so users don't have to pass --silo-dir and
// --principal on every invocation. Set them once in your shell:
//   export SILO_DIR=/path/to/your/silo-memory
//   export SILO_PRINCIPAL=alice
// Or on Windows: set them as persistent user env vars via System Properties.
const GLOBAL_OPTIONS = {
  'silo-dir': { type: 'string', default: process.env.SILO_DIR || '.silo' },
  principal: { type: 'string', default: process.env.SILO_PRINCIPAL || 'operator' },
};

async function openWriter(siloDir) {
  const writer = new LogWriter(siloDir);
  await writer.init();
  return writer;
}

function nextIntentId() {
  return `intent:${uuidv7()}`;
}

// ── LLM-config diagnostics shared by cmdDoctor + missing-key errors ─────────

/**
 * Returns null when no provider env var is set, otherwise an object
 * describing what pickLlmClient() would resolve to. Pure read of the env;
 * no network or auth call.
 */
function describeLlmConfig() {
  const anthropicSet = !!process.env.ANTHROPIC_API_KEY;
  const openaiSet = !!process.env.OPENAI_API_KEY;
  if (!anthropicSet && !openaiSet) return null;
  const { client, providerName, error } = pickLlmClient({});
  return {
    providerName,
    defaultModel: client?.model ?? null,
    anthropicSet,
    openaiSet,
    error,
  };
}

/** Multi-line missing-provider error pointed at any silo subcommand. */
function noLlmProviderMessage(cmd) {
  return [
    `silo ${cmd}: no LLM provider configured.`,
    '  Set ANTHROPIC_API_KEY (recommended: claude-sonnet-4-6) or',
    '  OPENAI_API_KEY (recommended: gpt-5.4). See README "Prerequisites".',
    '  Or pass --dry-run to skip the LLM call.',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function cmdInit({ 'silo-dir': siloDir, operator, uid }) {
  const writer = await openWriter(siloDir);
  const tail = writer.tail();
  if (tail.seq > 0) {
    console.error(`silo: ${siloDir} already has ${tail.seq} entries; refusing to reinit`);
    process.exit(1);
  }

  const principal = operator || 'operator';
  const uidNum = uid ? Number.parseInt(uid, 10) : process.getuid?.() ?? 0;

  // M3 — identity events ride the admin socket per matrix.yaml.
  // Pre-gate (i.e. before src/log/append.js wires Matrix.isAdmissible)
  // this is a no-op at runtime; the writer doesn't read socket yet.
  // Lands separately from the gate so each commit stays CI-green.
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    socket: 'admin',
    isStateBearing: true,
    intentId: nextIntentId(),
    principal: 'bootstrap',
    payload: { principal, class: 'human' },
  });
  await writer.append({
    type: 'PRINCIPAL_UID_BOUND',
    socket: 'admin',
    isStateBearing: true,
    intentId: nextIntentId(),
    principal: 'bootstrap',
    payload: { principal, uid: uidNum },
  });
  await writer.append({
    type: 'PRINCIPAL_ACCESS_ENABLED',
    socket: 'admin',
    isStateBearing: true,
    intentId: nextIntentId(),
    principal: 'bootstrap',
    payload: { principal },
  });

  console.log(`silo: initialized at ${siloDir}`);
  console.log(`  operator = ${principal} (uid ${uidNum})`);
  console.log(`  tail = seq ${writer.tail().seq}`);
  console.log('');
  console.log('Next steps:');
  console.log('  silo write --slug=<topic> --content="..."  — append your first event');
  console.log('  silo curate                                  — promote events to Layer 2 (LLM key required)');
  console.log('  silo suggest --run-now                       — auto-detect new topics from `general` events');
  console.log('  silo suggest --list                          — review pending topic suggestions');
}

async function cmdStatus({ 'silo-dir': siloDir }) {
  const writer = await openWriter(siloDir);
  const state = await interpret(writer);
  const json = stateToJson(state);
  const summary = {
    silo_dir: siloDir,
    tier: json.tier,
    current_mode: json.current_mode,
    last_seq: json.last_seq,
    principals: Object.keys(json.principals),
    topic_count: Object.keys(json.topic_index).length,
    topics: Object.keys(json.topic_index).slice(0, 20),
    feature_flags: json.feature_flags,
    dedup_witness_size: json.dedup_witness_size,
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function cmdWrite({ 'silo-dir': siloDir, slug, tag, content, principal, confidence, source }) {
  if (!slug || !content) {
    console.error('silo write: --slug and --content required');
    process.exit(2);
  }
  const writer = await openWriter(siloDir);
  const payload = { slug, tag: tag || 'FACT', content };
  if (confidence) payload.confidence = confidence;
  if (source) payload.source = source;
  const result = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: nextIntentId(),
    principal,
    payload,
  });
  console.log(`written: seq ${result.seq} slug=${slug} tag=${tag || 'FACT'}${confidence ? ':' + confidence : ''}${source ? ' source=' + source : ''}`);
}

async function cmdRead({ 'silo-dir': siloDir, slug }) {
  if (!slug) {
    console.error('silo read: --slug required');
    process.exit(2);
  }
  const writer = await openWriter(siloDir);
  const state = await interpret(writer);
  const meta = state.topic_index.get(slug);
  if (!meta) {
    console.error(`silo read: topic "${slug}" not found`);
    process.exit(1);
  }
  const history = state.topic_content.get(slug) || [];
  console.log(`# ${slug}`);
  console.log(`last_updated_seq: ${meta.last_updated_seq}`);
  console.log(`tags: ${[...meta.tags].join(', ') || '(none)'}`);
  console.log(`events: ${history.length}`);
  console.log('');
  for (const h of history) {
    console.log(`[seq ${h.seq}] [${h.tag || 'EVENT'}] ${h.ts} ${h.principal}: ${h.content}`);
  }
}

async function cmdSearch({
  'silo-dir': siloDir,
  query,
  mode = 'context_retrieval',
  flags,
  principal,
  limit,
  n,
}) {
  // Normalize CLI alias: --mode=orient → orientation_view
  const normalizedMode =
    mode === 'orient' ? 'orientation_view' :
    mode === 'exact' ? 'exact_lookup' :
    mode === 'context' ? 'context_retrieval' :
    mode;

  if (normalizedMode !== 'orientation_view' && !query) {
    console.error('silo search: query required for exact/context modes');
    process.exit(2);
  }

  const writer = await openWriter(siloDir);
  const state = await interpret(writer);
  const result = retrieve({
    state,
    query: query || '',
    mode: normalizedMode,
    principal,
    flags: flags ? flags.split(',').map((s) => s.trim()).filter(Boolean) : [],
    limit: limit ? Number.parseInt(limit, 10) : 10,
    n: n ? Number.parseInt(n, 10) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdImportJarvis({ 'silo-dir': siloDir, from, principal }) {
  if (!from) {
    console.error('silo import-jarvis: --from <dir> required');
    process.exit(2);
  }
  const writer = await openWriter(siloDir);
  const result = await importDirectory({
    fromDir: from,
    writer,
    principal,
  });
  const output = {
    topics_imported: result.topicsImported,
    events_emitted: result.eventsEmitted,
    per_topic: result.details.map((d) =>
      d.error
        ? { slug: d.slug, error: d.error }
        : {
            slug: d.slug,
            events: d.events.length,
            curated_sections: d.curated_sections,
            source_blocks: d.source_blocks,
          },
    ),
  };
  if (result.events) {
    output.event_logs = {
      files_processed: result.events.filesProcessed,
      events_from_logs: result.events.totalEvents,
      per_file: result.events.results.map((r) =>
        r.skipped
          ? { filename: r.filename ?? '(unknown)', skipped: true, reason: r.reason }
          : {
              date: r.date,
              filename: r.filename,
              events: r.eventCount,
              unrecognized: r.unrecognizedCount,
            },
      ),
    };
  }
  console.log(JSON.stringify(output, null, 2));
}

async function cmdExtract({
  'silo-dir': siloDir,
  'from-session': fromSession,
  'dry-run': dryRun,
  'topic-index': topicIndexPath,
  'state-file': stateFilePath,
  'min-tokens': minTokens,
  principal,
  model,
}) {
  if (!fromSession) {
    console.error('silo extract: --from-session <transcript.jsonl> required');
    process.exit(2);
  }

  const writer = await openWriter(siloDir);
  const state = await interpret(writer);

  // Load state file if provided — tracks last-processed line per session file,
  // so repeated runs only extract the delta since last run (mirrors Jarvis's
  // session-extract.js discipline).
  let stateData = { sessions: {}, lastRunAt: null };
  if (stateFilePath) {
    try {
      const raw = await fs.readFile(stateFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stateData = parsed;
      if (!stateData.sessions) stateData.sessions = {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`silo extract: state file unreadable (${err.message}); starting fresh`);
      }
    }
  }

  const sessionKey = basename(fromSession);
  const lastProcessedLine = stateData.sessions[sessionKey]?.lastProcessedLine ?? 0;

  const { messages, totalLines, dialogueTokenEstimate } = await readSessionDelta(fromSession, lastProcessedLine);
  const minTokenThreshold = minTokens ? Number.parseInt(minTokens, 10) : 200;
  if (messages.length === 0 || dialogueTokenEstimate < minTokenThreshold) {
    // Still update state so we don't re-read this portion
    if (stateFilePath) {
      stateData.sessions[sessionKey] = { lastProcessedLine: totalLines, lastRunAt: new Date().toISOString() };
      stateData.lastRunAt = new Date().toISOString();
      await fs.writeFile(stateFilePath, JSON.stringify(stateData, null, 2) + '\n');
    }
    console.log(JSON.stringify({
      skipped: true,
      reason: messages.length === 0 ? 'no dialogue delta' : `below min-tokens (${dialogueTokenEstimate} < ${minTokenThreshold})`,
      session: sessionKey,
      totalLines,
      lastProcessedLine,
      dialogueTokenEstimate,
    }, null, 2));
    return;
  }

  // Build recent-tokens pool from state.topic_content (last 30 days of writes).
  const cutoffTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentTokens = [];
  for (const [, hist] of state.topic_content) {
    for (const h of hist) {
      if (h.ts && h.ts >= cutoffTs) recentTokens.push(tokenize(h.content));
    }
  }

  let topicIndex = '';
  if (topicIndexPath) {
    topicIndex = await fs.readFile(topicIndexPath, 'utf8');
  } else {
    topicIndex = [...state.topic_index.entries()]
      .map(([slug, meta]) => `${slug} | ${meta.topic_type ?? ''} | ${meta.topic_summary ?? ''}`)
      .join('\n');
  }

  const { client: llm, error: llmError } = pickLlmClient({ model });
  if (!llm) {
    if (!model) {
      // No-key case → the rich helper (this is the fresh-install path).
      console.error(noLlmProviderMessage('extract'));
    } else {
      // Explicit --model but the matching provider key is missing.
      console.error(`silo extract: ${llmError}`);
    }
    process.exit(2);
  }

  const result = await distill({ messages, topicIndex, recentTokens, llm });

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          session_file: fromSession,
          total_lines: totalLines,
          dialogue_token_estimate: dialogueTokenEstimate,
          candidates: result.candidates,
          deduped: result.deduped,
          entries: result.entries,
          raw_llm_response: result.rawResponse,
          usage: result.usage,
        },
        null,
        2,
      ),
    );
    return;
  }

  let written = 0;
  for (const entry of result.entries) {
    await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal,
      payload: {
        slug: entry.slug,
        tag: entry.tag,
        content: entry.content,
        confidence: entry.confidence,
        auto_extracted: true,
        source: 'session-extract',
      },
    });
    written += 1;
  }

  // Persist state so the next run only sees new lines.
  if (stateFilePath) {
    stateData.sessions[sessionKey] = {
      lastProcessedLine: totalLines,
      lastRunAt: new Date().toISOString(),
    };
    stateData.lastRunAt = new Date().toISOString();
    await fs.writeFile(stateFilePath, JSON.stringify(stateData, null, 2) + '\n');
  }

  console.log(
    JSON.stringify(
      {
        session_file: fromSession,
        session_key: sessionKey,
        candidates: result.candidates,
        deduped: result.deduped,
        written,
        lines_processed: totalLines - lastProcessedLine,
        last_processed_line: totalLines,
        usage: result.usage,
      },
      null,
      2,
    ),
  );
}

/**
 * Bootstrap a single accepted-but-empty topic. Reads the suggestion's
 * supporting_seqs (which live under `general`) and emits Layer 2 bullets
 * via the LLM. Phase 2.2 §10.
 *
 * Idempotent: subsequent runs find ≥1 active CURATED bullet and skip
 * (isBootstrapEligible returns false).
 *
 * @returns {Promise<Object>} summary record
 */
async function runBootstrapCurate({ slug, state, writer, llm, dryRun, principal }) {
  const meta = state.topic_index.get(slug);
  const suggestionSeq = state.accepted_topic_suggestion_by_slug.get(slug);
  const suggestion = state.topic_suggestions.get(suggestionSeq);
  const events = resolveBootstrapEvents(suggestion.supporting_seqs, state);

  if (events.length === 0) {
    return { slug, skipped: true, reason: 'no_resolvable_supporting_events' };
  }

  const { systemPrompt, userPrompt } = buildBootstrapPrompt({
    slug,
    name: suggestion.name,
    summary: meta.topic_summary || suggestion.description,
    type: meta.topic_type,
    tags: Array.isArray(meta.topic_tags) ? meta.topic_tags : [],
    events,
  });

  if (dryRun) {
    return {
      slug,
      events_used: events.length,
      prompt_chars: systemPrompt.length + userPrompt.length,
      dry_run: true,
    };
  }

  const response = await llm.complete(systemPrompt, userPrompt);
  const raw = response?.content ?? '';
  const parsed = parseBootstrapResponse(raw);

  if (parsed === 'NOTHING_TO_ADD') {
    return { slug, skipped: true, reason: 'llm_nothing_to_add' };
  }

  let written = 0;
  for (const bullet of parsed) {
    await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal: principal || 'curator',
      payload: {
        slug,
        tag: 'CURATED',
        content: `- ${bullet}`,
        source: 'silo-curate-bootstrap',
        curated_at: new Date().toISOString(),
      },
    });
    written += 1;
  }
  if (written > 0) {
    await writer.append({
      type: 'TOPIC_CURATED',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal: principal || 'curator',
      payload: {
        topic: slug,
        source: 'silo-curate-bootstrap',
        bullets_added: written,
      },
    });
  }
  return {
    slug,
    events_used: events.length,
    bullets_written: written,
    tokens_used: response?.usage?.total_tokens ?? null,
  };
}

async function cmdCurate({
  'silo-dir': siloDir,
  slug,
  'days-back': daysBack,
  'min-events': minEvents,
  'dry-run': dryRun,
  principal,
  model,
}) {
  const writer = await openWriter(siloDir);
  const state = await interpret(writer);

  const lookbackDays = daysBack ? Number.parseInt(daysBack, 10) : 14;
  const minNewEvents = minEvents ? Number.parseInt(minEvents, 10) : 3;
  const cutoffTs = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const { client: llm, error: llmError } = pickLlmClient({ model });
  if (!llm && !dryRun) {
    if (!model) {
      console.error(noLlmProviderMessage('curate'));
    } else {
      console.error(`silo curate: ${llmError}`);
    }
    process.exit(2);
  }

  const summary = { slugs: 0, bootstrapped: [], curated: [], skipped: [] };

  // ── Phase 2.2 §10: bootstrap pre-loop pass ─────────────────────────────────
  // Topics created via accept_suggestion have no own-slug events. Seed Layer 2
  // from the original `general` evidence (the suggestion's supporting_seqs)
  // before falling through to the normal curate loop. Bootstrap is idempotent:
  // once ≥1 active CURATED bullet exists, eligibility returns false.
  const bootstrapSlugs = [];
  // When a single --slug is requested, only consider that one; otherwise scan.
  const slugsToCheck = slug ? [slug] : [...state.topic_index.keys()];
  for (const s of slugsToCheck) {
    if (isBootstrapEligible(s, state)) bootstrapSlugs.push(s);
  }
  for (const bootSlug of bootstrapSlugs) {
    const r = await runBootstrapCurate({
      slug: bootSlug,
      state,
      writer,
      llm,
      dryRun,
      principal,
    });
    summary.bootstrapped.push(r);
  }
  if (bootstrapSlugs.length > 0 && !dryRun) {
    // Re-interpret so the normal curate loop below sees the just-written
    // CURATED bullets (and skips the now-bootstrapped slugs because their
    // recent-event count is unchanged but they no longer match eligibility).
    Object.assign(state, await interpret(writer));
  }

  // Determine target slugs: explicit single, or all curated topics with recent activity.
  const targetSlugs = slug ? [slug] : [];
  if (!slug) {
    for (const [s, meta] of state.topic_index.entries()) {
      if (!meta.topic_type) continue; // only "curated" topics (have TOPIC_METADATA_SET)
      const history = state.topic_content.get(s) ?? [];
      const recent = history.filter((h) => h.ts && h.ts >= cutoffTs);
      if (recent.length >= minNewEvents) targetSlugs.push(s);
    }
  }
  summary.slugs = targetSlugs.length;

  for (const targetSlug of targetSlugs) {
    const meta = state.topic_index.get(targetSlug);
    if (!meta) {
      summary.skipped.push({ slug: targetSlug, reason: 'unknown slug' });
      continue;
    }

    const history = state.topic_content.get(targetSlug) ?? [];
    const recentEvents = history.filter((h) => h.ts && h.ts >= cutoffTs && h.tag !== 'CURATED');
    if (recentEvents.length < minNewEvents) {
      summary.skipped.push({ slug: targetSlug, reason: `only ${recentEvents.length} new events (< ${minNewEvents})` });
      continue;
    }

    // Existing Layer 2 content. Two views:
    //   - ALL list: every CURATED write_event (incl. retired) — used only to
    //     compute the retired_bullets count in the dry-run summary.
    //   - ACTIVE list: non-retired only — used for the prompt, verification,
    //     and verbatim dedup. Dedup against ACTIVE only (not ALL) lets a
    //     bullet retired by a prior curate run be reintroduced verbatim —
    //     no permanent-banlist effect, no UNRETIRE primitive needed.
    //     Phase 2.1 hardening (Gemini Finding 2, ChatGPT Finding 7).
    const curatedEventListAll = history.filter((h) => h.tag === 'CURATED');
    const curatedEventList = curatedEventListAll.filter(
      (h) => !state.retired_curated_seqs.has(h.seq),
    );
    const existingCurated = curatedEventList.map((h) => h.content).join('\n\n');

    // Verification backfill: if any active curated bullet has clear topical
    // overlap with a recent event, the bullet is "still supported" — advance
    // last_verified_seq automatically. Threshold is looser than dedup (0.8)
    // because we're checking topical match, not duplication.
    let verified = false;
    if (curatedEventList.length > 0) {
      const VERIFY_THRESHOLD = 0.35;
      outer: for (const c of curatedEventList) {
        const cTokens = tokenize(c.content);
        if (cTokens.length < 3) continue; // skip very-short bullets — too noisy
        for (const r of recentEvents) {
          if (jaccardSimilarity(cTokens, tokenize(r.content)) >= VERIFY_THRESHOLD) {
            verified = true;
            break outer;
          }
        }
      }
    }

    const eventsBlob = recentEvents
      .slice(-50) // cap to last 50 events to control token cost
      .map((h) => `[${h.ts.slice(0, 10)}] [${h.tag || 'EVENT'}] ${h.content}`)
      .join('\n');

    // Number active bullets so the LLM can refer to them by index for retirement.
    const numberedBullets = curatedEventList
      .map((h, i) => `[${i + 1}] ${h.content}`)
      .join('\n');

    const systemPrompt = `You are a memory curator for the Silo memory system. Given a topic's recent event log and its current Layer 2 (curated) bullets, decide:
1. Which existing bullets (if any) are CONTRADICTED or INVALIDATED by recent events and should be RETIRED.
2. What NEW curated bullets should be added.

INCLUDE (for new bullets):
- Architecture / deployment / infrastructure decisions
- Algorithm choices and their constraints
- Security fixes — specifics: which vulnerability, which surface (NOT "security audit X→Y")
- Data model invariants, constraints, migrations
- Dropped/abandoned features with rationale
- Integrations + auth models
- Bug fixes that reveal hidden assumptions
- Design-language decisions (e.g. "adopted Pipedrive-style Kanban") — capture the choice, not the iteration

EXCLUDE:
- Low-information UI iteration: sequential tweaks to color, padding, dividers, shadows, spacing
- Status updates already reflected in actions
- Restating existing curated content

RETIRE only when an existing bullet is clearly wrong NOW (e.g., a port number that changed, a decision that was reversed, an integration that was abandoned). Do NOT retire bullets just because they are old — verification handles freshness automatically.

ANTI-BUNDLING: when multiple distinct decisions exist (e.g. a security audit covering 4 separate vulnerabilities), write one bullet per decision. Don't compress them into a single "audit X→Y" entry.

Output rules:
- Optional retirements first, one per line: "RETIRE: <number>"   (number references the [N] index of an existing bullet)
- Optional single "REASON: <text>" line after retirements (≤ 120 chars)
- Then new bullets, one per line, each starting with "- "
- Each bullet ≤ 200 chars, single line, fact/decision/state form
- English only
- If nothing retires AND nothing new, output exactly: NOTHING_TO_ADD

Topic: ${targetSlug}${meta.topic_type ? ` (type: ${meta.topic_type})` : ''}${meta.topic_summary ? `\nSummary: ${meta.topic_summary.replace(/\n/g, ' ')}` : ''}`;

    const userPrompt = `Existing Layer 2 bullets (numbered for reference):
${numberedBullets || '(empty)'}

Recent events (last ${lookbackDays}d, sorted oldest→newest):
${eventsBlob}

Output retirements (if any) then new bullets, per the rules above.`;

    if (dryRun) {
      summary.curated.push({
        slug: targetSlug,
        recent_events: recentEvents.length,
        existing_curated_chars: existingCurated.length,
        active_bullets: curatedEventList.length,
        retired_bullets: curatedEventListAll.length - curatedEventList.length,
        prompt_chars: systemPrompt.length + userPrompt.length,
        bullets: [],
        verified_would_emit: verified,
        retired_would_emit: null, // dry-run skips LLM; cannot enumerate retirements
        dry_run: true,
      });
      continue;
    }

    // Verification backfill (independent of LLM): if a curated bullet matches
    // a recent event, mark the topic as verified now.
    if (verified) {
      await writer.append({
        type: 'TOPIC_VERIFIED',
        isStateBearing: true,
        intentId: `intent:${uuidv7()}`,
        principal: principal || 'curator',
        payload: { topic: targetSlug, source: 'silo-curate' },
      });
    }

    const response = await llm.complete(systemPrompt, userPrompt);
    const raw = response?.content?.trim() ?? '';

    if (!raw || raw === 'NOTHING_TO_ADD') {
      summary.skipped.push({ slug: targetSlug, reason: 'LLM: NOTHING_TO_ADD' });
      continue;
    }

    // Parse output: RETIRE lines, optional REASON line, then bullet lines.
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const retireNumbers = [];
    let retireReason = null;
    const bulletLines = [];
    for (const line of lines) {
      const retireMatch = line.match(/^RETIRE:\s*(\d+)\s*$/i);
      if (retireMatch) {
        const n = Number.parseInt(retireMatch[1], 10);
        if (n >= 1 && n <= curatedEventList.length) retireNumbers.push(n);
        continue;
      }
      const reasonMatch = line.match(/^REASON:\s*(.*)$/i);
      if (reasonMatch && retireReason === null) {
        const r = reasonMatch[1].trim();
        if (r && r.length <= 120) retireReason = r;
        continue;
      }
      if (line.startsWith('- ')) bulletLines.push(line);
    }

    // Resolve retire indices to seqs, dedup, sort ascending for canonical hash stability.
    const supersededSeqs = [
      ...new Set(retireNumbers.map((n) => curatedEventList[n - 1].seq)),
    ].sort((a, b) => a - b);

    const bullets = bulletLines
      .map((l) => l.slice(2).trim())
      .filter(Boolean)
      .filter((l) => l.length <= 200);

    if (bullets.length === 0 && supersededSeqs.length === 0) {
      summary.skipped.push({ slug: targetSlug, reason: 'LLM output had no valid retirements or bullets' });
      continue;
    }

    // Emit retirement event first (if any), so projections reflect the
    // cleaned slate alongside any new bullets emitted in this run.
    //
    // §B1 (proposals/retire-primitive.md §4.6): re-validate supersededSeqs
    // against a LOCK-SCOPED fresh active-CURATED set before appending, so a
    // manual `silo retire` that raced this run's pre-lock interpret() can't make
    // curate emit a no-op TOPIC_BULLETS_RETIRED. On the common (no-race) path the
    // payload is byte-identical. NOTE: the tail-safety gate (§4.5) is manual-op
    // ONLY and is deliberately NOT mirrored here — the nightly batch is
    // self-healing and its role is to keep running (§4.6).
    let retired = 0;
    let actuallyRetiredSeqs = []; // R2-Retire-2: carried OUT of the lock for the summary
    if (supersededSeqs.length > 0) {
      await writer.withAppendLock(async ({ writer: w, freshState }) => {
        // Keep only seqs still active-CURATED now; drop already-retired / vanished.
        const stillValid = filterActiveCuratedSeqs(freshState, targetSlug, supersededSeqs);
        if (stillValid.length === 0) return; // nothing left to retire — append NOTHING
        const retirePayload = {
          topic: targetSlug,
          superseded_seqs: stillValid,
          source: 'silo-curate',
        };
        if (retireReason) retirePayload.reason = retireReason;
        await w._appendBatchUnlocked([{
          type: 'TOPIC_BULLETS_RETIRED',
          isStateBearing: true,
          intentId: `intent:${uuidv7()}`,
          principal: principal || 'curator',
          payload: retirePayload,
        }]);
        retired = stillValid.length;
        actuallyRetiredSeqs = stillValid; // what was REALLY written, post-filter
      });
    }

    let written = 0;
    for (const bullet of bullets) {
      // Light dedup: skip if a currently-active curated bullet already
      // contains the bullet verbatim. We check `existingCurated` (the
      // pre-LLM active list) rather than `existingCuratedAll`. This:
      //   (a) prevents reintroducing a bullet that's still active
      //   (b) prevents reintroducing a bullet being retired in THIS run
      //       (which was in the active list at prompt-time, before retire)
      //   (c) ALLOWS reintroducing a bullet retired by a prior curate run,
      //       so retire is recoverable without an UNRETIRE primitive.
      // Phase 2.1 hardening — Gemini Finding 2, ChatGPT Finding 7.
      if (existingCurated.includes(bullet)) continue;
      await writer.append({
        type: 'write_event',
        isStateBearing: true,
        intentId: `intent:${uuidv7()}`,
        principal: principal || 'curator',
        payload: {
          slug: targetSlug,
          tag: 'CURATED',
          content: `- ${bullet}`,
          source: 'silo-curate',
          curated_at: new Date().toISOString(),
        },
      });
      written += 1;
    }

    // Update last_curated marker if curate did anything (write OR retire).
    if (written > 0 || retired > 0) {
      await writer.append({
        type: 'TOPIC_CURATED',
        isStateBearing: true,
        intentId: `intent:${uuidv7()}`,
        principal: principal || 'curator',
        payload: {
          topic: targetSlug,
          source: 'silo-curate',
          bullets_added: written,
          bullets_retired: retired,
        },
      });
    }

    summary.curated.push({
      slug: targetSlug,
      recent_events: recentEvents.length,
      bullets_proposed: bullets.length,
      bullets_written: written,
      bullets_retired: retired,
      retired_seqs: actuallyRetiredSeqs,
      retire_reason: retireReason,
      verified,
      tokens_used: response?.usage?.total_tokens ?? null,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

// ── silo suggest — Phase 2.2 §12.2 admin subcommand ──────────────────────────

async function cmdSuggest(values) {
  const siloDir = values['silo-dir'];
  const writer = await openWriter(siloDir);

  // Subverb dispatch — exactly one of these must be set.
  const verbs = ['run-now', 'list', 'accept', 'dismiss', 'status', 'bulk-scan'];
  const active = verbs.filter((v) => values[v] !== undefined && values[v] !== false);
  if (active.length === 0) {
    console.error(`silo suggest: one of --${verbs.map((v) => v).join(', --')} required`);
    process.exit(2);
  }
  if (active.length > 1) {
    console.error(`silo suggest: only one subverb allowed (got: ${active.join(', ')})`);
    process.exit(2);
  }
  const verb = active[0];

  switch (verb) {
    case 'run-now':
    case 'bulk-scan': {
      const state = await interpret(writer);
      const { client: llm, error: llmError } = pickLlmClient({ model: values.model });
      if (!llm && !values['dry-run']) {
        console.error(`silo suggest: ${llmError} (or use --dry-run)`);
        process.exit(2);
      }
      const result = await detectTopicClusters({
        writer,
        state,
        llm: llm ?? { complete: async () => ({ content: '' }) },
        bulkScan: verb === 'bulk-scan',
        runId: values['run-id'],
        dryRun: !!values['dry-run'],
        options: {
          scan_slugs: values['scan-slugs']
            ? values['scan-slugs'].split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
          days_back: values['days-back']
            ? Number.parseInt(values['days-back'], 10)
            : verb === 'bulk-scan' ? 180 : undefined,
          principal: values.principal,
        },
      });
      console.log(JSON.stringify(result, null, 2));
      // Regenerate if anything landed and not a dry-run.
      if (!values['dry-run'] && result.suggested?.length) {
        const target = values.to;
        if (target) {
          const freshState = await interpret(writer);
          await regenerateProjections({ logReader: writer, state: freshState, targetDir: target });
        }
      }
      break;
    }
    case 'list': {
      const state = await interpret(writer);
      const pending = [...state.pending_topic_suggestion_seqs]
        .map((seq) => state.topic_suggestions.get(seq))
        .filter(Boolean)
        .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
      if (values.json) {
        console.log(JSON.stringify(pending, null, 2));
      } else {
        if (pending.length === 0) {
          console.log('(no pending suggestions)');
        } else {
          for (const s of pending) {
            console.log(`[seq ${s.seq}] ${s.slug} — ${s.name}`);
            console.log(`  description: ${s.description}`);
            console.log(`  supporting_seqs: ${s.supporting_seqs.join(', ')}`);
            console.log(`  rationale: ${s.rationale}`);
            console.log(`  proposed_at: ${s.ts}`);
            console.log('');
          }
        }
      }
      break;
    }
    case 'accept': {
      const seq = Number.parseInt(values.accept, 10);
      if (!Number.isSafeInteger(seq) || seq < 1) {
        console.error('silo suggest --accept: <seq> must be a positive integer');
        process.exit(2);
      }
      const tags = values.tags
        ? values.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;
      try {
        const result = await acceptSuggestion(writer, {
          suggestion_seq: seq,
          slug: values.slug,
          description: values.description,
          type: values.type,
          tags,
          principal: values.principal,
        });
        console.log(JSON.stringify(result, null, 2));
        if (values.to) {
          const freshState = await interpret(writer);
          await regenerateProjections({ logReader: writer, state: freshState, targetDir: values.to });
        }
      } catch (err) {
        if (err instanceof SuggestionOpError) {
          console.error(`silo suggest --accept: ${err.code} — ${err.message}`);
          if (err.detail) console.error(JSON.stringify(err.detail, null, 2));
          process.exit(1);
        }
        throw err;
      }
      break;
    }
    case 'dismiss': {
      const seqList = String(values.dismiss)
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isSafeInteger(n) && n >= 1);
      if (seqList.length === 0) {
        console.error('silo suggest --dismiss: <seq>[,<seq>...] required');
        process.exit(2);
      }
      try {
        const result = await dismissSuggestions(writer, {
          suggestion_seqs: seqList,
          cooldown_days: values['cooldown-days']
            ? Number.parseInt(values['cooldown-days'], 10)
            : undefined,
          reason: values.reason,
          principal: values.principal,
        });
        console.log(JSON.stringify(result, null, 2));
        if (values.to) {
          const freshState = await interpret(writer);
          await regenerateProjections({ logReader: writer, state: freshState, targetDir: values.to });
        }
      } catch (err) {
        if (err instanceof SuggestionOpError) {
          console.error(`silo suggest --dismiss: ${err.code} — ${err.message}`);
          if (err.detail) console.error(JSON.stringify(err.detail, null, 2));
          process.exit(1);
        }
        throw err;
      }
      break;
    }
    case 'status': {
      const state = await interpret(writer);
      const now = Date.now();
      const activeCooldowns = [...state.cooldowns_by_normalized_slug.entries()]
        .filter(([, rec]) => isCooldownActive(rec, now))
        .map(([normSlug, rec]) => ({
          normalized_slug: normSlug,
          until_ts: new Date(rec.until_ts).toISOString(),
          source_dismissal_seq: rec.source_dismissal_seq,
        }));
      const summary = {
        pending: state.pending_topic_suggestion_seqs.size,
        accepted: [...state.topic_suggestions.values()].filter((s) => s.status === 'accepted').length,
        dismissed: [...state.topic_suggestions.values()].filter((s) => s.status === 'dismissed').length,
        active_cooldowns: activeCooldowns,
      };
      console.log(JSON.stringify(summary, null, 2));
      break;
    }
    default:
      // unreachable due to active.length === 1 check
      throw new Error('unreachable');
  }
}

// ── silo retire — proposals/retire-primitive.md (v0.2.2) ─────────────────────

const SEQ_TOKEN_RE = /^[1-9]\d*$/; // positive integer; no leading zero/sign/decimal/suffix

async function cmdRetire(values) {
  // Required-flag guards (changelog #5 NIT) — a missing flag must produce a
  // clear usage error, NOT fall through the token parser (which would render
  // `undefined` and emit a confusing "--seq value \"undefined\" is not a
  // positive integer"). `values.seq` is undefined when absent (multiple:true).
  if (!values.slug) {
    console.error('silo retire: --slug is required');
    process.exit(2);
  }
  if (!values.seq) {
    console.error('silo retire: --seq is required (one or more positive integers, e.g. --seq 5 or --seq 5,9)');
    process.exit(2);
  }

  // Strict --seq parse (R2-Retire-1): tokenize repeats + comma-lists, require
  // ^[1-9]\d*$ BEFORE numeric conversion. Do NOT use Number.parseInt (it
  // silently coerces "12abc"->12, "1.5"->1). Retire is projection-destructive:
  // a fat-finger must be a usage error, not a wrong retire.
  const rawTokens = (Array.isArray(values.seq) ? values.seq : [values.seq])
    .flatMap((s) => String(s).split(','))
    .map((t) => t.trim());
  const seqs = [];
  for (const tok of rawTokens) {
    if (!SEQ_TOKEN_RE.test(tok)) {
      console.error(`silo retire: --seq value "${tok}" is not a positive integer`);
      process.exit(2);
    }
    const n = Number(tok);
    if (!Number.isSafeInteger(n)) {
      console.error(`silo retire: --seq value "${tok}" exceeds the safe-integer range`);
      process.exit(2);
    }
    seqs.push(n);
  }

  const writer = await openWriter(values['silo-dir']);
  try {
    const result = await retireBullet(writer, {
      slug: values.slug,
      seqs,
      reason: values.reason,
      principal: values.principal,
    });
    console.log(JSON.stringify(result, null, 2));
    if (values.to) {
      const freshState = await interpret(writer);
      await regenerateProjections({ logReader: writer, state: freshState, targetDir: values.to });
    }
  } catch (err) {
    if (err instanceof RetireOpError) {
      // The stderr token `silo retire: <CODE> — <message>` is load-bearing:
      // the MCP layer regex-extracts <CODE> from it (mirrors suggest).
      console.error(`silo retire: ${err.code} — ${err.message}`);
      if (err.detail) console.error(JSON.stringify(err.detail, null, 2));
      process.exit(1);
    }
    throw err;
  }
}

// ── silo doctor — Phase 2.3 §4 ───────────────────────────────────────────────

async function cmdDoctor(values) {
  const siloDir = values['silo-dir'];
  const checkUpdates = !!values['check-updates'];
  const force = !!values.force;
  const optedOut = isUpdateOptOut();

  console.log(`Silo v${SILO_VERSION}`);
  console.log('');

  // ── LLM provider config (Phase 2.3 §4 + fresh-install UX) ───────────────
  const llmCfg = describeLlmConfig();
  if (!llmCfg) {
    console.log('LLM provider: none configured.');
    console.log('  `silo extract` / `silo curate` will fail without a key set.');
    console.log('  Recommended: ANTHROPIC_API_KEY (claude-sonnet-4-6) or');
    console.log('               OPENAI_API_KEY (gpt-5.4). See README "Prerequisites".');
  } else {
    const detected = [];
    if (llmCfg.anthropicSet) detected.push('ANTHROPIC_API_KEY');
    if (llmCfg.openaiSet) detected.push('OPENAI_API_KEY');
    console.log(`LLM provider: ${llmCfg.providerName} (default model: ${llmCfg.defaultModel})`);
    console.log(`  Keys detected: ${detected.join(', ')}`);
    if (llmCfg.anthropicSet && llmCfg.openaiSet) {
      console.log('  Both providers set; Anthropic is preferred when --model is omitted.');
    }
  }
  console.log('');

  if (checkUpdates) {
    if (optedOut && !force) {
      console.log('Update check skipped — SILO_DISABLE_UPDATE_CHECK is set.');
      console.log('Pass --force to override and run the check anyway.');
      console.log('');
    } else {
      console.log('Forcing fresh update check...');
      try {
        const prior = await readUpdateCache(siloDir);
        const status = await performCheck({ prior });
        await writeUpdateCache(siloDir, status);
        console.log(`  Status: ${status.last_check_status}`);
        if (status.last_check_status === 'ok') {
          console.log(`  Latest available: v${status.latest_version}`);
          if (status.update_available) {
            console.log(`  → Upgrade: run \`git pull && npm install\` in this repo's clone`);
          } else {
            console.log('  No upgrade needed.');
          }
        } else {
          console.log(`  Last error: ${status.last_error}`);
          console.log(`  Consecutive failures: ${status.consecutive_failures}`);
        }
        console.log('');
      } catch (err) {
        console.log(`  Check failed: ${err.message}`);
        console.log('');
      }
    }
  }

  // Cached status report — always shown, even when checks are disabled.
  const cache = await readUpdateCache(siloDir);
  if (optedOut) {
    console.log('Update checks are disabled (SILO_DISABLE_UPDATE_CHECK is set).');
  }
  if (cache) {
    console.log(`Update check: last ran ${formatTs(cache.last_checked_at)}`);
    console.log(`  Status: ${cache.last_check_status}` + (cache.last_error ? ` (${cache.last_error})` : ''));
    if (cache.last_check_status === 'ok') {
      console.log(`  Latest available: v${cache.latest_version}${cache.released_at ? ` (released ${cache.released_at.slice(0, 10)})` : ''}`);
      if (cache.update_available) {
        console.log('  Upgrade: run `git pull && npm install` in this repo\'s clone');
      } else {
        console.log('  No upgrade needed.');
      }
    } else {
      console.log(`  Consecutive failures: ${cache.consecutive_failures}`);
      if (cache.last_successful_check_at) {
        console.log(`  Last successful check: ${formatTs(cache.last_successful_check_at)} (saw v${cache.last_successful_latest_version} as latest)`);
      }
      if (cache.consecutive_failures >= HEALTHY_FAILURE_THRESHOLD || cache.last_check_status === 'repo_not_found') {
        console.log('  Retry: run `silo doctor --check-updates` to force a fresh check.');
      }
    }
  } else {
    console.log('Update check: no cache yet.');
    if (!optedOut) {
      console.log('  Next non-doctor command will fire a check automatically (24h throttle).');
    }
  }
  console.log('');

  // Operation log summary + curate health (parsed from the log itself).
  console.log(`Operation log: ${join(siloDir, 'operation-log')}/`);
  let curateStatus = null;
  let chainBreaks = [];
  try {
    const writer = await openWriter(siloDir);
    const tail = writer.tail();
    console.log(`  Last seq: ${tail.seq}`);
    if (tail.seq > 0) {
      const state = await interpret(writer);
      const lastEntry = state.seq_to_event.get(tail.seq);
      if (lastEntry?.ts) console.log(`  Last write: ${formatTs(lastEntry.ts)}`);
      curateStatus = deriveCuratorStatus(state);
      chainBreaks = state.skipped.filter((s) => s.reason === 'hash_chain_break');
    }
  } catch (err) {
    console.log(`  Read failed: ${err.message}`);
  }
  // Surface hash-chain breaks loudly — they mean the log is corrupted or
  // tampered with, and `silo regenerate --strict` will refuse to rebuild
  // projections from it.
  if (chainBreaks.length > 0) {
    console.log(`  ⚠ Hash chain integrity: ${chainBreaks.length} break${chainBreaks.length > 1 ? 's' : ''} detected`);
    for (const b of chainBreaks.slice(0, 3)) {
      console.log(`    seq ${b.seq} in ${b.logFile}:${b.lineNumber} — expected ${b.expected_hash_prev?.slice(0, 12)}…, got ${b.got_hash_prev?.slice(0, 12)}…`);
    }
    if (chainBreaks.length > 3) {
      console.log(`    (… and ${chainBreaks.length - 3} more)`);
    }
    console.log('  Run `silo regenerate --strict` to refuse projecting from a broken log.');
  } else {
    console.log('  Hash chain: ok');
  }
  console.log('');

  // Curate health — surfaces silent cron failures the user would otherwise
  // only see by SSHing to /var/log/silo-curate.log. Parsed from `[FACT]
  // system: silo-curate run ...` events with source=silo-curate, written
  // by scripts/silo-curate.sh on every cron run.
  if (curateStatus) {
    console.log(`Curate status: last ran ${formatTs(curateStatus.last_run_at)}`);
    if (curateStatus.consecutive_failures > 0) {
      console.log(`  Status: failing (${curateStatus.consecutive_failures} consecutive failure${curateStatus.consecutive_failures > 1 ? 's' : ''})`);
      if (curateStatus.last_failure_msg) {
        console.log(`  Last failure: ${curateStatus.last_failure_msg}`);
      }
      if (curateStatus.last_success_at) {
        console.log(`  Last successful curate: ${formatTs(curateStatus.last_success_at)}`);
      } else {
        console.log('  No successful curate yet.');
      }
    } else if (curateStatus.last_success_at) {
      console.log('  Status: ok');
      console.log(`  Last successful curate: ${formatTs(curateStatus.last_success_at)}`);
    } else {
      console.log('  Status: in progress (run started but no complete/failed event yet)');
    }
    console.log('');
  } else {
    console.log('Curate status: no `silo-curate` events in the log yet.');
    console.log('  Cron at 05:00 UTC will populate this once it runs.');
    console.log('');
  }

  // Cache file diagnostics.
  console.log(`Cache file: ${join(siloDir, UPDATE_CACHE_FILENAME)}`);
  console.log(`  Exists: ${cache ? 'yes' : 'no'}`);
  if (cache?.last_checked_at) {
    console.log(`  Last update: ${formatTs(cache.last_checked_at)}`);
  }
}

function formatTs(iso) {
  if (!iso) return '(never)';
  // Display as "YYYY-MM-DD HH:MM UTC" for readability.
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// deriveCuratorStatus moved to src/util/curate-liveness.js (imported above) so
// cmdCurateStatus and the curate-liveness unit tests can reuse it. cmdDoctor
// still renders from it live (curate-liveness §6: doctor stays live-fold-only).

// ── silo curate-status — SPEC-curate-liveness §5.2 ───────────────────────────
// Pre-compute the curate-liveness verdict into curate-status.json. Does NOT run
// curate — it only reads the log and writes the verdict cache. Invoked by BOTH
// cron wrappers via an EXIT trap: detect (04:00) is the out-of-band death
// detector (it stays alive when curate is dead and can't write its own status);
// curate (05:00) is the in-band recovery reflector (clears the light the moment
// a fixed curate succeeds). Writes curate-status.json ONLY — never
// curate-emit.json (that is the read path's cooldown stamp; the file split is
// what dissolves the dual-writer race, §5.5). Must never fail a cron: the trap
// wraps it in `|| true`, and the fresh-silo path (raw=null) writes a valid
// never-succeeded record and exits 0.
async function cmdCurateStatus(values) {
  const siloDir = values['silo-dir'];
  const now = Date.now();
  const writer = await openWriter(siloDir);
  const state = await interpret(writer);
  const raw = deriveCuratorStatus(state);        // null when no curate events
  const prior = await readCurateStatus(siloDir); // malformed-prior → null (self-heals)
  const next = foldLiveness({ raw, prior, now });
  await writeCurateStatus(siloDir, next);
  // One operator-readable line for the cron log (>> /var/log/silo-*.log).
  console.log(
    `curate-status: is_stale=${next.is_stale} in_progress=${next.in_progress} ` +
      `last_success=${next.last_success_at ?? '(never)'} computed_at=${next.computed_at}`,
  );
}

async function cmdRegenerate({ 'silo-dir': siloDir, to, strict }) {
  if (!to) {
    console.error('silo regenerate: --to <target-dir> required (e.g., /root/clawd-v3)');
    process.exit(2);
  }
  const writer = await openWriter(siloDir);
  const state = await interpret(writer);

  // --strict refuses to project from a log with hash-chain breaks or
  // shape-malformed entries. Use after `silo doctor` flags integrity
  // problems — projection from a corrupt log would propagate the
  // corruption into Zone B (topic files + event logs).
  if (strict) {
    const integrityIssues = state.skipped.filter(
      (s) => s.reason === 'hash_chain_break' || s.reason === 'malformed_entry_shape',
    );
    if (integrityIssues.length > 0) {
      console.error(`silo regenerate --strict: log integrity issues detected — refusing to project.`);
      console.error(`  ${integrityIssues.length} skipped entries (chain breaks or shape errors).`);
      for (const issue of integrityIssues.slice(0, 5)) {
        console.error(`    seq ${issue.seq} (${issue.reason}) at ${issue.logFile}:${issue.lineNumber}`);
      }
      if (integrityIssues.length > 5) {
        console.error(`    (… and ${integrityIssues.length - 5} more)`);
      }
      console.error('  Investigate the log directly or restore from backup. `silo doctor` shows details.');
      process.exit(1);
    }
  }

  const result = await regenerateProjections({ logReader: writer, state, targetDir: to });
  console.log(JSON.stringify(result, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [, , command, ...rest] = process.argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    process.exit(0);
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`Silo v${SILO_VERSION}`);
    process.exit(0);
  }

  // Normalize: `search <query>` lets query be positional.
  let argv = rest;
  let positionalQuery = null;
  if (command === 'search') {
    // Treat first non-flag arg as query
    const nonFlagIdx = argv.findIndex((a) => !a.startsWith('--'));
    if (nonFlagIdx >= 0) {
      positionalQuery = argv[nonFlagIdx];
      argv = [...argv.slice(0, nonFlagIdx), ...argv.slice(nonFlagIdx + 1)];
    }
  }

  const options = {
    ...GLOBAL_OPTIONS,
    slug: { type: 'string' },
    tag: { type: 'string' },
    content: { type: 'string' },
    confidence: { type: 'string' },
    source: { type: 'string' },
    operator: { type: 'string' },
    uid: { type: 'string' },
    query: { type: 'string' },
    mode: { type: 'string', default: 'context_retrieval' },
    flags: { type: 'string' },
    limit: { type: 'string' },
    n: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    'from-session': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'topic-index': { type: 'string' },
    'state-file': { type: 'string' },
    'min-tokens': { type: 'string' },
    'days-back': { type: 'string' },
    'min-events': { type: 'string' },
    model: { type: 'string' },
    // ── Phase 2.2 `silo suggest` flags ────────────────────────────────────
    'run-now': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    accept: { type: 'string' },
    dismiss: { type: 'string' },
    status: { type: 'boolean', default: false }, // `silo suggest --status` diagnostic verb. TOPIC_METADATA_SET status defaults to 'active'; no CLI override (mirrors MCP accept_suggestion which also doesn't expose it).
    'bulk-scan': { type: 'boolean', default: false },
    'cooldown-days': { type: 'string' },
    reason: { type: 'string' },
    // `silo retire` — repeatable + comma-list seq(s). multiple:true → array.
    seq: { type: 'string', multiple: true },
    json: { type: 'boolean', default: false },
    name: { type: 'string' },
    description: { type: 'string' },
    type: { type: 'string' },
    tags: { type: 'string' },
    'scan-slugs': { type: 'string' },
    'run-id': { type: 'string' },
    // Phase 2.3 doctor flags
    'check-updates': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    // Audit follow-up: `silo regenerate --strict` refuses to project from a
    // log with hash-chain breaks or malformed entries.
    strict: { type: 'boolean', default: false },
  };
  const { values } = parseArgs({ args: argv, options, strict: false, allowPositionals: true });

  if (positionalQuery && !values.query) values.query = positionalQuery;

  // Phase 2.3 §4.3: every CLI command except `silo doctor` fires a detached
  // update-check worker on entry. Spawn is non-blocking — survives this
  // process exiting in <100ms. Respects opt-out + 24h throttle internally.
  // curate-status is excluded too — it's a cron-frequency call and must stay
  // side-effect-free (no detached update-check worker on every nightly run).
  if (
    command !== 'doctor' &&
    command !== 'help' &&
    command !== 'init' &&
    command !== 'curate-status'
  ) {
    try {
      await maybeFireUpdateCheck(values['silo-dir']);
    } catch {
      // Update check is best-effort; never block the real command.
    }
  }

  try {
    switch (command) {
      case 'init':
        await cmdInit(values);
        break;
      case 'status':
        await cmdStatus(values);
        break;
      case 'write':
        await cmdWrite(values);
        break;
      case 'read':
        await cmdRead(values);
        break;
      case 'search':
        await cmdSearch(values);
        break;
      case 'import-jarvis':
        await cmdImportJarvis(values);
        break;
      case 'extract':
        await cmdExtract(values);
        break;
      case 'curate':
        await cmdCurate(values);
        break;
      case 'retire':
        await cmdRetire(values);
        break;
      case 'regenerate':
        await cmdRegenerate(values);
        break;
      case 'suggest':
        await cmdSuggest(values);
        break;
      case 'doctor':
        await cmdDoctor(values);
        break;
      case 'curate-status':
        await cmdCurateStatus(values);
        break;
      default:
        console.error(`silo: unknown command "${command}"`);
        printHelp();
        process.exit(2);
    }
  } catch (err) {
    if (looksLikeLlmError(err)) {
      // LLM call failed (after retries, if applicable). Surface the
      // classified hint instead of the raw provider message.
      console.error(formatLlmErrorForCli(err, command));
    } else if (err?.name === 'AdmissionError') {
      // M3 admission gate refused the write. Print a parseable token
      // (`ADMISSION_REFUSED:<code>`) so MCP and log consumers can
      // pattern-match the structured code without parsing free-text.
      // See proposals/m3-admission-gate.md §5.1.
      const details = err.details ? ` ${JSON.stringify(err.details)}` : '';
      console.error(`silo ${command}: ADMISSION_REFUSED:${err.code} —${details}`);
    } else {
      console.error(`silo ${command}: ${err.message}`);
    }
    if (process.env.SILO_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`Silo v${SILO_VERSION}

usage: silo <command> [options]

commands:
  init        initialize a fresh silo
  status      show current broker state
  write       append a write_event to the log [--source=<s>]
  read        print history of a topic
  search      retrieve matching topics (exact | context | orient)
  extract     distill memory entries from a session transcript
  curate      promote events to Layer 2 (auto-bootstraps accepted suggestions)
  retire      retire active Layer-2 (CURATED) bullet(s) by seq, one topic.
              --slug=<s> --seq=<n>[,<n>...] [--reason=<txt>] [--to=<path>]
              WARNING: retires the ENTIRE write_event at each seq. For
              import-origin writes that is a whole "## Heading" section,
              not a single line. No un-retire — restore by re-curating.
  suggest     topic-proposal admin: --run-now | --list | --accept <seq>
              --dismiss <seq> | --status | --bulk-scan
  doctor      diagnostic readout; --check-updates forces a fresh GitHub check
              (honors SILO_DISABLE_UPDATE_CHECK; --force overrides)
  curate-status
              refresh the curate-liveness cache (curate-status.json) from the
              log; run by the curate + detect crons. Powers the passive
              _silo_notices "curation is stale" check-engine light.
  regenerate  rebuild Zone B projections (topic files, event logs,
              TOPIC-INDEX.md, PENDING-SUGGESTIONS.json) from the log.
              --strict refuses to project from a log with chain breaks.

global options:
  --silo-dir=<path>    silo data directory (default: .silo)
  --principal=<name>   requesting principal (default: operator)

examples:
  silo init --silo-dir=./data --operator=helder --uid=1000
  silo write --slug=project-alpha --tag=FACT --content="chose supplier X"
  silo read --slug=project-alpha
  silo search "supplier" --mode=context
  silo search "project-alpha" --mode=exact --flags=full_context
  silo search --mode=orient --n=20
  silo extract --from-session /path/session.jsonl --dry-run
  silo extract --from-session /path/session.jsonl --model=gpt-4o
  silo status
`);
}

main();
