/**
 * Phase 2.2 §15 step 9 — MCP `_silo_notices` array builder.
 *
 * Tests silo-mcp/notices.js in isolation. The file uses only built-in
 * Node imports so it runs in the silo workspace's test runner without
 * needing silo-mcp/node_modules installed locally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSiloNotices,
  loadPendingSuggestions,
  loadUpdateStatus,
  loadCurateStatus,
  loadCurateEmit,
  isUpdateOptOut,
  isCurateLivenessOptOut,
  _resetPendingCache,
  _resetUpdateCache,
  _resetCurateCache,
  _resetCurateEmitCache,
} from '../silo-mcp/notices.js';

async function writeEnvelope(path, envelope) {
  await fs.writeFile(path, JSON.stringify(envelope, null, 2));
}

function makeEnvelope(overrides = {}) {
  return {
    schema_version: 1,
    generated_at: '2026-05-18T14:32:11Z',
    suggestions: overrides.suggestions ?? [{
      seq: 1602,
      slug: 'pets',
      name: 'Pets',
      description: 'd',
      supporting_seqs: [1, 2, 3],
      rationale: 'r',
      ts: '2026-05-15T10:00:00Z',
      age_days: 3,
    }],
    count: overrides.count ?? 1,
    oldest_pending_age_days: overrides.oldest_pending_age_days ?? 3,
    cap: 10,
    cap_reached: overrides.cap_reached ?? false,
    detector_status: {
      last_run_at: null,
      last_success_at: null,
      consecutive_failures: 0,
      first_run_deferred: false,
    },
  };
}

test('loadPendingSuggestions: missing file → null (no notice will fire)', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const env = await loadPendingSuggestions(join(dir, 'does-not-exist.json'));
  assert.equal(env, null);
});

test('loadPendingSuggestions: malformed JSON → null + stderr warning', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await fs.writeFile(path, '{ this is not valid');
  // Capture console.warn for the duration.
  const original = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const env = await loadPendingSuggestions(path);
    assert.equal(env, null);
    assert.equal(warned, true);
  } finally {
    console.warn = original;
  }
});

test('loadPendingSuggestions: mtime cache returns same object on second call', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope());
  const a = await loadPendingSuggestions(path);
  const b = await loadPendingSuggestions(path);
  assert.equal(a, b); // same object — mtime hit
});

test('buildSiloNotices: count=0 → null (field omitted in caller)', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope({ count: 0, suggestions: [] }));
  const notices = await buildSiloNotices({ pendingPath: path });
  assert.equal(notices, null);
});

test('buildSiloNotices: count=1 → pending_topic_suggestions notice present', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope({ count: 1, oldest_pending_age_days: 3 }));
  const notices = await buildSiloNotices({ pendingPath: path });
  assert.ok(Array.isArray(notices));
  assert.equal(notices.length, 1);
  const n = notices[0];
  assert.equal(n.kind, 'pending_topic_suggestions');
  assert.equal(n.count, 1);
  assert.equal(n.cap_reached, false);
  assert.equal(n.tool, 'list_pending_suggestions');
  assert.equal(n.first_pending_age_days, 3);
  assert.match(n.message, /1 pending topic suggestion\b/);
  // Singular form when count=1.
  assert.doesNotMatch(n.message, /suggestions\b/);
});

test('buildSiloNotices: count>1 → plural in message', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope({ count: 3, oldest_pending_age_days: 5, cap_reached: true }));
  const notices = await buildSiloNotices({ pendingPath: path });
  assert.equal(notices[0].count, 3);
  assert.equal(notices[0].cap_reached, true);
  assert.match(notices[0].message, /3 pending topic suggestions\b/);
});

// ── Phase 2.3 forward compat: update_available + update_check_unhealthy ─────

test('buildSiloNotices: update_available notice appears when updateStatus says so', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope({ count: 0, suggestions: [] }));
  const notices = await buildSiloNotices({
    pendingPath: path,
    updateStatus: {
      update_available: true,
      current_version: '0.1.0-m1',
      latest_version: '0.1.0-m2',
      tag_url: 'https://github.com/Studioscale/Silo/releases/tag/v0.1.0-m2',
      released_at: '2026-05-17T14:00:00Z',
      consecutive_failures: 0,
      last_check_status: 'ok',
    },
  });
  assert.ok(notices);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'update_available');
  assert.equal(notices[0].latest_version, '0.1.0-m2');
});

test('buildSiloNotices: update_check_unhealthy fires at consecutive_failures >= 7', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope({ count: 0, suggestions: [] }));
  const notices = await buildSiloNotices({
    pendingPath: path,
    updateStatus: {
      update_available: false,
      consecutive_failures: 7,
      last_error: 'ETIMEDOUT',
      last_successful_check_at: '2026-05-10T05:00:00Z',
      last_check_status: 'network_error',
    },
  });
  assert.ok(notices);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'update_check_unhealthy');
  assert.equal(notices[0].consecutive_failures, 7);
});

test('buildSiloNotices: update_check_unhealthy fires immediately on repo_not_found 404', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope({ count: 0, suggestions: [] }));
  const notices = await buildSiloNotices({
    pendingPath: path,
    updateStatus: {
      update_available: false,
      consecutive_failures: 1,
      last_check_status: 'repo_not_found',
      last_error: '404',
      last_successful_check_at: '2026-05-10T05:00:00Z',
    },
  });
  assert.ok(notices);
  assert.equal(notices[0].kind, 'update_check_unhealthy');
  assert.match(notices[0].message, /404/);
});

test('buildSiloNotices: updateCheckDisabled suppresses update_* notices even if cache says so', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope({ count: 0, suggestions: [] }));
  const notices = await buildSiloNotices({
    pendingPath: path,
    updateCheckDisabled: true,
    updateStatus: {
      update_available: true,
      consecutive_failures: 7,
      current_version: '0.1.0-m1',
      latest_version: '0.1.0-m2',
    },
  });
  assert.equal(notices, null);
});

// ── loadUpdateStatus + isUpdateOptOut ────────────────────────────────────────

test('loadUpdateStatus: missing file → null', async () => {
  _resetUpdateCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const status = await loadUpdateStatus(join(dir, 'update-status.json'));
  assert.equal(status, null);
});

test('loadUpdateStatus: malformed JSON → null + stderr warning', async () => {
  _resetUpdateCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'update-status.json');
  await fs.writeFile(path, '{ not valid');
  const original = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const status = await loadUpdateStatus(path);
    assert.equal(status, null);
    assert.equal(warned, true);
  } finally {
    console.warn = original;
  }
});

test('loadUpdateStatus: mtime cache returns same object on second call', async () => {
  _resetUpdateCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'update-status.json');
  await fs.writeFile(path, JSON.stringify({ schema_version: 1, latest_version: '0.1.0-m2' }));
  const a = await loadUpdateStatus(path);
  const b = await loadUpdateStatus(path);
  assert.equal(a, b);
});

test('isUpdateOptOut: same predicate as silo-cli (1/true/yes/on case-insensitive)', () => {
  for (const v of ['1', 'TRUE', 'yes', 'On']) {
    assert.equal(isUpdateOptOut({ SILO_DISABLE_UPDATE_CHECK: v }), true);
  }
  assert.equal(isUpdateOptOut({}), false);
  assert.equal(isUpdateOptOut({ SILO_DISABLE_UPDATE_CHECK: '0' }), false);
});

test('buildSiloNotices: pending_topic_suggestions and update_available coexist in array', async () => {
  _resetPendingCache();
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-notice-'));
  const path = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(path, makeEnvelope({ count: 2, oldest_pending_age_days: 1 }));
  const notices = await buildSiloNotices({
    pendingPath: path,
    updateStatus: {
      update_available: true,
      current_version: '0.1.0-m1',
      latest_version: '0.1.0-m2',
      tag_url: 'https://example/v0.1.0-m2',
      released_at: '2026-05-17T14:00:00Z',
      consecutive_failures: 0,
      last_check_status: 'ok',
    },
  });
  assert.ok(notices);
  assert.equal(notices.length, 2);
  const kinds = notices.map((n) => n.kind);
  assert.ok(kinds.includes('pending_topic_suggestions'));
  assert.ok(kinds.includes('update_available'));
});

// ── curate-liveness (SPEC-curate-liveness §5.7/§5.8, T21–T33) ────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-10T12:00:00Z');
const isoAt = (ms) => new Date(ms).toISOString();

// A `status` object as foldLiveness/writeCurateStatus would persist.
function mkStatus(o = {}) {
  return {
    schema_version: 1,
    last_run_at: o.last_run_at ?? null,
    last_success_at: o.last_success_at ?? null,
    consecutive_failures: o.consecutive_failures ?? 0,
    last_failure_msg: o.last_failure_msg ?? null,
    last_event_kind: o.last_event_kind ?? null,
    in_progress: o.in_progress ?? false,
    computed_at: o.computed_at ?? isoAt(NOW),
    days_since_success: o.days_since_success ?? null,
    is_stale: o.is_stale ?? false,
    first_observed_at: o.first_observed_at ?? isoAt(NOW),
  };
}
// 'ok' envelope with a FRESH mtime by default (so resolveMonitorFreshness passes
// and the verdict branches are reachable).
const okEnv = (status, mtimeMs = NOW) => ({ kind: 'ok', status, mtimeMs });

function resetCurate() {
  _resetCurateCache();
  _resetCurateEmitCache();
}
async function tmpDir() {
  return fs.mkdtemp(join(tmpdir(), 'silo-curate-notice-'));
}
const curateKinds = (notices) =>
  (notices ?? []).map((n) => n.kind).filter((k) => k.startsWith('curate_'));

// T21 — is_stale=true, no curate-emit.json (cooldown due) → notice present.
test('T21 buildSiloNotices: is_stale + no emit stamp → curate_liveness_stale present', async () => {
  resetCurate();
  const status = mkStatus({ is_stale: true, last_success_at: isoAt(NOW - 5 * DAY), days_since_success: 5, last_event_kind: 'complete' });
  const notices = await buildSiloNotices({ curateStatus: okEnv(status), curateEmit: null, now: NOW });
  const n = (notices ?? []).find((x) => x.kind === 'curate_liveness_stale');
  assert.ok(n, 'expected curate_liveness_stale');
  assert.equal(n.days_since_success, 5);
  assert.equal(n.consecutive_failures, 0);
});

// T22 — is_stale=true but last_emitted_at within cooldown → suppressed.
test('T22 buildSiloNotices: stamp within cooldown → curate notice suppressed', async () => {
  resetCurate();
  const status = mkStatus({ is_stale: true, last_success_at: isoAt(NOW - 5 * DAY), days_since_success: 5, last_event_kind: 'complete' });
  const notices = await buildSiloNotices({
    curateStatus: okEnv(status),
    curateEmit: { last_emitted_at: isoAt(NOW - 1 * 60 * 60 * 1000) }, // 1h ago < 6h
    now: NOW,
  });
  assert.equal(notices, null);
});

// T23 — last_emitted_at older than cooldown → notice present + curate-emit.json RMW-stamped.
test('T23 buildSiloNotices: stamp older than cooldown → notice present + curate-emit.json stamped to now', async () => {
  resetCurate();
  const dir = await tmpDir();
  const emitPath = join(dir, 'curate-emit.json');
  const status = mkStatus({ is_stale: true, last_success_at: isoAt(NOW - 5 * DAY), days_since_success: 5, last_event_kind: 'complete' });
  const notices = await buildSiloNotices({
    curateStatus: okEnv(status),
    curateEmit: { last_emitted_at: isoAt(NOW - 7 * 60 * 60 * 1000) }, // 7h ago > 6h
    curateEmitPath: emitPath,
    now: NOW,
  });
  assert.ok((notices ?? []).some((n) => n.kind === 'curate_liveness_stale'));
  const stamp = JSON.parse(await fs.readFile(emitPath, 'utf8'));
  assert.equal(stamp.last_emitted_at, isoAt(NOW));
  assert.equal(stamp.schema_version, 1);
});

// T24 — corrupt/garbled last_emitted_at (NaN) → treated as DUE (never silent forever).
test('T24 buildSiloNotices: NaN last_emitted_at → treated as due, notice present (#8)', async () => {
  resetCurate();
  const status = mkStatus({ is_stale: true, last_success_at: isoAt(NOW - 5 * DAY), days_since_success: 5, last_event_kind: 'complete' });
  const notices = await buildSiloNotices({
    curateStatus: okEnv(status),
    curateEmit: { last_emitted_at: 'not-a-date' },
    now: NOW,
  });
  assert.ok((notices ?? []).some((n) => n.kind === 'curate_liveness_stale'));
});

// T25 — is_stale=false with a recent success → no curate notice.
test('T25 buildSiloNotices: fresh success (is_stale=false) → no curate notice', async () => {
  resetCurate();
  const status = mkStatus({ is_stale: false, last_success_at: isoAt(NOW - 0.5 * DAY), days_since_success: 0.5, last_event_kind: 'complete' });
  const notices = await buildSiloNotices({ curateStatus: okEnv(status), curateEmit: null, now: NOW });
  assert.equal(notices, null);
});

// T26 — opt-out suppresses ALL curate kinds; the two opt-out vars are independent.
test('T26 curate opt-out: SILO_DISABLE_CURATE_LIVENESS suppresses; independent of SILO_DISABLE_UPDATE_CHECK', async () => {
  resetCurate();
  const status = mkStatus({ is_stale: true, last_success_at: isoAt(NOW - 5 * DAY), days_since_success: 5, last_event_kind: 'complete' });
  const notices = await buildSiloNotices({
    curateStatus: okEnv(status),
    curateEmit: null,
    curateLivenessDisabled: true,
    now: NOW,
  });
  assert.equal(notices, null);
  // Predicate independence (#5): curate var ≠ update var.
  assert.equal(isCurateLivenessOptOut({ SILO_DISABLE_CURATE_LIVENESS: '1' }), true);
  assert.equal(isCurateLivenessOptOut({ SILO_DISABLE_UPDATE_CHECK: '1' }), false);
  assert.equal(isCurateLivenessOptOut({}), false);
});

// T27 — the three message branches + the R2-Live-3 branch-order regression.
test('T27 buildSiloNotices: message branches (failed / silent-death / in-progress) + R2-Live-3 order', async () => {
  // failed (last_event_kind='failed', last_failure_msg set, not in_progress)
  resetCurate();
  let n = (await buildSiloNotices({
    curateStatus: okEnv(mkStatus({ is_stale: true, days_since_success: 5, last_success_at: isoAt(NOW - 5 * DAY), last_event_kind: 'failed', last_failure_msg: 'silo-curate run failed (exit=1)' })),
    curateEmit: null, now: NOW,
  }))[0];
  assert.equal(n.kind, 'curate_liveness_stale');
  assert.match(n.message, /last run FAILED/);

  // silent death (no failure msg, not in_progress) → cron/exec-bit hint
  resetCurate();
  n = (await buildSiloNotices({
    curateStatus: okEnv(mkStatus({ is_stale: true, days_since_success: 5, last_success_at: isoAt(NOW - 5 * DAY), last_event_kind: 'complete', last_failure_msg: null })),
    curateEmit: null, now: NOW,
  }))[0];
  assert.match(n.message, /no heartbeat/);

  // in-progress (last_event_kind='started')
  resetCurate();
  n = (await buildSiloNotices({
    curateStatus: okEnv(mkStatus({ is_stale: true, days_since_success: 5, last_success_at: isoAt(NOW - 5 * DAY), last_event_kind: 'started', in_progress: true })),
    curateEmit: null, now: NOW,
  }))[0];
  assert.match(n.message, /started but has not completed/);

  // R2-Live-3 regression: in_progress=true AND a stale last_failure_msg present
  // → MUST take the in-progress branch, NOT the failed branch.
  resetCurate();
  n = (await buildSiloNotices({
    curateStatus: okEnv(mkStatus({ is_stale: true, days_since_success: 5, last_success_at: isoAt(NOW - 5 * DAY), last_event_kind: 'started', in_progress: true, last_failure_msg: 'silo-curate run failed (exit=1)', consecutive_failures: 1 })),
    curateEmit: null, now: NOW,
  }))[0];
  assert.match(n.message, /started but has not completed/);
  assert.doesNotMatch(n.message, /last run FAILED/);
});

// T28 — never-succeeded fires past the grace window; stays dark within it; sub-message switches.
test('T28 buildSiloNotices: curate_never_succeeded past grace; dark within grace; sub-message on last_run_at', async () => {
  // past grace, ran-but-never-completed (last_run_at set)
  resetCurate();
  let notices = await buildSiloNotices({
    curateStatus: okEnv(mkStatus({ last_success_at: null, last_run_at: isoAt(NOW - 4 * DAY), first_observed_at: isoAt(NOW - 4 * DAY), last_event_kind: 'failed' })),
    curateEmit: null, now: NOW,
  });
  let n = (notices ?? []).find((x) => x.kind === 'curate_never_succeeded');
  assert.ok(n, 'expected curate_never_succeeded past grace');
  assert.match(n.message, /has run but has NEVER completed/);

  // past grace, never-ran-at-all (last_run_at null) → different sub-message
  resetCurate();
  notices = await buildSiloNotices({
    curateStatus: okEnv(mkStatus({ last_success_at: null, last_run_at: null, first_observed_at: isoAt(NOW - 4 * DAY), last_event_kind: null })),
    curateEmit: null, now: NOW,
  });
  n = (notices ?? []).find((x) => x.kind === 'curate_never_succeeded');
  assert.ok(n);
  assert.match(n.message, /has NEVER run/);

  // within grace (first_observed_at only 1d ago) → dark
  resetCurate();
  notices = await buildSiloNotices({
    curateStatus: okEnv(mkStatus({ last_success_at: null, last_run_at: null, first_observed_at: isoAt(NOW - 1 * DAY) })),
    curateEmit: null, now: NOW,
  });
  assert.equal(notices, null);
});

// T29 — both-crons-dead: stale monitor mtime/computed_at → curate_monitor_stale (no fold).
test('T29 buildSiloNotices: stale monitor anchor → curate_monitor_stale (from envelope mtimeMs, distinct kind)', async () => {
  resetCurate();
  const oldMs = NOW - 5 * DAY;
  const status = mkStatus({ is_stale: false, computed_at: isoAt(oldMs), last_success_at: isoAt(NOW - 6 * DAY) });
  const notices = await buildSiloNotices({ curateStatus: okEnv(status, oldMs), curateEmit: null, now: NOW });
  const kinds = curateKinds(notices);
  assert.deepEqual(kinds, ['curate_monitor_stale']);
});

// T29a — L1 envelope contract: loadCurateStatus returns {kind:'ok',status,mtimeMs}; cache hit keeps mtimeMs.
test('T29a loadCurateStatus: returns ok envelope with mtimeMs === stat().mtimeMs; cache hit still carries it', async () => {
  resetCurate();
  const dir = await tmpDir();
  const p = join(dir, 'curate-status.json');
  await fs.writeFile(p, JSON.stringify(mkStatus({ is_stale: true, days_since_success: 5 })));
  const st = await fs.stat(p);
  const env1 = await loadCurateStatus(p);
  assert.equal(env1.kind, 'ok');
  assert.equal(env1.mtimeMs, st.mtimeMs);
  assert.equal(env1.status.is_stale, true);
  const env2 = await loadCurateStatus(p); // cache hit (unchanged mtime)
  assert.equal(env2, env1); // same cached envelope object
  assert.equal(env2.mtimeMs, st.mtimeMs);
});

// T30 — corrupt file → {kind:'corrupt'} → curate_monitor_unreadable; omitted arg ≠ corrupt.
test('T30 loadCurateStatus corrupt → curate_monitor_unreadable; omitting curateStatus → no curate notice', async () => {
  resetCurate();
  const dir = await tmpDir();
  const p = join(dir, 'curate-status.json');
  await fs.writeFile(p, '{ not json');
  const original = console.warn;
  console.warn = () => {};
  let env;
  try {
    env = await loadCurateStatus(p);
  } finally {
    console.warn = original;
  }
  assert.equal(env.kind, 'corrupt');
  const notices = await buildSiloNotices({ curateStatus: env, curateEmit: null, now: NOW });
  assert.deepEqual(curateKinds(notices), ['curate_monitor_unreadable']);
  // Omitting curateStatus entirely must NOT masquerade as corrupt.
  resetCurate();
  const none = await buildSiloNotices({ curateEmit: null, now: NOW });
  assert.equal(none, null);
});

// T31 — ENOENT is not a monitor issue; other notices still build.
test('T31 loadCurateStatus absent → {kind:absent} → no curate notice; pending notice still builds', async () => {
  resetCurate();
  _resetPendingCache();
  const dir = await tmpDir();
  const env = await loadCurateStatus(join(dir, 'curate-status.json')); // ENOENT
  assert.deepEqual(env, { kind: 'absent' });
  const pendingPath = join(dir, 'PENDING-SUGGESTIONS.json');
  await writeEnvelope(pendingPath, makeEnvelope({ count: 2, oldest_pending_age_days: 1 }));
  const notices = await buildSiloNotices({ pendingPath, curateStatus: env, curateEmit: null, now: NOW });
  assert.ok(notices);
  assert.equal(curateKinds(notices).length, 0);
  assert.ok(notices.some((n) => n.kind === 'pending_topic_suggestions'));
});

// T32 — curateCache isolation from updateCache (#10).
test('T32 cache isolation: loading curate-status does not perturb update-status reads', async () => {
  resetCurate();
  _resetUpdateCache();
  const dir = await tmpDir();
  const cp = join(dir, 'curate-status.json');
  const up = join(dir, 'update-status.json');
  await fs.writeFile(cp, JSON.stringify(mkStatus({ is_stale: true })));
  await fs.writeFile(up, JSON.stringify({ schema_version: 1, latest_version: '9.9.9', update_available: true }));
  const cEnv = await loadCurateStatus(cp);
  const uStatus = await loadUpdateStatus(up);
  assert.equal(cEnv.kind, 'ok');
  assert.equal(uStatus.latest_version, '9.9.9');
  // Re-read update-status: still intact (curate load didn't clobber updateCache).
  const uAgain = await loadUpdateStatus(up);
  assert.equal(uAgain.latest_version, '9.9.9');
  assert.equal(uAgain, uStatus); // update cache hit unaffected by the curate load
});

// T33 — shared cooldown across kinds: tripping both is_stale + monitor_stale → ≤1 curate notice.
test('T33 buildSiloNotices: shared cooldown → at most one curate notice per window (monitor wins)', async () => {
  resetCurate();
  const dir = await tmpDir();
  const emitPath = join(dir, 'curate-emit.json');
  const oldMs = NOW - 5 * DAY;
  // is_stale=true AND a stale monitor anchor — both conditions trip.
  const status = mkStatus({ is_stale: true, days_since_success: 6, last_success_at: isoAt(NOW - 6 * DAY), computed_at: isoAt(oldMs), last_event_kind: 'complete' });
  const notices = await buildSiloNotices({ curateStatus: okEnv(status, oldMs), curateEmit: null, curateEmitPath: emitPath, now: NOW });
  const kinds = curateKinds(notices);
  assert.equal(kinds.length, 1, `expected exactly one curate notice, got ${kinds.join(',')}`);
  assert.equal(kinds[0], 'curate_monitor_stale');
  // And it stamped the cooldown file.
  const stamp = JSON.parse(await fs.readFile(emitPath, 'utf8'));
  assert.equal(stamp.last_emitted_at, isoAt(NOW));
});
