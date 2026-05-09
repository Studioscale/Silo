import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../src/matrix/load.js';

test('loadMatrix: loads without error', () => {
  const m = loadMatrix();
  assert.ok(m);
  assert.equal(m.schemaVersion, 'v12.5.0');
});

test('matrix: write_event is known, state-bearing, topic family', () => {
  const m = loadMatrix();
  assert.equal(m.isKnown('write_event'), true);
  assert.equal(m.isStateBearing('write_event'), true);
  assert.equal(m.family('write_event'), 'topic');
});

test('matrix: unknown type returns false for isKnown', () => {
  const m = loadMatrix();
  assert.equal(m.isKnown('GHOST_EVENT_TYPE'), false);
});

test('matrix: INSTALL_STEP_HEARTBEAT is NOT state-bearing', () => {
  // v12.5 spec — heartbeat is telemetry, not state-bearing
  const m = loadMatrix();
  assert.equal(m.isStateBearing('INSTALL_STEP_HEARTBEAT'), false);
});

test('matrix admission: write_event admissible on standard in normal mode', () => {
  const m = loadMatrix();
  assert.equal(m.isAdmissible('write_event', 'standard', 'normal'), true);
  assert.equal(m.isAdmissible('write_event', 'admin', 'normal'), true);
});

test('matrix admission: write_event rejected during install_freeze', () => {
  const m = loadMatrix();
  assert.equal(m.isAdmissible('write_event', 'standard', 'install_freeze'), false);
  assert.equal(m.isAdmissible('write_event', 'admin', 'install_freeze'), false);
});

test('matrix admission: ACL_SEALED rejected on standard socket (v12.5 fix 8)', () => {
  // v12.5 made ACL_SEALED admin-only to close denial-of-access vector
  const m = loadMatrix();
  assert.equal(m.isAdmissible('ACL_SEALED', 'standard', 'normal'), false);
  assert.equal(m.isAdmissible('ACL_SEALED', 'admin', 'normal'), true);
});

test('matrix admission: identity events admin-only', () => {
  const m = loadMatrix();
  assert.equal(m.isAdmissible('PRINCIPAL_DECLARED', 'standard', 'normal'), false);
  assert.equal(m.isAdmissible('PRINCIPAL_DECLARED', 'admin', 'normal'), true);
  assert.equal(m.isAdmissible('PRINCIPAL_KEY_BOUND', 'admin', 'install_freeze'), true);
});

test('matrix admission: RECOVERY_MODE_ENTERED admissible in read_only (v12.5 §3.7)', () => {
  // The event that transitions read-only -> recovery must be admissible in read-only
  const m = loadMatrix();
  assert.equal(m.isAdmissible('RECOVERY_MODE_ENTERED', 'admin', 'read_only'), true);
});

test('matrix admission: RECOVERY_ACCEPTED/REPUDIATED only in recovery mode', () => {
  const m = loadMatrix();
  assert.equal(m.isAdmissible('RECOVERY_ACCEPTED', 'admin', 'recovery'), true);
  assert.equal(m.isAdmissible('RECOVERY_ACCEPTED', 'admin', 'normal'), false);
  assert.equal(m.isAdmissible('RECOVERY_ACCEPTED', 'admin', 'read_only'), false);
});

test('matrix admission: install events admissible during install_freeze', () => {
  const m = loadMatrix();
  assert.equal(m.isAdmissible('INSTALL_STARTED', 'admin', 'install_freeze'), true);
  assert.equal(m.isAdmissible('INSTALL_STEP_HEARTBEAT', 'admin', 'install_freeze'), true);
  assert.equal(m.isAdmissible('INSTALL_COMPLETED', 'admin', 'install_freeze'), true);
});

test('matrix admission: unknown type is NOT admissible (caller handles via REGISTER_EVENT_TYPE)', () => {
  const m = loadMatrix();
  assert.equal(m.isAdmissible('FUTURE_UNKNOWN_EVENT', 'standard', 'normal'), false);
  assert.equal(m.isAdmissible('FUTURE_UNKNOWN_EVENT', 'admin', 'normal'), false);
});

test('matrix: listTypes returns all registered events (sanity check)', () => {
  const m = loadMatrix();
  const types = m.listTypes();
  assert.ok(types.length > 20, `expected >20 types, got ${types.length}`);
  assert.ok(types.includes('write_event'));
  assert.ok(types.includes('PRINCIPAL_DECLARED'));
  assert.ok(types.includes('REGISTER_EVENT_TYPE'));
});

test('matrix: TOPIC_BULLETS_RETIRED is known, state-bearing, topic family', () => {
  // Phase 2 of dreaming-inspired upgrade: curation pipeline retires Layer 2
  // bullets that recent events have invalidated.
  const m = loadMatrix();
  assert.equal(m.isKnown('TOPIC_BULLETS_RETIRED'), true);
  assert.equal(m.isStateBearing('TOPIC_BULLETS_RETIRED'), true);
  assert.equal(m.family('TOPIC_BULLETS_RETIRED'), 'topic');
});

test('matrix admission: TOPIC_BULLETS_RETIRED admissible on standard in normal mode', () => {
  // Mirrors TOPIC_VERIFIED / TOPIC_CURATED admission (curate runs as
  // standard principal). Rejected in frozen modes like other topic events.
  const m = loadMatrix();
  assert.equal(m.isAdmissible('TOPIC_BULLETS_RETIRED', 'standard', 'normal'), true);
  assert.equal(m.isAdmissible('TOPIC_BULLETS_RETIRED', 'admin', 'normal'), true);
  assert.equal(m.isAdmissible('TOPIC_BULLETS_RETIRED', 'standard', 'install_freeze'), false);
  assert.equal(m.isAdmissible('TOPIC_BULLETS_RETIRED', 'standard', 'read_only'), false);
});
