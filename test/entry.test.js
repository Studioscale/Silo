import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntry, entryHash, serializeEntry, GENESIS_HASH, SCHEMA_VERSION } from '../src/log/entry.js';

test('buildEntry: happy path produces well-formed entry', () => {
  const entry = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: 1,
    hashPrev: GENESIS_HASH,
    intentId: 'intent:01948a3b-5c7d-7890-abcd-ef0123456789',
    principal: 'helder',
    payload: { slug: 'project-alpha', tag: 'FACT', content: 'hello' },
    ts: '2026-04-22T10:00:00Z',
  });
  assert.equal(entry.type, 'write_event');
  assert.equal(entry.schema_version, SCHEMA_VERSION);
  assert.equal(entry.is_state_bearing, true);
  assert.equal(entry.seq, 1);
  assert.equal(entry.hash_prev, GENESIS_HASH);
  assert.equal(entry.principal, 'helder');
  assert.deepEqual(entry.payload, { slug: 'project-alpha', tag: 'FACT', content: 'hello' });
});

test('buildEntry: invalid seq rejected', () => {
  assert.throws(
    () =>
      buildEntry({
        type: 't',
        isStateBearing: true,
        seq: 0,
        hashPrev: GENESIS_HASH,
        intentId: 'x',
        principal: 'p',
        payload: {},
      }),
    /invalid seq/,
  );
});

test('buildEntry: invalid hash_prev rejected', () => {
  assert.throws(
    () =>
      buildEntry({
        type: 't',
        isStateBearing: true,
        seq: 1,
        hashPrev: 'short',
        intentId: 'x',
        principal: 'p',
        payload: {},
      }),
    /invalid hash_prev/,
  );
});

test('buildEntry: missing intent_id rejected', () => {
  assert.throws(
    () =>
      buildEntry({
        type: 't',
        isStateBearing: true,
        seq: 1,
        hashPrev: GENESIS_HASH,
        intentId: '',
        principal: 'p',
        payload: {},
      }),
    /intent_id required/,
  );
});

test('entryHash: deterministic across builds with same inputs', () => {
  const args = {
    type: 'write_event',
    isStateBearing: true,
    seq: 1,
    hashPrev: GENESIS_HASH,
    intentId: 'intent:abc',
    principal: 'helder',
    payload: { a: 1 },
    ts: '2026-04-22T10:00:00Z',
  };
  const h1 = entryHash(buildEntry(args));
  const h2 = entryHash(buildEntry(args));
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test('entryHash: chain — different hashPrev produces different hash', () => {
  const base = {
    type: 'write_event',
    isStateBearing: true,
    seq: 2,
    intentId: 'intent:abc',
    principal: 'helder',
    payload: { a: 1 },
    ts: '2026-04-22T10:00:00Z',
  };
  const h1 = entryHash(buildEntry({ ...base, hashPrev: GENESIS_HASH }));
  const h2 = entryHash(buildEntry({ ...base, hashPrev: 'a'.repeat(64) }));
  assert.notEqual(h1, h2);
});

test('serializeEntry: ends with single LF', () => {
  const entry = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: 1,
    hashPrev: GENESIS_HASH,
    intentId: 'intent:abc',
    principal: 'helder',
    payload: { content: 'hello' },
    ts: '2026-04-22T10:00:00Z',
  });
  const bytes = serializeEntry(entry);
  assert.equal(bytes[bytes.length - 1], 0x0a); // LF
  // Only one trailing LF
  assert.notEqual(bytes[bytes.length - 2], 0x0a);
});

test('serializeEntry + entryHash: round-trip determinism with NFD/NFC equivalents', () => {
  const nfd = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: 1,
    hashPrev: GENESIS_HASH,
    intentId: 'intent:abc',
    principal: 'helder',
    payload: { content: 'cafe\u0301' },
    ts: '2026-04-22T10:00:00Z',
  });
  const nfc = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: 1,
    hashPrev: GENESIS_HASH,
    intentId: 'intent:abc',
    principal: 'helder',
    payload: { content: 'café' },
    ts: '2026-04-22T10:00:00Z',
  });
  assert.equal(entryHash(nfd), entryHash(nfc));
  assert.deepEqual(serializeEntry(nfd), serializeEntry(nfc));
});
