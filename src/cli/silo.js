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
import { basename } from 'node:path';
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

  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    isStateBearing: true,
    intentId: nextIntentId(),
    principal: 'bootstrap',
    payload: { principal, class: 'human' },
  });
  await writer.append({
    type: 'PRINCIPAL_UID_BOUND',
    isStateBearing: true,
    intentId: nextIntentId(),
    principal: 'bootstrap',
    payload: { principal, uid: uidNum },
  });
  await writer.append({
    type: 'PRINCIPAL_ACCESS_ENABLED',
    isStateBearing: true,
    intentId: nextIntentId(),
    principal: 'bootstrap',
    payload: { principal },
  });

  console.log(`silo: initialized at ${siloDir}`);
  console.log(`  operator = ${principal} (uid ${uidNum})`);
  console.log(`  tail = seq ${writer.tail().seq}`);
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

async function cmdWrite({ 'silo-dir': siloDir, slug, tag, content, principal, confidence }) {
  if (!slug || !content) {
    console.error('silo write: --slug and --content required');
    process.exit(2);
  }
  const writer = await openWriter(siloDir);
  const payload = { slug, tag: tag || 'FACT', content };
  if (confidence) payload.confidence = confidence;
  const result = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: nextIntentId(),
    principal,
    payload,
  });
  console.log(`written: seq ${result.seq} slug=${slug} tag=${tag || 'FACT'}${confidence ? ':' + confidence : ''}`);
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
    console.error(`silo extract: ${llmError} (or inject your own client via API)`);
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
    console.error(`silo curate: ${llmError} (or use --dry-run)`);
    process.exit(2);
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

  const summary = { slugs: targetSlugs.length, curated: [], skipped: [] };

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
    let retired = 0;
    if (supersededSeqs.length > 0) {
      const retirePayload = {
        topic: targetSlug,
        superseded_seqs: supersededSeqs,
        source: 'silo-curate',
      };
      if (retireReason) retirePayload.reason = retireReason;
      await writer.append({
        type: 'TOPIC_BULLETS_RETIRED',
        isStateBearing: true,
        intentId: `intent:${uuidv7()}`,
        principal: principal || 'curator',
        payload: retirePayload,
      });
      retired = supersededSeqs.length;
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
      retired_seqs: supersededSeqs,
      retire_reason: retireReason,
      verified,
      tokens_used: response?.usage?.total_tokens ?? null,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

async function cmdRegenerate({ 'silo-dir': siloDir, to }) {
  if (!to) {
    console.error('silo regenerate: --to <target-dir> required (e.g., /root/clawd-v3)');
    process.exit(2);
  }
  const writer = await openWriter(siloDir);
  const state = await interpret(writer);
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
  };
  const { values } = parseArgs({ args: argv, options, strict: false, allowPositionals: true });

  if (positionalQuery && !values.query) values.query = positionalQuery;

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
      case 'regenerate':
        await cmdRegenerate(values);
        break;
      default:
        console.error(`silo: unknown command "${command}"`);
        printHelp();
        process.exit(2);
    }
  } catch (err) {
    console.error(`silo ${command}: ${err.message}`);
    if (process.env.SILO_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`silo — v12.5 M1

usage: silo <command> [options]

commands:
  init     initialize a fresh silo
  status   show current broker state
  write    append a write_event to the log
  read     print history of a topic
  search   retrieve matching topics (exact | context | orient)
  extract  distill memory entries from a session transcript

global options:
  --silo-dir=<path>    silo data directory (default: .silo)
  --principal=<name>   requesting principal (default: helder)

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
