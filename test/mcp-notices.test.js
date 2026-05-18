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
  isUpdateOptOut,
  _resetPendingCache,
  _resetUpdateCache,
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
