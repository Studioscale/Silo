#!/usr/bin/env node
/**
 * Detached update-check worker — Phase 2.3 §3.5.
 *
 * Standalone script invoked by `maybeFireUpdateCheck()` as a detached
 * subprocess that survives the parent CLI exiting in <100ms. Re-reads
 * the cache at startup so a second worker that lost the spawn race
 * exits without redundant GitHub calls.
 *
 * Exit codes:
 *   0  — success (cache written, or cache was already fresh)
 *   1  — fetch + write attempted; cache write itself failed
 *   2  — argument error
 *
 * Errors during the fetch itself do NOT exit 1 — they fold into a
 * failure status that performCheck writes to the cache (spec §3.7).
 */

import { parseArgs } from 'node:util';
import {
  performCheck,
  readCache,
  writeCache,
  isOptOut,
  THROTTLE_MS,
} from './update-check.js';

const { values } = parseArgs({
  options: { 'silo-dir': { type: 'string' } },
  strict: false,
  allowPositionals: true,
});

const siloDir = values['silo-dir'];
if (!siloDir) {
  console.error('update-check-worker: --silo-dir required');
  process.exit(2);
}

// Honor opt-out at worker boot too. If the parent forgot to gate the
// spawn (or the env changed between spawn and worker start), bail.
if (isOptOut()) {
  process.exit(0);
}

// Concurrency safety: if another worker won the race and refreshed the
// cache between our spawn and our boot, bail without fetching (round-1
// ChatGPT F3 mitigation).
const prior = await readCache(siloDir);
if (prior?.last_checked_at) {
  const ms = Date.parse(prior.last_checked_at);
  if (Number.isFinite(ms) && Date.now() - ms < THROTTLE_MS) {
    process.exit(0);
  }
}

const status = await performCheck({ prior });
try {
  await writeCache(siloDir, status);
} catch (err) {
  console.error(`update-check-worker: cache write failed: ${err.message}`);
  process.exit(1);
}
process.exit(0);
