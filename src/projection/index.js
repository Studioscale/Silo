/**
 * Projection regenerator — v12.5 Zone B.
 *
 * Entry point for regenerating all three projection types:
 *   - Topic files at <root>/topics/<slug>.md
 *   - TOPIC-INDEX.md at <root>/TOPIC-INDEX.md
 *   - Daily event logs at <root>/events/YYYY-MM-DD.md
 *
 * Writes the projections atomically (tmp-file + rename) to the target
 * directory structure. M2.1 scope: full regeneration, not incremental.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { regenerateAllTopicFiles } from './regenerate-topic-file.js';
import { regenerateTopicIndex } from './regenerate-topic-index.js';
import { regenerateAllEventLogs } from './regenerate-event-log.js';
import { buildPendingSuggestionsEnvelope } from './regenerate-pending-suggestions.js';

/**
 * Atomic + durable write — write to a unique tmp path, fsync, rename.
 *
 * Audit follow-ups baked into this function:
 *   - Unique tmp filename (`${pid}.${ts}.tmp`) so two concurrent
 *     regenerators don't trample each other's tmp file before rename.
 *     update-check-worker.js already does this for the same reason.
 *   - fh.sync() before rename so a power loss between writeFile + rename
 *     leaves either nothing or the complete new content (atomicity already
 *     held; durability now does too). Projections are regenerable from
 *     the log so this is low-severity hardening, but cheap.
 *
 * Parent-directory fsync is deliberately skipped — projections live in a
 * predictable dir tree (events/, topics/) that `silo regenerate` recreates
 * idempotently. The dir entry isn't unique enough to be worth the extra
 * fsync; if metadata loss strands the rename, the next regen re-emits.
 */
async function atomicWrite(path, content) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

/**
 * Regenerate all projections into a target directory.
 *
 * @param {Object} args
 * @param {LogWriter} args.logReader - Silo log
 * @param {Object} args.state - interpret() output
 * @param {string} args.targetDir - e.g., '/root/clawd-v3' on the VPS
 * @returns {Promise<{topics: number, event_logs: number, target: string}>}
 */
export async function regenerateProjections({ logReader, state, targetDir }) {
  // 1. Topic files
  const topicFiles = await regenerateAllTopicFiles({ logReader, state });
  for (const [slug, text] of topicFiles) {
    const path = join(targetDir, 'topics', `${slug}.md`);
    await atomicWrite(path, text);
  }

  // 2. TOPIC-INDEX.md
  const indexContent = regenerateTopicIndex(topicFiles);
  await atomicWrite(join(targetDir, 'TOPIC-INDEX.md'), indexContent);

  // 3. Daily event logs
  const eventLogs = await regenerateAllEventLogs(logReader);
  for (const [date, text] of eventLogs) {
    const path = join(targetDir, 'events', `${date}.md`);
    await atomicWrite(path, text);
  }

  // 4. PENDING-SUGGESTIONS.json (Phase 2.2 §6)
  const envelope = buildPendingSuggestionsEnvelope(state);
  await atomicWrite(
    join(targetDir, 'PENDING-SUGGESTIONS.json'),
    JSON.stringify(envelope, null, 2) + '\n',
  );

  return {
    topics: topicFiles.size,
    event_logs: eventLogs.size,
    pending_suggestions: envelope.count,
    target: targetDir,
  };
}

// Re-exports for granular use
export { regenerateTopicFile, regenerateAllTopicFiles } from './regenerate-topic-file.js';
export { regenerateTopicIndex } from './regenerate-topic-index.js';
export { regenerateEventLogForDate, regenerateAllEventLogs } from './regenerate-event-log.js';
export { buildPendingSuggestionsEnvelope } from './regenerate-pending-suggestions.js';
