/**
 * OS-level flock for the operation log — Phase 2.2 §5.1.
 *
 * The in-process mutex inside LogWriter (`_locked`) serializes appends from
 * a single Node process. To prevent two PROCESSES (e.g. the cron-driven
 * silo-detect.sh wrapper running in parallel with an interactive `silo
 * write`) from writing concurrently, the writer additionally acquires an
 * advisory POSIX flock on `<silo-data-dir>/.locks/operation-log.lock`.
 *
 * The flock is implemented via the `fs-ext` native module. On platforms
 * where `fs-ext` fails to build/load (notably Windows without a C++
 * toolchain), this module logs a one-time degraded-mode warning and the
 * acquire/release pair become no-ops. In that case the in-process mutex
 * is still effective, but a second concurrent Node process could violate
 * the single-writer invariant. The acceptable production posture (Helder
 * 2026-05-18) is: Linux production VPS uses real flock; Windows local dev
 * runs single-process and accepts the limitation.
 *
 * Environment override:
 *   SILO_LOCK_DIR  — point the lockfile parent at a tmpfs / separate dir
 *                    (useful for tests and for read-only siloDir mounts).
 */

import { promises as fs, openSync, closeSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';

let fsExt = null;
let fsExtUnavailableReason = null;
try {
  fsExt = await import('fs-ext');
} catch (err) {
  fsExtUnavailableReason = err?.message || String(err);
}

let warnedDegraded = false;
function maybeWarnDegraded() {
  if (warnedDegraded) return;
  warnedDegraded = true;
  console.warn(
    `silo: running in single-process mode — cross-process flock unavailable ` +
      `on this platform (fs-ext load failed: ${fsExtUnavailableReason}). ` +
      `In-process mutex still serializes appends within this process; a ` +
      `second concurrent silo writer in a separate process is NOT safe here.`,
  );
}

export function getLockPath(siloDataDir) {
  const envOverride = process.env.SILO_LOCK_DIR;
  if (envOverride) return join(envOverride, 'operation-log.lock');
  return join(siloDataDir, '.locks', 'operation-log.lock');
}

/**
 * Acquire an exclusive cross-process flock on the operation-log lockfile.
 *
 * Returns a handle `{ fd }` that must be passed back to releaseFlock().
 * On degraded platforms, `fd` is null and releaseFlock is a no-op.
 *
 * @param {string} siloDataDir
 * @returns {Promise<{fd: number|null, path: string|null}>}
 */
export async function acquireFlock(siloDataDir) {
  if (!fsExt) {
    maybeWarnDegraded();
    return { fd: null, path: null };
  }

  const lockPath = getLockPath(siloDataDir);
  await fs.mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  let flags = constants.O_CREAT | constants.O_RDWR;
  // O_NOFOLLOW thwarts symlink-swap attacks on the lockfile. Absent on some
  // platforms (e.g. Windows); skip gracefully there.
  if (constants.O_NOFOLLOW !== undefined) flags |= constants.O_NOFOLLOW;

  const fd = openSync(lockPath, flags, 0o600);
  try {
    await new Promise((resolve, reject) => {
      fsExt.flock(fd, 'ex', (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    throw err;
  }
  return { fd, path: lockPath };
}

export async function releaseFlock(handle) {
  if (!handle || handle.fd == null) return;
  const { fd } = handle;
  try {
    await new Promise((resolve, reject) => {
      fsExt.flock(fd, 'un', (err) => (err ? reject(err) : resolve()));
    });
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/**
 * Test/diagnostic helper. Returns true iff the platform supports OS-level
 * flock via fs-ext. Tests that exercise multi-process flock semantics gate
 * themselves on this.
 */
export function isFlockAvailable() {
  return fsExt !== null;
}
