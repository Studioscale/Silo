/**
 * TEST-ONLY helper: append an entry to the log without admission validation.
 *
 * Used by interpret-side tests to verify that read-time tolerance
 * (state.skipped) still works on entries that pre-date the admission
 * validator or were crafted bypassing the writer.
 *
 * **DO NOT** import this from src/. It deliberately lives outside the
 * production import tree so there is no production code path that can
 * reach a payload-validator bypass. Phase 2.1 audit (ChatGPT pushback)
 * required this isolation: an underscored method on LogWriter would have
 * been a footgun because JS underscores aren't actually private.
 *
 * Preserves hash-chain integrity and JCS canonicalization. The bypassed
 * step is *only* admission payload validation.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { buildEntry, entryHash, serializeEntry, GENESIS_HASH } from '../../src/log/entry.js';

/**
 * Append an entry to the log without running admission validation.
 *
 * @param {LogWriter} writer - the writer (used for tail + logDir).
 * @param {Object} args - same shape as LogWriter.append({...}).
 * @returns {Promise<{seq: number, hash: string, entry: Object}>}
 */
export async function appendUnsafeForTest(writer, args) {
  const { type, isStateBearing, intentId, principal, payload, ts } = args;
  const tail = writer._tail ?? { seq: 0, hash: GENESIS_HASH };

  const entry = buildEntry({
    type,
    isStateBearing,
    seq: tail.seq + 1,
    hashPrev: tail.hash,
    intentId,
    principal,
    payload,
    ts,
  });

  // Mirror LogWriter's per-month log file naming.
  const date = new Date();
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const logFile = `${yyyy}-${mm}.jsonl`;
  const path = join(writer.logDir, logFile);

  const bytes = serializeEntry(entry);
  const fh = await fs.open(path, 'a');
  try {
    await fh.write(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }

  const hash = entryHash(entry);
  writer._tail = { seq: entry.seq, hash, logFile };
  return { seq: entry.seq, hash, entry };
}
