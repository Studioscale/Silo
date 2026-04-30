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

/**
 * Atomic write: write to <path>.tmp then rename over <path>.
 */
async function atomicWrite(path, content) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, content, 'utf8');
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

  return {
    topics: topicFiles.size,
    event_logs: eventLogs.size,
    target: targetDir,
  };
}

// Re-exports for granular use
export { regenerateTopicFile, regenerateAllTopicFiles } from './regenerate-topic-file.js';
export { regenerateTopicIndex } from './regenerate-topic-index.js';
export { regenerateEventLogForDate, regenerateAllEventLogs } from './regenerate-event-log.js';
