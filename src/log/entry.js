/**
 * Operation log entry construction per v12.5 spec §8.5.
 *
 * Each committed entry carries:
 *   - type: event family (per Event Capability Matrix §4.7)
 *   - schema_version: "v12.5.0"
 *   - is_state_bearing: registry-authoritative (client value ignored for known types)
 *   - seq: monotonic sequence number
 *   - hash_prev: SHA-256 of previous entry's canonical bytes (or zero-hash for genesis)
 *   - intent_id: UUIDv7 client-provided idempotency key
 *   - principal: caller (validated via UID-principal binding at admission)
 *   - ts: ISO 8601 timestamp (audit field; not authoritative for ordering)
 *   - payload: event-type-specific data
 *
 * The entry itself is NFC+JCS canonicalized. Its SHA-256 becomes the next entry's hash_prev.
 */

import { canonicalBytes, canonicalHash } from './canonical.js';

export const GENESIS_HASH = '0'.repeat(64);
export const SCHEMA_VERSION = 'v12.5.0';

/**
 * Construct a log entry given the registry-determined flags + input fields.
 * Does NOT append to disk — pure construction for testability.
 *
 * @param {Object} args
 * @param {string} args.type - event family name (must be in registry)
 * @param {boolean} args.isStateBearing - registry value (NOT client-supplied)
 * @param {number} args.seq - next seq = tail.seq + 1
 * @param {string} args.hashPrev - previous entry's canonical hash (GENESIS_HASH for first)
 * @param {string} args.intentId - UUIDv7
 * @param {string} args.principal - authenticated principal
 * @param {Object} args.payload - event-type-specific
 * @param {string} [args.ts] - ISO timestamp (defaults to now)
 * @returns {Object} entry ready to serialize
 */
export function buildEntry({ type, isStateBearing, seq, hashPrev, intentId, principal, payload, ts }) {
  if (typeof seq !== 'number' || seq < 1) {
    throw new Error(`invalid seq: ${seq}`);
  }
  if (!hashPrev || hashPrev.length !== 64) {
    throw new Error(`invalid hash_prev: ${hashPrev}`);
  }
  if (!intentId) {
    throw new Error('intent_id required');
  }
  if (!principal) {
    throw new Error('principal required');
  }
  const entry = {
    type,
    schema_version: SCHEMA_VERSION,
    is_state_bearing: Boolean(isStateBearing),
    seq,
    hash_prev: hashPrev,
    intent_id: intentId,
    principal,
    ts: ts || new Date().toISOString(),
    payload: payload ?? {},
  };
  return entry;
}

/**
 * Hash a committed entry. Used to compute next entry's hash_prev.
 */
export function entryHash(entry) {
  return canonicalHash(entry);
}

/**
 * Serialize an entry to the JSONL wire format: canonical JSON + trailing LF.
 */
export function serializeEntry(entry) {
  const bytes = canonicalBytes(entry);
  return Buffer.concat([bytes, Buffer.from('\n', 'utf8')]);
}
