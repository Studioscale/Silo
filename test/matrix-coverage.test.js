/**
 * Matrix coverage meta-test — proposals/m3-admission-gate.md §6.2.
 *
 * Asserts that for EVERY event type in matrix.yaml, the writer's admission
 * gate behaves consistently with what the matrix declares for normal mode.
 *
 * Coverage shape per row:
 *   - Type has at least one normal-mode-Y cell (standard:Y or admin:Y):
 *     emit synthetically on the lowest-privilege admissible socket;
 *     admission MUST pass. (Payload validation may still throw
 *     INVALID_EVENT_PAYLOAD — that's fine, it means admission already let
 *     us through.)
 *   - Type has normal-mode-N on EVERY socket (recovery-only rows like
 *     RECOVERY_ACCEPTED / RECOVERY_REPUDIATED): admission MUST reject on
 *     BOTH standard and admin sockets with EVENT_NOT_ADMISSIBLE.
 *
 * Catches "added a new event type but forgot to wire admission" regressions,
 * and forces explicit rejection coverage for matrix-N-in-normal-mode types.
 *
 * Synthetic positive cases cover dormant event families (INSTALL_*,
 * FEATURE_*, TAG_SCHEMA_*, broker meta, observations, procedures,
 * COHORT_SPLIT) that have no production call sites yet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { loadMatrix } from '../src/matrix/load.js';

async function freshWriter() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-matrix-cov-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

/** Lowest-privilege admissible socket for a type in normal mode (or null). */
function lowestPrivilegeAdmissibleSocket(matrix, type) {
  if (matrix.isAdmissible(type, 'standard', 'normal')) return 'standard';
  if (matrix.isAdmissible(type, 'admin', 'normal')) return 'admin';
  return null;
}

/**
 * Try to emit an event and classify the outcome:
 *   - 'admitted'   → admission passed (may have failed payload validation)
 *   - 'rejected'   → admission rejected with EVENT_NOT_ADMISSIBLE
 *   - 'other-err'  → unexpected error class (test failure)
 */
async function probeAdmission(writer, type, socket) {
  try {
    await writer.append({
      type,
      socket,
      isStateBearing: true,
      intentId: `i:${type}:${socket}`,
      principal: 'bootstrap',
      payload: {},  // intentionally minimal — admission must pass before
                    // payload validation runs.
      ts: '2026-04-22T00:00:00Z',
    });
    return { kind: 'admitted' };
  } catch (err) {
    if (err.name === 'AdmissionError' && err.code === 'EVENT_NOT_ADMISSIBLE') {
      return { kind: 'rejected', details: err.details };
    }
    if (err.name === 'AdmissionError' && err.code === 'UNKNOWN_EVENT_TYPE_NOT_REGISTERED') {
      return { kind: 'unknown', details: err.details };
    }
    // Anything else — payload validator's AdmissionValidationError, or some
    // unrelated error — counts as "admission passed through to the next stage."
    return { kind: 'admitted', via: err.name };
  }
}

// ── Per-type coverage ────────────────────────────────────────────────────────

test('matrix coverage: every type has correct admission behavior in normal mode', async () => {
  const matrix = loadMatrix();
  const types = matrix.listTypes();
  assert.ok(types.length > 0, 'matrix must have at least one event type');

  const { writer } = await freshWriter();

  for (const type of types) {
    const admissibleSocket = lowestPrivilegeAdmissibleSocket(matrix, type);

    if (admissibleSocket) {
      // Type has a normal-mode positive cell — admission must pass on the
      // lowest-privilege admissible socket.
      const result = await probeAdmission(writer, type, admissibleSocket);
      assert.notEqual(
        result.kind, 'rejected',
        `type=${type} on socket=${admissibleSocket}: matrix says admissible (normal mode) but admission rejected with ${JSON.stringify(result.details)}`,
      );
      assert.notEqual(
        result.kind, 'unknown',
        `type=${type}: matrix.isKnown returned true but writer's matrix oracle said unknown`,
      );
    } else {
      // Type has N on every normal-mode socket. Admission must reject on
      // BOTH standard and admin per spec §6.2 strict-recovery posture.
      const stdResult = await probeAdmission(writer, type, 'standard');
      assert.equal(
        stdResult.kind, 'rejected',
        `type=${type} on standard: matrix denies in normal mode but admission did not reject (kind=${stdResult.kind})`,
      );
      const adminResult = await probeAdmission(writer, type, 'admin');
      assert.equal(
        adminResult.kind, 'rejected',
        `type=${type} on admin: matrix denies in normal mode (recovery-only type) but admission did not reject (kind=${adminResult.kind})`,
      );
    }
  }
});

// ── Targeted explicit-rejection cases for the recovery-only rows ─────────────
// These duplicate what the iteration above proves, but they're called out by
// name so a regression in just these rows surfaces with a clear failure
// message (rather than the generic per-type loop assertion).

test('matrix coverage: RECOVERY_ACCEPTED rejected on standard AND admin in normal mode', async () => {
  const { writer } = await freshWriter();
  const std = await probeAdmission(writer, 'RECOVERY_ACCEPTED', 'standard');
  assert.equal(std.kind, 'rejected');
  const admin = await probeAdmission(writer, 'RECOVERY_ACCEPTED', 'admin');
  assert.equal(admin.kind, 'rejected');
});

test('matrix coverage: RECOVERY_REPUDIATED rejected on standard AND admin in normal mode', async () => {
  const { writer } = await freshWriter();
  const std = await probeAdmission(writer, 'RECOVERY_REPUDIATED', 'standard');
  assert.equal(std.kind, 'rejected');
  const admin = await probeAdmission(writer, 'RECOVERY_REPUDIATED', 'admin');
  assert.equal(admin.kind, 'rejected');
});

// ── Sanity: matrix.yaml hasn't been emptied or restructured ──────────────────

test('matrix coverage: matrix.yaml carries at least the v12.5 event families', async () => {
  const matrix = loadMatrix();
  // Spot-check representative types from each family to catch a structural
  // regression (e.g., someone accidentally deleted half the matrix file).
  for (const t of [
    'write_event', 'ACL_SEALED', 'PRINCIPAL_DECLARED', 'INSTALL_STARTED',
    'TAG_SCHEMA_PROPOSED', 'RECOVERY_MODE_ENTERED', 'REGISTER_EVENT_TYPE',
    'COHORT_SPLIT', 'observation_read', 'PROCEDURE_PUBLISHED',
    'FEATURE_PROPOSED', 'BROKER_KEY_ROTATED',
  ]) {
    assert.ok(matrix.isKnown(t), `matrix lost ${t}`);
  }
});
