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

import { readFile, stat, writeFile, rename } from 'node:fs/promises';

let pendingCache = { mtime: null, envelope: null };
let updateCache = { mtime: null, status: null };
// Curate-liveness gets its OWN cache vars (#10) — NOT a reuse of updateCache,
// which would cross-pollute update-status and curate-status reads. curateCache
// stores the L1/L2 discriminated envelope (so a cache hit still carries
// mtimeMs); curateEmitCache stores the plain cooldown-stamp object.
let curateCache = { mtime: null, envelope: null };
let curateEmitCache = { mtime: null, status: null };

/** Test seam — reset the in-memory caches between assertions. */
export function _resetPendingCache() {
  pendingCache = { mtime: null, envelope: null };
}
export function _resetUpdateCache() {
  updateCache = { mtime: null, status: null };
}
export function _resetCurateCache() {
  curateCache = { mtime: null, envelope: null };
}
export function _resetCurateEmitCache() {
  curateEmitCache = { mtime: null, status: null };
}

// ── Opt-out predicate (Phase 2.3 §3.6) ─────────────────────────────────────
// Replicated locally rather than imported from silo/src/util/update-check.js
// because silo-mcp/ is a separate package (own package.json, own node_modules
// on the VPS); cross-package imports would break the install boundary.
// Keep this list in sync with src/util/update-check.js OPT_OUT_VALUES.
const OPT_OUT_VALUES = new Set(['1', 'true', 'yes', 'on']);
export function isUpdateOptOut(env = process.env) {
  const v = env.SILO_DISABLE_UPDATE_CHECK;
  if (v == null) return false;
  return OPT_OUT_VALUES.has(String(v).toLowerCase().trim());
}

// ── Curate-liveness opt-out (SPEC-curate-liveness §5.6) ─────────────────────
// SEPARATE var from SILO_DISABLE_UPDATE_CHECK on purpose: the owner silenced
// update-notices out of fatigue, and reusing that var would ALSO blind them to
// curate death — defeating the whole feature. Same OPT_OUT_VALUES set; same
// cross-package duplication convention as isUpdateOptOut.
export function isCurateLivenessOptOut(env = process.env) {
  const v = env.SILO_DISABLE_CURATE_LIVENESS;
  if (v == null) return false;
  return OPT_OUT_VALUES.has(String(v).toLowerCase().trim());
}

// ── Curate-liveness read-path constants (§5.5 / §5.7 / §5.8) ────────────────
// These gate EMISSION, not the verdict (the verdict's STALE_DAYS/CLEAR_DAYS live
// in src/util/curate-liveness.js). Duplicated across the package boundary like
// OPT_OUT_VALUES — silo-mcp/ is a separate package on the VPS.
const EMIT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // ≈ one working session; 24h is the documented conservative knob
const NEVER_SUCCEEDED_GRACE_MS = 2 * 24 * 60 * 60 * 1000; // fresh deploy gets ~2 nightly attempts before the never-succeeded light
const MONITOR_STALE_MS = 3 * 24 * 60 * 60 * 1000; // = STALE_DAYS; the both-crons-dead freshness guard

/**
 * Read PENDING-SUGGESTIONS.json with mtime caching.
 * Missing file → null (no notice). Malformed → null + stderr warning.
 *
 * @param {string} pendingPath - absolute path to PENDING-SUGGESTIONS.json
 * @returns {Promise<Object|null>}
 */
/**
 * Read update-status.json with mtime caching. Same shape as
 * loadPendingSuggestions — missing/malformed → null.
 *
 * @param {string} updatePath - absolute path to update-status.json
 * @returns {Promise<Object|null>}
 */
export async function loadUpdateStatus(updatePath) {
  try {
    const st = await stat(updatePath);
    if (updateCache.mtime === st.mtimeMs) return updateCache.status;
    const raw = await readFile(updatePath, 'utf8');
    const status = JSON.parse(raw);
    updateCache = { mtime: st.mtimeMs, status };
    return status;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn(
      `silo-mcp: failed to load update-status.json (${updatePath}): ${err.message}`,
    );
    return null;
  }
}

/**
 * Read curate-status.json with mtime caching, returning a DISCRIMINATED
 * ENVELOPE (L1/L2) — deliberately NOT a field-for-field clone of
 * loadUpdateStatus (which surfaces neither mtimeMs nor a corrupt-vs-absent
 * distinction):
 *   { kind: 'ok',      status, mtimeMs }  // parsed fine; mtimeMs from stat()
 *   { kind: 'absent' }                    // ENOENT — genuinely missing
 *   { kind: 'corrupt', mtimeMs? }         // exists but unreadable/unparseable
 *
 * The envelope exists because the both-crons-dead freshness guard
 * (resolveMonitorFreshness) needs the file's mtime WITHOUT a second stat() (L1),
 * and the read path must tell ENOENT (fresh deploy → dark) apart from corrupt
 * (→ a notice) without overloading `undefined` (L2).
 *
 * @param {string} curatePath - absolute path to curate-status.json
 * @returns {Promise<{kind:'ok',status:Object,mtimeMs:number}|{kind:'absent'}|{kind:'corrupt',mtimeMs?:number}>}
 */
export async function loadCurateStatus(curatePath) {
  let st;
  try {
    st = await stat(curatePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'absent' };
    // Non-ENOENT stat failure (perms, etc.) → corrupt, mtime unknown.
    console.warn(
      `silo-mcp: failed to stat curate-status.json (${curatePath}): ${err.message}`,
    );
    return { kind: 'corrupt' };
  }
  if (curateCache.mtime === st.mtimeMs) return curateCache.envelope;

  let envelope;
  try {
    const raw = await readFile(curatePath, 'utf8');
    envelope = { kind: 'ok', status: JSON.parse(raw), mtimeMs: st.mtimeMs };
  } catch (err) {
    // stat() succeeded but read/parse failed → corrupt, mtime best-effort.
    console.warn(
      `silo-mcp: curate-status.json is unreadable/corrupt (${curatePath}): ${err.message}`,
    );
    envelope = { kind: 'corrupt', mtimeMs: st.mtimeMs };
  }
  // Cache the envelope (not the bare status) so a cache hit still carries mtimeMs.
  curateCache = { mtime: st.mtimeMs, envelope };
  return envelope;
}

/**
 * Read curate-emit.json (the per-emit cooldown stamp) with mtime caching.
 * Plain object|null — nothing reads ITS mtime, so no envelope needed.
 *
 * @param {string} emitPath - absolute path to curate-emit.json
 * @returns {Promise<Object|null>}
 */
export async function loadCurateEmit(emitPath) {
  try {
    const st = await stat(emitPath);
    if (curateEmitCache.mtime === st.mtimeMs) return curateEmitCache.status;
    const raw = await readFile(emitPath, 'utf8');
    const status = JSON.parse(raw);
    curateEmitCache = { mtime: st.mtimeMs, status };
    return status;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn(
      `silo-mcp: failed to load curate-emit.json (${emitPath}): ${err.message}`,
    );
    return null;
  }
}

/**
 * Fold the two "the monitor ITSELF is broken" conditions into ONE coherent
 * signal (§5.8): a corrupt status file, or a stale writer (both crons down so
 * nobody refreshes curate-status.json). Consumes the loadCurateStatus envelope
 * — branches on `.kind`, never on `=== undefined` (L2) — and uses the envelope's
 * own mtimeMs (L1) so the staleness check needs no second stat() and no log
 * fold (it works precisely when the cron that WOULD fold is dead).
 *
 * @returns {null | {kind:string, message:string}} null when the monitor is
 *   healthy or not-applicable (ENOENT = fresh deploy, not a monitor issue).
 */
function resolveMonitorFreshness(curateStatus, now) {
  switch (curateStatus.kind) {
    case 'absent': // ENOENT → fresh deploy before first cron; not a monitor issue
      return null;
    case 'corrupt':
      return {
        kind: 'curate_monitor_unreadable',
        message:
          'Silo\'s curate-liveness monitor file is unreadable/corrupt — the liveness check cannot report. Run `silo doctor` (it folds live, independent of this file) and check `<silo-dir>/curate-status.json`.',
      };
    case 'ok': {
      // Freshness anchor: the newer of the file's mtime (L1, from the envelope)
      // and its own computed_at. mtimeMs is always present on an 'ok' envelope.
      const computedMs = Date.parse(curateStatus.status?.computed_at);
      const anchorMs = Math.max(
        curateStatus.mtimeMs ?? -Infinity,
        Number.isFinite(computedMs) ? computedMs : -Infinity,
      );
      if (Number.isFinite(anchorMs) && now - anchorMs > MONITOR_STALE_MS) {
        return {
          kind: 'curate_monitor_stale',
          message:
            'Silo\'s curate-liveness monitor hasn\'t updated in over 3 days — both the curate and detect crons may be down. `silo doctor` is the live backstop; verify both cron entries.',
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Stamp curate-emit.json with `last_emitted_at = now` (atomic unique-tmp +
 * rename, cloned from writeCache). Written ONLY here, by the read path — no cron
 * writer ever touches this file, which is what structurally dissolves the
 * dual-writer race (§5.5). No-ops when no path is supplied (test convenience).
 */
async function stampCurateEmit(emitPath, now) {
  if (!emitPath) return;
  const payload = { schema_version: 1, last_emitted_at: new Date(now).toISOString() };
  const tmp = `${emitPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await rename(tmp, emitPath);
    // Invalidate our own cache so a later read in this process sees the new stamp.
    curateEmitCache = { mtime: null, status: null };
  } catch (err) {
    console.warn(`silo-mcp: failed to stamp curate-emit.json (${emitPath}): ${err.message}`);
  }
}

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
 * @param {Object} [opts.curateStatus] - curate-liveness: the discriminated
 *                  envelope from loadCurateStatus ({kind:'ok'|'absent'|'corrupt'}).
 *                  Omit (undefined) to skip the whole curate block (backward compat).
 * @param {Object|null} [opts.curateEmit] - parsed curate-emit.json (cooldown stamp).
 * @param {boolean} [opts.curateLivenessDisabled] - respect SILO_DISABLE_CURATE_LIVENESS.
 * @param {string} [opts.curateEmitPath] - path to curate-emit.json; written
 *                  (atomic RMW) when a curate notice is emitted.
 * @param {number} [opts.now] - wall-clock ms (test seam) for cooldown/grace/freshness.
 * @returns {Promise<Array<Object>|null>}
 */
export async function buildSiloNotices({
  pendingPath,
  updateStatus,
  updateCheckDisabled,
  curateStatus,
  curateEmit,
  curateLivenessDisabled,
  curateEmitPath,
  now = Date.now(),
} = {}) {
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

  // ── curate-liveness (SPEC-curate-liveness §5.7) ─────────────────────────
  // curateStatus is the discriminated envelope from loadCurateStatus (L1/L2):
  //   { kind:'ok', status, mtimeMs } | { kind:'absent' } | { kind:'corrupt', mtimeMs? }
  // The `curateStatus &&` guard makes an OMITTED arg skip the block entirely
  // (backward compat) — distinct from a corrupt file (L2: we never treat
  // "caller omitted" as "corrupt"). We branch on `.kind`, never on truthiness.
  if (curateStatus && !curateLivenessDisabled) {
    // Shared cooldown gate (curate-emit.json). NaN/missing stamp → DUE (#8): a
    // bad stamp must never silence the light forever.
    const emittedMs =
      curateEmit?.last_emitted_at != null ? Date.parse(curateEmit.last_emitted_at) : NaN;
    const due = !Number.isFinite(emittedMs) || now - emittedMs > EMIT_COOLDOWN_MS;

    // Pick at most ONE curate notice, highest-priority first. The shared
    // cooldown then gates emission, so a read that trips several conditions
    // still surfaces ≤1 curate notice per window (F8 / T33).
    let curateNotice = null;

    // (a) Monitor itself broken (corrupt file OR both crons down) — one coherent
    //     "monitor is broken" signal. Checked first; wins over the curate verdict
    //     because we can't trust a verdict from a stale/corrupt monitor.
    const monitorIssue = resolveMonitorFreshness(curateStatus, now);
    if (monitorIssue) {
      curateNotice = monitorIssue;
    } else if (curateStatus.kind === 'ok') {
      const s = curateStatus.status;

      // (b) Never-succeeded (F4): no success ever, past the grace window.
      const neverSucceeded = s.last_success_at == null;
      const firstMs = Date.parse(s.first_observed_at);
      const pastGrace = Number.isFinite(firstMs) && now - firstMs > NEVER_SUCCEEDED_GRACE_MS;

      if (neverSucceeded && pastGrace) {
        curateNotice = {
          kind: 'curate_never_succeeded',
          first_observed_at: s.first_observed_at,
          last_run_at: s.last_run_at,
          message: s.last_run_at
            ? 'Silo curation has run but has NEVER completed successfully since this silo was first observed. Memory consolidation has never happened — run `silo doctor` and check /var/log/silo-curate.log for the failure.'
            : 'Silo curation has NEVER run on this silo since it was first observed (no heartbeat at all). The silo-curate cron may not be installed, or its script lost its exec bit. Run `silo doctor` and verify the cron + exec bit.',
        };
      } else if (s.is_stale === true) {
        // (c) Stale (the main light): had a success, now too old.
        const days = Math.floor(s.days_since_success ?? 0);
        // Branch order is load-bearing (R2-Live-3): in_progress is derived from
        // last_event_kind ('started'), so a post-failure started-with-no-terminal
        // takes the "started but not completed" branch even though last_failure_msg
        // still carries the stale failure text. Testing last_failure_msg first
        // would mask the in-progress run.
        let message;
        if (s.in_progress) {
          message = `Silo curation started but has not completed in ${days} days — the run may be wedged. Memory consolidation is stalled. Run \`silo doctor\` and check for a hung silo-curate process / stale lock.`;
        } else if (s.last_failure_msg) {
          message = `Silo curation has not succeeded in ${days} days (last run FAILED: ${s.last_failure_msg}). Memory consolidation is stalled — run \`silo doctor\` and check /var/log/silo-curate.log.`;
        } else {
          message = `Silo curation has not run in ${days} days (no heartbeat — the cron may be dead before its first log line). Memory consolidation is stalled — run \`silo doctor\` and verify the silo-curate cron + exec bit.`;
        }
        curateNotice = {
          kind: 'curate_liveness_stale',
          last_success_at: s.last_success_at,
          days_since_success: s.days_since_success,
          consecutive_failures: s.consecutive_failures,
          last_failure_msg: s.last_failure_msg,
          last_event_kind: s.last_event_kind,
          in_progress: s.in_progress,
          message,
        };
      }
    }
    // curateStatus.kind === 'absent' → curateNotice stays null (fresh silo dark).

    if (curateNotice && due) {
      notices.push(curateNotice);
      await stampCurateEmit(curateEmitPath, now);
    }
  }

  return notices.length > 0 ? notices : null;
}
