/**
 * Notices module — Phase 2.2 §7.4 + Phase 2.3 §5.
 *
 * Builds the `_silo_notices` array that gets injected into MCP read-tool
 * responses (read_index, search, list_handoffs). Each notice carries a
 * `kind` discriminator; the consumer LLM decides whether/when to surface
 * each one to the user.
 *
 * Kinds covered here:
 *   - pending_topic_suggestions   (Phase 2.2)
 *   - update_available            (Phase 2.3 — wired in step §15.X)
 *   - update_check_unhealthy      (Phase 2.3 — wired in step §15.X)
 *
 * mtime-cached file reads mirror the existing loadTopicIndex() pattern in
 * server.js. The cache is process-local and tiny — server.js is stateless
 * per request anyway.
 *
 * Pure-fs only — no MCP SDK / express imports — so the silo workspace's
 * own test runner can exercise the module without needing silo-mcp/'s
 * node_modules installed locally.
 */

import { readFile, stat } from 'node:fs/promises';

let pendingCache = { mtime: null, envelope: null };

/** Test seam — reset the in-memory cache between assertions. */
export function _resetPendingCache() {
  pendingCache = { mtime: null, envelope: null };
}

/**
 * Read PENDING-SUGGESTIONS.json with mtime caching.
 * Missing file → null (no notice). Malformed → null + stderr warning.
 *
 * @param {string} pendingPath - absolute path to PENDING-SUGGESTIONS.json
 * @returns {Promise<Object|null>}
 */
export async function loadPendingSuggestions(pendingPath) {
  try {
    const st = await stat(pendingPath);
    if (pendingCache.mtime === st.mtimeMs) return pendingCache.envelope;
    const raw = await readFile(pendingPath, 'utf8');
    const envelope = JSON.parse(raw);
    pendingCache = { mtime: st.mtimeMs, envelope };
    return envelope;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn(
      `silo-mcp: failed to load PENDING-SUGGESTIONS.json (${pendingPath}): ${err.message}`,
    );
    return null;
  }
}

/**
 * Build the _silo_notices array. Returns the array when at least one
 * notice applies, or null when empty (field is omitted entirely from
 * the response per spec §7.4 — preserves backward compat).
 *
 * @param {Object} opts
 * @param {string} opts.pendingPath - path to PENDING-SUGGESTIONS.json
 * @param {Object} [opts.updateStatus] - Phase 2.3: parsed update-status.json
 *                  When provided, may add `update_available` or
 *                  `update_check_unhealthy` notices. Pass undefined to skip.
 * @param {boolean} [opts.updateCheckDisabled] - Phase 2.3: respect
 *                  SILO_DISABLE_UPDATE_CHECK env var by suppressing
 *                  update-related notices even when updateStatus says so.
 * @returns {Promise<Array<Object>|null>}
 */
export async function buildSiloNotices({ pendingPath, updateStatus, updateCheckDisabled } = {}) {
  const notices = [];

  // ── Phase 2.2: pending_topic_suggestions ────────────────────────────────
  if (pendingPath) {
    const env = await loadPendingSuggestions(pendingPath);
    if (env && env.count > 0) {
      const plural = env.count > 1 ? 's' : '';
      notices.push({
        kind: 'pending_topic_suggestions',
        count: env.count,
        cap_reached: !!env.cap_reached,
        tool: 'list_pending_suggestions',
        message: `Silo has ${env.count} pending topic suggestion${plural}. Available for review when convenient — mention once per session if relevant to the user's current task.`,
        first_pending_age_days: env.oldest_pending_age_days ?? 0,
      });
    }
  }

  // ── Phase 2.3: update notification (wired in step §15.X) ────────────────
  if (updateStatus && !updateCheckDisabled) {
    if (updateStatus.update_available === true) {
      notices.push({
        kind: 'update_available',
        current_version: updateStatus.current_version,
        latest_version: updateStatus.latest_version,
        tag_url: updateStatus.tag_url,
        released_at: updateStatus.released_at,
        message: `Silo ${updateStatus.latest_version} available (current: ${updateStatus.current_version}). Run \`git pull && npm install\` to upgrade.`,
      });
    }
    // Health threshold: 7 consecutive failures, OR immediate 404
    const isUnhealthy =
      (updateStatus.consecutive_failures >= 7) ||
      (updateStatus.last_check_status === 'repo_not_found');
    if (isUnhealthy) {
      const isRepo404 = updateStatus.last_check_status === 'repo_not_found';
      notices.push({
        kind: 'update_check_unhealthy',
        last_error: updateStatus.last_error,
        last_successful_check_at: updateStatus.last_successful_check_at,
        consecutive_failures: updateStatus.consecutive_failures,
        message: isRepo404
          ? 'Silo update check found 404 — repository may have moved. Run `silo doctor` for details.'
          : `Silo update check has failed ${updateStatus.consecutive_failures} consecutive runs. Run \`silo doctor\` for diagnosis.`,
      });
    }
  }

  return notices.length > 0 ? notices : null;
}
