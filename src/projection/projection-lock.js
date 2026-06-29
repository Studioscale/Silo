/**
 * Projection-scoped advisory flock — hybrid-search spec §4.4.
 *
 * The embedding cache is a PROJECTION, written by `silo regenerate`. Spec §4.4
 * requires its writes use a SEPARATE lock, never the append-log lock — so cache
 * rebuilds never contend with (or block) log appends. This mirrors
 * log/file-lock.js's fs-ext degrade-on-missing pattern but targets a different
 * lockfile (`<siloDir>/.locks/projection.lock`) and lives under src/projection/
 * so the sealed log/* core (build-brief §6 "untouched core") is not modified.
 *
 * On platforms without fs-ext (Windows dev) the flock degrades to a no-op; the
 * atomic tmp+rename cache write is still consistent (a concurrent rebuild just
 * last-writer-wins, each writing a complete store).
 */

import { promises as fs, openSync, closeSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';

let fsExt = null;
try {
  fsExt = await import('fs-ext');
} catch {
  fsExt = null;
}

export function getProjectionLockPath(siloDataDir) {
  const envOverride = process.env.SILO_LOCK_DIR;
  if (envOverride) return join(envOverride, 'projection.lock');
  return join(siloDataDir, '.locks', 'projection.lock');
}

export async function acquireProjectionLock(siloDataDir) {
  if (!fsExt) return { fd: null };
  const lockPath = getProjectionLockPath(siloDataDir);
  await fs.mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  let flags = constants.O_CREAT | constants.O_RDWR;
  if (constants.O_NOFOLLOW !== undefined) flags |= constants.O_NOFOLLOW;
  const fd = openSync(lockPath, flags, 0o600);
  try {
    await new Promise((resolve, reject) => {
      fsExt.flock(fd, 'ex', (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    throw err;
  }
  return { fd, path: lockPath };
}

export async function releaseProjectionLock(handle) {
  if (!handle || handle.fd == null) return;
  const { fd } = handle;
  try {
    await new Promise((resolve, reject) => {
      fsExt.flock(fd, 'un', (err) => (err ? reject(err) : resolve()));
    });
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Run fn while holding the projection lock; always releases. */
export async function withProjectionLock(siloDataDir, fn) {
  const handle = await acquireProjectionLock(siloDataDir);
  try {
    return await fn();
  } finally {
    await releaseProjectionLock(handle);
  }
}
