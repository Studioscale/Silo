/**
 * Tests for the M3 matrix admission gate inside _appendBatchUnlocked.
 *
 * 14 scenarios from proposals/m3-admission-gate.md §6.1:
 *   1.  standard admits write_event (default-no-socket)
 *   2.  standard admits write_event (explicit socket:'standard')
 *   3.  standard rejects ACL_SEALED (admin-only)
 *   4.  standard rejects PRINCIPAL_DECLARED (admin-only)
 *   5.  admin admits ACL_SEALED
 *   6.  admin admits write_event (admin can do everything standard can)
 *   7.  unknown event type rejected on standard
 *   8.  unknown event type rejected on admin
 *   9.  batch rejects when ANY entry fails admission (atomicity)
 *  10.  batch all-pass — multiple admin events on admin socket persist
 *  11.  admission runs BEFORE payload validation (spy-based ordering proof)
 *  12.  concurrency — parallel writes serialize through gate
 *  13.  invalid socket value rejected
 *  14.  mode != 'normal' rejected with INVALID_WRITER_MODE
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { AdmissionError } from '../src/log/admission-error.js';

async function freshWriter() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-m3-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function seedAdminBootstrap(writer) {
  // Use admin socket for identity events — required post-M3.
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    socket: 'admin',
    isStateBearing: true,
    intentId: 'i:p1',
    principal: 'bootstrap',
    payload: { principal: 'helder', class: 'human' },
    ts: '2026-04-22T00:00:00Z',
  });
  await writer.append({
    type: 'PRINCIPAL_ACCESS_ENABLED',
    socket: 'admin',
    isStateBearing: true,
    intentId: 'i:p2',
    principal: 'bootstrap',
    payload: { principal: 'helder' },
    ts: '2026-04-22T00:00:01Z',
  });
}

// ── 1. standard admits write_event (default-no-socket) ───────────────────────

test('admission: standard admits write_event (default-no-socket)', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  const r = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'i:w1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'hello' },
    ts: '2026-04-22T01:00:00Z',
  });
  assert.equal(r.seq, 3);
});

// ── 2. standard admits write_event (explicit socket) ─────────────────────────

test('admission: standard admits write_event (explicit socket)', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  const r = await writer.append({
    type: 'write_event',
    socket: 'standard',
    isStateBearing: true,
    intentId: 'i:w1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'hi' },
    ts: '2026-04-22T01:00:00Z',
  });
  assert.equal(r.seq, 3);
});

// ── 3. standard rejects ACL_SEALED ───────────────────────────────────────────

test('admission: standard rejects ACL_SEALED', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  await assert.rejects(
    writer.append({
      type: 'ACL_SEALED',
      isStateBearing: true,
      intentId: 'i:s1',
      principal: 'helder',
      payload: { topic: 'general', readers: ['helder'] },
      ts: '2026-04-22T01:00:00Z',
    }),
    (err) => {
      assert.ok(err instanceof AdmissionError);
      assert.equal(err.code, 'EVENT_NOT_ADMISSIBLE');
      assert.equal(err.details.type, 'ACL_SEALED');
      assert.equal(err.details.socket, 'standard');
      assert.equal(err.details.mode, 'normal');
      return true;
    },
  );
});

// ── 4. standard rejects PRINCIPAL_DECLARED ───────────────────────────────────

test('admission: standard rejects PRINCIPAL_DECLARED', async () => {
  const { writer } = await freshWriter();
  await assert.rejects(
    writer.append({
      type: 'PRINCIPAL_DECLARED',
      socket: 'standard',
      isStateBearing: true,
      intentId: 'i:p1',
      principal: 'bootstrap',
      payload: { principal: 'helder', class: 'human' },
      ts: '2026-04-22T00:00:00Z',
    }),
    (err) => {
      assert.equal(err.code, 'EVENT_NOT_ADMISSIBLE');
      assert.equal(err.details.type, 'PRINCIPAL_DECLARED');
      return true;
    },
  );
});

// ── 5. admin admits ACL_SEALED ───────────────────────────────────────────────

test('admission: admin admits ACL_SEALED — persists with seq + hash', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  const r = await writer.append({
    type: 'ACL_SEALED',
    socket: 'admin',
    isStateBearing: true,
    intentId: 'i:s1',
    principal: 'operator',
    payload: { topic: 'general', readers: ['helder'] },
    ts: '2026-04-22T01:00:00Z',
  });
  assert.equal(r.seq, 3);
  assert.ok(typeof r.hash === 'string' && r.hash.length === 64);
  assert.equal(r.entry.type, 'ACL_SEALED');
  // socket/mode are writer-control metadata — NOT persisted into the entry.
  assert.equal(r.entry.socket, undefined);
  assert.equal(r.entry.mode, undefined);
});

// ── 6. admin admits write_event ──────────────────────────────────────────────

test('admission: admin admits write_event (admin can do everything standard can)', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  const r = await writer.append({
    type: 'write_event',
    socket: 'admin',
    isStateBearing: true,
    intentId: 'i:w1',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'hi' },
    ts: '2026-04-22T01:00:00Z',
  });
  assert.equal(r.seq, 3);
});

// ── 7. unknown type rejected on standard ─────────────────────────────────────

test('admission: unknown event type rejected on standard', async () => {
  const { writer } = await freshWriter();
  await assert.rejects(
    writer.append({
      type: 'UNKNOWN_EVENT_TYPE_FROM_THE_FUTURE',
      isStateBearing: true,
      intentId: 'i:x',
      principal: 'helder',
      payload: {},
      ts: '2026-04-22T00:00:00Z',
    }),
    (err) => {
      assert.equal(err.code, 'UNKNOWN_EVENT_TYPE_NOT_REGISTERED');
      assert.equal(err.details.type, 'UNKNOWN_EVENT_TYPE_FROM_THE_FUTURE');
      return true;
    },
  );
});

// ── 8. unknown type rejected on admin ────────────────────────────────────────

test('admission: unknown event type rejected on admin', async () => {
  const { writer } = await freshWriter();
  await assert.rejects(
    writer.append({
      type: 'UNKNOWN_EVENT_TYPE_FROM_THE_FUTURE',
      socket: 'admin',
      isStateBearing: true,
      intentId: 'i:x',
      principal: 'bootstrap',
      payload: {},
      ts: '2026-04-22T00:00:00Z',
    }),
    (err) => {
      assert.equal(err.code, 'UNKNOWN_EVENT_TYPE_NOT_REGISTERED');
      return true;
    },
  );
});

// ── 9. batch rejects when ANY entry fails admission ──────────────────────────

test('admission: batch rejects when ANY entry fails — tail unchanged', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  const tailBefore = writer.tail().seq;
  await assert.rejects(
    writer.batchAppend([
      {
        type: 'write_event',
        isStateBearing: true,
        intentId: 'i:b1',
        principal: 'helder',
        payload: { slug: 'general', tag: 'FACT', content: 'first' },
        ts: '2026-04-22T01:00:00Z',
      },
      {
        // Admin event on default (standard) socket — admission fails.
        type: 'ACL_SEALED',
        isStateBearing: true,
        intentId: 'i:b2',
        principal: 'operator',
        payload: { topic: 'general', readers: ['helder'] },
        ts: '2026-04-22T01:00:01Z',
      },
    ]),
    (err) => {
      assert.equal(err.code, 'EVENT_NOT_ADMISSIBLE');
      return true;
    },
  );
  const tailAfter = writer.tail().seq;
  assert.equal(tailAfter, tailBefore, 'tail must not advance when batch fails');
});

// ── 10. batch all-pass — multiple events on admin socket persist ─────────────

test('admission: batch all-pass — multiple events persist with sequential seqs', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  const r = await writer.batchAppend([
    {
      type: 'TOPIC_METADATA_SET',
      isStateBearing: true,
      intentId: 'i:b1',
      principal: 'helder',
      payload: { topic: 'general', type: 'reference' },
      ts: '2026-04-22T01:00:00Z',
    },
    {
      type: 'write_event',
      isStateBearing: true,
      intentId: 'i:b2',
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: 'hi' },
      ts: '2026-04-22T01:00:01Z',
    },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].seq, 3);
  assert.equal(r[1].seq, 4);
});

// ── 11. admission BEFORE payload validation — observed via error code ───────
//
// ESM module exports are read-only, so we can't spy via reassignment. Instead
// we observe the ORDER of failure: an event that would fail BOTH admission
// AND payload validation must surface the admission error, not the payload
// error. Without the gate-first ordering, the payload validator would throw
// 'INVALID_EVENT_PAYLOAD' first.

test('admission: runs BEFORE payload validation (error-code ordering proof)', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  // write_event has a payload validator that requires {slug, tag, content}.
  // Send it with an invalid socket AND a missing payload — both would reject,
  // but admission runs first, so we should see EVENT_NOT_ADMISSIBLE with
  // an "invalid socket" reason, NOT a payload-shape error.
  await assert.rejects(
    writer.append({
      type: 'write_event',
      socket: 'banana',          // admission rejects: invalid socket
      isStateBearing: true,
      intentId: 'i:s',
      principal: 'helder',
      payload: {},               // would ALSO fail payload validation
      ts: '2026-04-22T01:00:00Z',
    }),
    (err) => {
      assert.equal(err.code, 'EVENT_NOT_ADMISSIBLE',
        'admission must surface before payload validation can throw');
      assert.match(err.details.reason || '', /invalid socket/);
      return true;
    },
  );
});

// ── 12. concurrency — parallel writes through the gate ───────────────────────

test('admission: parallel writes serialize cleanly through the gate', async () => {
  const { writer } = await freshWriter();
  await seedAdminBootstrap(writer);
  // Fire 5 standard write_events in parallel. The in-process mutex + flock
  // serialize them; admission runs per call. All should land with sequential
  // seqs starting from 3 (post-bootstrap).
  const results = await Promise.all([
    writer.append({ type: 'write_event', isStateBearing: true, intentId: 'i:c1', principal: 'helder', payload: { slug: 'general', tag: 'FACT', content: 'a' }, ts: '2026-04-22T01:00:00Z' }),
    writer.append({ type: 'write_event', isStateBearing: true, intentId: 'i:c2', principal: 'helder', payload: { slug: 'general', tag: 'FACT', content: 'b' }, ts: '2026-04-22T01:00:01Z' }),
    writer.append({ type: 'write_event', isStateBearing: true, intentId: 'i:c3', principal: 'helder', payload: { slug: 'general', tag: 'FACT', content: 'c' }, ts: '2026-04-22T01:00:02Z' }),
    writer.append({ type: 'write_event', isStateBearing: true, intentId: 'i:c4', principal: 'helder', payload: { slug: 'general', tag: 'FACT', content: 'd' }, ts: '2026-04-22T01:00:03Z' }),
    writer.append({ type: 'write_event', isStateBearing: true, intentId: 'i:c5', principal: 'helder', payload: { slug: 'general', tag: 'FACT', content: 'e' }, ts: '2026-04-22T01:00:04Z' }),
  ]);
  const seqs = results.map(r => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [3, 4, 5, 6, 7]);
});

// ── 13. invalid socket value rejected ────────────────────────────────────────

test('admission: invalid socket value rejected with structured error', async () => {
  const { writer } = await freshWriter();
  await assert.rejects(
    writer.append({
      type: 'write_event',
      socket: 'banana',
      isStateBearing: true,
      intentId: 'i:b',
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: 'x' },
      ts: '2026-04-22T00:00:00Z',
    }),
    (err) => {
      assert.equal(err.code, 'EVENT_NOT_ADMISSIBLE');
      assert.equal(err.details.socket, 'banana');
      assert.match(err.details.reason || '', /invalid socket/);
      return true;
    },
  );
});

// ── 14. mode != 'normal' rejected with INVALID_WRITER_MODE ───────────────────

test('admission: mode !== "normal" rejected with INVALID_WRITER_MODE', async () => {
  const { writer } = await freshWriter();
  await assert.rejects(
    writer.append({
      type: 'write_event',
      mode: 'recovery',
      isStateBearing: true,
      intentId: 'i:m',
      principal: 'helder',
      payload: { slug: 'general', tag: 'FACT', content: 'x' },
      ts: '2026-04-22T00:00:00Z',
    }),
    (err) => {
      assert.equal(err.code, 'INVALID_WRITER_MODE');
      assert.equal(err.details.mode, 'recovery');
      return true;
    },
  );
  // mode === 'normal' explicitly is accepted (no-op equivalent of omission).
  const r = await writer.append({
    type: 'write_event',
    mode: 'normal',
    socket: 'standard',
    isStateBearing: true,
    intentId: 'i:m2',
    principal: 'helder',
    payload: { slug: 'general', tag: 'FACT', content: 'x' },
    ts: '2026-04-22T00:00:01Z',
  });
  assert.equal(r.seq, 1);
});
