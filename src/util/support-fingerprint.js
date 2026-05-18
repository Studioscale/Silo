/**
 * Support fingerprint — Phase 2.2 §9.4.
 *
 * Hash of a suggestion's supporting_seqs. Used by the detector to compare
 * a newly-proposed cluster against pending + cooldown-active dismissed
 * suggestions via Jaccard overlap of their supporting events; the
 * fingerprint is the cheap discriminator that lets us short-circuit the
 * comparison without re-reading the full event payloads.
 *
 * Pure, deterministic, replay-safe — same input → same output forever.
 */

import { createHash } from 'node:crypto';

/**
 * @param {Array<number>} seqs - non-empty array of safe positive integers
 * @returns {string} 16 hex chars (64 bits of SHA-256 prefix)
 */
export function computeSupportFingerprint(seqs) {
  if (!Array.isArray(seqs) || seqs.length === 0) {
    throw new Error('computeSupportFingerprint: non-empty array required');
  }
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  return createHash('sha256')
    .update(JSON.stringify(sorted), 'utf8')
    .digest('hex')
    .slice(0, 16);
}
