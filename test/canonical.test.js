import test from 'node:test';
import assert from 'node:assert/strict';
import { nfcNormalize, canonicalBytes, canonicalHash } from '../src/log/canonical.js';

test('nfcNormalize: ASCII passes through', () => {
  assert.equal(nfcNormalize('hello'), 'hello');
});

test('nfcNormalize: NFD to NFC composition', () => {
  // "é" as NFD (e + combining acute) vs NFC (single code point)
  const nfd = 'cafe\u0301';
  const nfc = 'café';
  assert.equal(nfd.normalize('NFC'), nfc);
  assert.equal(nfcNormalize(nfd), nfc);
});

test('nfcNormalize: recursive on nested objects', () => {
  const input = {
    a: 'cafe\u0301',
    b: { c: 'na\u0303o', d: [1, 'mu\u0301sica'] },
  };
  const out = nfcNormalize(input);
  assert.equal(out.a, 'café');
  assert.equal(out.b.c, 'não');
  assert.equal(out.b.d[1], 'música');
  assert.equal(out.b.d[0], 1); // numbers unchanged
});

test('nfcNormalize: object keys also normalized', () => {
  const input = { 'cafe\u0301': 1 };
  const out = nfcNormalize(input);
  assert.ok('café' in out);
  assert.equal(out['café'], 1);
});

test('canonicalBytes: deterministic output for equivalent inputs', () => {
  // Two objects with different key-insertion order should produce identical bytes
  // (JCS canonicalization sorts keys lexicographically).
  const a = { b: 2, a: 1, c: 3 };
  const b = { a: 1, b: 2, c: 3 };
  const c = { c: 3, a: 1, b: 2 };
  const hashA = canonicalHash(a);
  const hashB = canonicalHash(b);
  const hashC = canonicalHash(c);
  assert.equal(hashA, hashB);
  assert.equal(hashB, hashC);
});

test('canonicalBytes: NFD and NFC inputs produce identical hash', () => {
  const nfd = { content: 'cafe\u0301' };
  const nfc = { content: 'café' };
  assert.equal(canonicalHash(nfd), canonicalHash(nfc));
});

test('canonicalHash: known-value SHA-256 of {} (empty object)', () => {
  // JCS of {} is "{}", SHA-256 of "{}" (utf-8) is 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
  const hash = canonicalHash({});
  assert.equal(hash, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
});

test('canonicalHash: different values produce different hashes', () => {
  const a = canonicalHash({ x: 1 });
  const b = canonicalHash({ x: 2 });
  assert.notEqual(a, b);
});
