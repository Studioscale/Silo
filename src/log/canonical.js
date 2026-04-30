/**
 * Canonical serialization per v12.5 spec §8.5:
 *   1. NFC-normalize all string values in the object (deep)
 *   2. Serialize via RFC 8785 JCS (canonical JSON)
 *   3. SHA-256 the UTF-8 bytes
 *
 * Determinism invariant (v12.5 §1.3):
 *   same input -> byte-identical output on every platform.
 */

import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

/**
 * Recursively NFC-normalize all string values in a JSON-compatible object.
 * Object keys are also normalized. Arrays preserve order.
 */
export function nfcNormalize(value) {
  if (typeof value === 'string') {
    return value.normalize('NFC');
  }
  if (Array.isArray(value)) {
    return value.map(nfcNormalize);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key.normalize('NFC')] = nfcNormalize(value[key]);
    }
    return out;
  }
  // numbers, booleans, null pass through unchanged
  return value;
}

/**
 * Canonical bytes: NFC then JCS then UTF-8 encode.
 * Returns Buffer suitable for hashing or writing to the log.
 */
export function canonicalBytes(obj) {
  const normalized = nfcNormalize(obj);
  const jcsString = canonicalize(normalized);
  if (jcsString === undefined) {
    throw new Error('canonicalize returned undefined; input not JSON-serializable');
  }
  return Buffer.from(jcsString, 'utf8');
}

/**
 * SHA-256 hex of canonical bytes. Used for entry hashing + hash-chain.
 */
export function canonicalHash(obj) {
  return createHash('sha256').update(canonicalBytes(obj)).digest('hex');
}
