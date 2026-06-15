/**
 * Curate-liveness core tests (SPEC-curate-liveness §8).
 *
 * Covers the pure verdict fold (foldLiveness — hysteresis / in-progress /
 * first-run / NaN / shape), deriveCuratorStatus integration including the
 * R2-Live-3 `last_event_kind` ordering fix, and curate-status.json cache I/O.
 * Pure-unit where possible; deriveCuratorStatus drives a real log fold via
 * LogWriter/interpret (mirrors test/status-events.test.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import {
  deriveCuratorStatus,
  foldLiveness,
  readCurateStatus,
  writeCurateStatus,
  STATUS_FILENAME,
} from '../src/util/curate-liveness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-06-01T05:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// ── helpers ──────────────────────────────────────────────────────────────────

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-liveness-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function freshDir() {
  return fs.mkdtemp(join(tmpdir(), 'silo-liveness-cache-'));
}

async function emitSystemEvent(writer, { content, source = 'silo-curate', ts, principal = 'curator' }) {
  return writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: `intent:${Math.random()}`,
    principal,
    payload: { slug: 'system', tag: 'FACT', content, source },
    ts,
  });
}

// Build a `raw` object shaped like deriveCuratorStatus's return, for pure
// foldLiveness tests.
function raw({
  lastRunAt = null,
  lastSuccessAt = null,
  lastFailureMsg = null,
  lastEventKind = null,
  consecutiveFailures = 0,
} = {}) {
  return {
    last_run_at: lastRunAt,
    last_success_at: lastSuccessAt,
    consecutive_failures: consecutiveFailures,
    last_failure_msg: lastFailureMsg,
    last_event_kind: lastEventKind,
  };
}

// ── foldLiveness — verdict + hysteresis (T1–T8) ───────────────────────────────

test('T1 foldLiveness: fresh success (<1d) → is_stale=false', () => {
  const r = raw({ lastSuccessAt: iso(T0 - 0.5 * DAY_MS), lastEventKind: 'complete' });
  const out = foldLiveness({ raw: r, prior: null, now: T0 });
  assert.equal(out.is_stale, false);
  assert.ok(out.days_since_success < 1);
});

test('T2 foldLiveness: ~2d since success, prior dark → stays false (single-blip tolerance)', () => {
  const r = raw({ lastSuccessAt: iso(T0 - 2 * DAY_MS), lastEventKind: 'complete' });
  const out = foldLiveness({ raw: r, prior: { is_stale: false }, now: T0 });
  assert.equal(out.is_stale, false);
});

test('T3 foldLiveness: ~4d since success, prior dark → flips is_stale=true', () => {
  const r = raw({ lastSuccessAt: iso(T0 - 4 * DAY_MS), lastEventKind: 'complete' });
  const out = foldLiveness({ raw: r, prior: { is_stale: false }, now: T0 });
  assert.equal(out.is_stale, true);
});

test('T4 foldLiveness: prior stale, days=2 (dead band) → stays true (hysteresis hold)', () => {
  const r = raw({ lastSuccessAt: iso(T0 - 2 * DAY_MS), lastEventKind: 'complete' });
  const out = foldLiveness({ raw: r, prior: { is_stale: true }, now: T0 });
  assert.equal(out.is_stale, true);
});

test('T5 foldLiveness: prior stale, fresh success (0.5d) → clears to false', () => {
  const r = raw({ lastSuccessAt: iso(T0 - 0.5 * DAY_MS), lastEventKind: 'complete' });
  const out = foldLiveness({ raw: r, prior: { is_stale: true }, now: T0 });
  assert.equal(out.is_stale, false);
});

test('T6 foldLiveness: oscillating 1.5↔2.5d never toggles the verdict (dead band)', () => {
  const seq = [1.5, 2.5, 1.5, 2.5];
  // Starting dark → never exceeds STALE_DAYS=3, stays dark.
  let prior = { is_stale: false };
  for (const d of seq) {
    const out = foldLiveness({ raw: raw({ lastSuccessAt: iso(T0 - d * DAY_MS), lastEventKind: 'complete' }), prior, now: T0 });
    assert.equal(out.is_stale, false, `dark→ d=${d}`);
    prior = out;
  }
  // Starting lit → never drops to ≤ CLEAR_DAYS=1, stays lit.
  prior = { is_stale: true };
  for (const d of seq) {
    const out = foldLiveness({ raw: raw({ lastSuccessAt: iso(T0 - d * DAY_MS), lastEventKind: 'complete' }), prior, now: T0 });
    assert.equal(out.is_stale, true, `lit→ d=${d}`);
    prior = out;
  }
});

test('T7 foldLiveness: never succeeded → is_stale=false regardless of last_run age', () => {
  const r = raw({
    lastSuccessAt: null,
    lastRunAt: iso(T0 - 30 * DAY_MS),
    lastEventKind: 'failed',
    lastFailureMsg: 'silo-curate run failed (exit=1)',
    consecutiveFailures: 5,
  });
  const out = foldLiveness({ raw: r, prior: { is_stale: true }, now: T0 });
  assert.equal(out.is_stale, false);
  assert.equal(out.days_since_success, null);
});

test('T8 foldLiveness: success timestamped in the future → is_stale=false (skew fail-safe)', () => {
  const r = raw({ lastSuccessAt: iso(T0 + 2 * DAY_MS), lastEventKind: 'complete' });
  const out = foldLiveness({ raw: r, prior: { is_stale: true }, now: T0 });
  assert.equal(out.is_stale, false);
  assert.ok(out.days_since_success < 0);
});

// ── foldLiveness — first-run, in-progress, null, shape (T9–T12) ───────────────

test('T9 foldLiveness: first_observed_at carried forward; stamped when absent', () => {
  const firstIso = iso(T0);
  const later = T0 + 5 * DAY_MS;
  const out = foldLiveness({
    raw: raw({ lastSuccessAt: iso(later - 0.5 * DAY_MS), lastEventKind: 'complete' }),
    prior: { first_observed_at: firstIso, is_stale: false },
    now: later,
  });
  assert.equal(out.first_observed_at, firstIso);
  const out2 = foldLiveness({ raw: raw({ lastSuccessAt: iso(T0), lastEventKind: 'complete' }), prior: null, now: T0 });
  assert.equal(out2.first_observed_at, iso(T0));
});

test('T10 foldLiveness: in_progress keyed off last_event_kind, NOT last_failure_msg (R2-Live-3)', () => {
  // started + a stale failure message present (the masking case the v2 spec got
  // wrong) → must still be in_progress.
  const masked = foldLiveness({
    raw: raw({
      lastEventKind: 'started',
      lastFailureMsg: 'silo-curate run failed (exit=1)',
      lastSuccessAt: iso(T0 - 10 * DAY_MS),
      consecutiveFailures: 1,
      lastRunAt: iso(T0),
    }),
    prior: null,
    now: T0,
  });
  assert.equal(masked.in_progress, true);
  assert.equal(foldLiveness({ raw: raw({ lastEventKind: 'complete', lastSuccessAt: iso(T0) }), prior: null, now: T0 }).in_progress, false);
  assert.equal(foldLiveness({ raw: raw({ lastEventKind: 'failed', lastFailureMsg: 'x' }), prior: null, now: T0 }).in_progress, false);
  assert.equal(foldLiveness({ raw: null, prior: null, now: T0 }).in_progress, false);
});

test('T11 foldLiveness: raw == null → null facts, dark, in_progress=false, stamped first_observed_at', () => {
  const out = foldLiveness({ raw: null, prior: null, now: T0 });
  assert.equal(out.last_run_at, null);
  assert.equal(out.last_success_at, null);
  assert.equal(out.last_failure_msg, null);
  assert.equal(out.last_event_kind, null);
  assert.equal(out.consecutive_failures, 0);
  assert.equal(out.days_since_success, null);
  assert.equal(out.is_stale, false);
  assert.equal(out.in_progress, false);
  assert.equal(out.first_observed_at, iso(T0));
});

test('T12 foldLiveness: output has exactly the §5.4 keys (no last_emitted_at / schema_version)', () => {
  const out = foldLiveness({ raw: raw({ lastSuccessAt: iso(T0), lastEventKind: 'complete' }), prior: null, now: T0 });
  assert.deepEqual(Object.keys(out).sort(), [
    'computed_at',
    'consecutive_failures',
    'days_since_success',
    'first_observed_at',
    'in_progress',
    'is_stale',
    'last_event_kind',
    'last_failure_msg',
    'last_run_at',
    'last_success_at',
  ]);
});

// ── deriveCuratorStatus integration (T13–T16) ─────────────────────────────────

test('T13 deriveCuratorStatus: started+complete → last_success set, cf=0, kind=complete', async () => {
  const { writer } = await freshSilo();
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=a)', ts: '2026-05-19T05:00:00Z' });
  await emitSystemEvent(writer, { content: 'silo-curate run complete (run_id=a)', ts: '2026-05-19T05:00:30Z' });
  const r = deriveCuratorStatus(await interpret(writer));
  assert.equal(r.last_success_at, '2026-05-19T05:00:30Z');
  assert.equal(r.consecutive_failures, 0);
  assert.equal(r.last_event_kind, 'complete');
  assert.equal(r.last_failure_msg, null);
});

test('T14 deriveCuratorStatus: started+failed → failure msg, cf increments, success preserved, kind=failed', async () => {
  const { writer } = await freshSilo();
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=a)', ts: '2026-05-18T05:00:00Z' });
  await emitSystemEvent(writer, { content: 'silo-curate run complete (run_id=a)', ts: '2026-05-18T05:00:30Z' });
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=b)', ts: '2026-05-19T05:00:00Z' });
  await emitSystemEvent(writer, { content: 'silo-curate run failed (run_id=b, exit=1)', ts: '2026-05-19T05:00:30Z' });
  const r = deriveCuratorStatus(await interpret(writer));
  assert.match(r.last_failure_msg, /run failed.*exit=1/);
  assert.equal(r.consecutive_failures, 1);
  assert.equal(r.last_success_at, '2026-05-18T05:00:30Z');
  assert.equal(r.last_event_kind, 'failed');
});

test('T15 deriveCuratorStatus: started, no terminal → last_run set, success untouched, kind=started', async () => {
  const { writer } = await freshSilo();
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=a)', ts: '2026-05-19T05:00:00Z' });
  const r = deriveCuratorStatus(await interpret(writer));
  assert.equal(r.last_run_at, '2026-05-19T05:00:00Z');
  assert.equal(r.last_success_at, null);
  assert.equal(r.last_event_kind, 'started');
});

test('T15a deriveCuratorStatus: success→failure→started(no terminal) — kind=started, failure msg preserved (R2-Live-3)', async () => {
  const { writer } = await freshSilo();
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=a)', ts: '2026-05-17T05:00:00Z' });
  await emitSystemEvent(writer, { content: 'silo-curate run complete (run_id=a)', ts: '2026-05-17T05:00:30Z' });
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=b)', ts: '2026-05-18T05:00:00Z' });
  await emitSystemEvent(writer, { content: 'silo-curate run failed (run_id=b, exit=1)', ts: '2026-05-18T05:00:30Z' });
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=c)', ts: '2026-05-19T05:00:00Z' });
  const r = deriveCuratorStatus(await interpret(writer));
  assert.equal(r.last_event_kind, 'started');
  assert.notEqual(r.last_failure_msg, null); // preserved across the later `run started`
  assert.equal(r.consecutive_failures, 1);
  assert.equal(r.last_success_at, '2026-05-17T05:00:30Z');
  // foldLiveness keys off the ordering, so this is in_progress — NOT the failed branch.
  const out = foldLiveness({ raw: r, prior: null, now: Date.parse('2026-05-25T05:00:00Z') });
  assert.equal(out.in_progress, true);
});

test('T16 deriveCuratorStatus: no curate events → null', async () => {
  const { writer } = await freshSilo();
  await emitSystemEvent(writer, { content: 'silo-detect run started', source: 'silo-topic-detector', ts: '2026-05-19T04:00:00Z' });
  assert.equal(deriveCuratorStatus(await interpret(writer)), null);
});

// ── cache I/O (T17–T20) ───────────────────────────────────────────────────────

test('T17 readCurateStatus: missing file → null', async () => {
  const dir = await freshDir();
  assert.equal(await readCurateStatus(dir), null);
});

test('T18 readCurateStatus: malformed file → null (self-heals on next write)', async () => {
  const dir = await freshDir();
  await fs.writeFile(join(dir, STATUS_FILENAME), '{ not json');
  assert.equal(await readCurateStatus(dir), null);
});

test('T19 writeCurateStatus: round-trips + stamps schema_version + does NOT create curate-emit.json', async () => {
  const dir = await freshDir();
  const verdict = foldLiveness({ raw: raw({ lastSuccessAt: '2026-05-19T05:00:30Z', lastEventKind: 'complete' }), prior: null, now: T0 });
  await writeCurateStatus(dir, verdict);
  const readBack = await readCurateStatus(dir);
  assert.equal(readBack.schema_version, 1);
  assert.equal(readBack.is_stale, verdict.is_stale);
  assert.equal(readBack.first_observed_at, verdict.first_observed_at);
  assert.equal(readBack.last_success_at, '2026-05-19T05:00:30Z');
  // The read-path cooldown stamp must NEVER be created by the cron writer (§5.5).
  const files = await fs.readdir(dir);
  assert.equal(files.includes('curate-emit.json'), false);
});

test('T20 writeCurateStatus: no .tmp residue after success (atomic rename)', async () => {
  const dir = await freshDir();
  await writeCurateStatus(dir, foldLiveness({ raw: null, prior: null, now: T0 }));
  const files = await fs.readdir(dir);
  assert.equal(files.some((f) => f.endsWith('.tmp')), false);
});
