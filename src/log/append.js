/**
 * Operation log append writer — v12.5 spec §8.5 + Phase 2.2 §5.
 *
 * Single-writer discipline:
 *   - In-process mutex (`_locked`) — serializes appends within ONE node process.
 *   - OS-level flock (`acquireFlock`) — serializes across processes (cron +
 *     interactive CLI + MCP server can all write safely). On platforms
 *     without fs-ext the flock degrades to a no-op + warning (Windows dev).
 *   - Canonical serialization (NFC + JCS) per entry.
 *   - fsync per commit.
 *   - Hash chain: each entry's hash_prev = canonicalHash(previousEntry).
 *
 * Batch semantics (`_appendBatchUnlocked`, Phase 2.2 §5.4):
 *   - All entries serialize before any disk write.
 *   - Concatenated bytes go to disk via a SHORT-WRITE-TOLERANT write loop,
 *     followed by a single fsync.
 *   - Recovery model is "replay-safe prefix recovery", NOT atomic. A crash
 *     mid-write leaves a valid prefix; the tolerant `_scanTailUnlocked`
 *     discards any malformed trailing bytes on next init.
 *
 * Admission validation invariant (Phase 2.2 §5.2):
 *   - `_appendUnlocked` / `_appendBatchUnlocked` call validatePayloadForAppend()
 *     per entry, BEFORE serialization/hashing. Public wrappers do NOT
 *     pre-validate. Single source of truth.
 *
 * File layout per v12.5:
 *   <silo>/operation-log/YYYY-MM.jsonl   (one file per month; rotates at append time)
 *   <silo>/.locks/operation-log.lock     (flock target; created lazily)
 */

import { promises as fs } from 'node:fs';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { buildEntry, entryHash, serializeEntry, GENESIS_HASH } from './entry.js';
import { canonicalHash } from './canonical.js';
import { validatePayloadForAppend } from '../admission/payload-validators.js';
import { acquireFlock, releaseFlock } from './file-lock.js';
import { interpret, foldStream } from '../interpret/index.js';
import { newState } from '../interpret/state.js';
import { loadMatrix } from '../matrix/load.js';
import { AdmissionError } from './admission-error.js';
import { buildAdmissionContext, guardSlugExistence, deriveWriteAdmissible } from '../admission/slug-existence.js';

// Non-empty sentinel for a sealed-admissible slug in the combined admission
// view (deriveWriteAdmissible only checks `history.length > 0`; values are never
// read off that view). Frozen + shared — never mutated.
const ADMISSIBLE_SENTINEL = Object.freeze([true]);

// Sealed month files are opened O_NOFOLLOW so a symlink month file is refused
// (open throws ELOOP) rather than silently followed — the fingerprint then
// certifies the exact inode folded (fstat on the same handle), not a path. On
// platforms without O_NOFOLLOW (Windows) the `|| 0` degrades it to a no-op and
// the lstat regular-file guard still refuses symlinks / a stale cache.
const O_RDONLY_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);

// Matrix oracle — process-singleton. Loaded once at module init; tests that
// need a fresh matrix can pass a custom path through future API extensions
// (out of scope for M3 — the matrix is static during a run).
const MATRIX = loadMatrix();

const SHORT_WRITE_MAX_RETRIES = 5;
const SHORT_WRITE_RETRY_BASE_MS = 10;

function currentLogFilename(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}.jsonl`;
}

/**
 * fs.write may return bytesWritten < requested for large writes on some
 * platforms. Loop until everything lands; bounded retries when the kernel
 * returns 0 (rare, indicates pressure rather than EOF).
 */
async function writeFully(fh, buffer) {
  let offset = 0;
  let retries = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fh.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) {
      retries += 1;
      if (retries >= SHORT_WRITE_MAX_RETRIES) {
        throw new Error(
          `silo: short write — ${SHORT_WRITE_MAX_RETRIES} retries exhausted at offset ${offset}/${buffer.length}`,
        );
      }
      await new Promise((r) => setTimeout(r, SHORT_WRITE_RETRY_BASE_MS * retries));
    } else {
      offset += bytesWritten;
      retries = 0;
    }
  }
}

export class LogWriter {
  /**
   * @param {string} siloDir - base .silo/ directory
   */
  constructor(siloDir) {
    this.siloDir = siloDir;
    this.logDir = join(siloDir, 'operation-log');
    this._lock = Promise.resolve(); // in-process serialization mutex
    this._tail = null; // { seq, hash, logFile? } cached tail state
    this._truncatedTailWarned = new Set(); // dedup tolerant-scan warnings
    // Incremental admission cache (perf, see _freshAdmissionState). `_admSealed`
    // is the folded-once projection of the SEALED (older-than-active) months —
    // {admissible slug set, boundary anchorHash, lastSeq, per-file
    // (size,mtimeMs,ctimeMs,ino,dev) fingerprints, activeMonth}; reused while
    // those files are byte-stable. The ACTIVE month is re-folded every call (to
    // re-verify its chain), so it is never cached here. `_admStateMonth` is the
    // active (tail) month — info only.
    this._admSealed = null;
    this._admStateMonth = null;
  }

  async init() {
    await fs.mkdir(this.logDir, { recursive: true });
    this._tail = await this._scanTailUnlocked();
  }

  /**
   * Tolerant tail scan — walks backward from the newest log file's last line
   * to the last syntactically-valid entry. Anything past that is the
   * truncated tail (recoverable per Phase 2.2 §5.4); we log a single warning
   * per (file, byte-count) pair and proceed with the last valid seq/hash.
   *
   * NOTE: must be called with the flock already held (or before init() races
   * could matter). Public API callers (`append`, `batchAppend`,
   * `withAppendLock`) acquire the flock first and then refresh tail via this
   * function to catch any appends another process committed while we waited.
   */
  async _scanTailUnlocked() {
    let files;
    try {
      files = (await fs.readdir(this.logDir))
        .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
        .sort();
    } catch (err) {
      if (err.code === 'ENOENT') return { seq: 0, hash: GENESIS_HASH };
      throw err;
    }
    if (files.length === 0) return { seq: 0, hash: GENESIS_HASH };

    // Walk newest → oldest. Within a file, walk lines bottom-up to find the
    // last syntactically-valid entry. All-corrupt latest file falls back to
    // the previous file (rare, but matches readAll()'s spirit).
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i];
      const content = await fs.readFile(join(this.logDir, file), 'utf8');
      if (!content) continue;
      const lines = content.split('\n').filter((l) => l.length > 0);
      let droppedBytes = 0;
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j];
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          droppedBytes += Buffer.byteLength(line, 'utf8') + 1;
          continue;
        }
        if (typeof entry?.seq !== 'number' || entry.seq < 1) {
          droppedBytes += Buffer.byteLength(line, 'utf8') + 1;
          continue;
        }
        if (droppedBytes > 0) this._warnTruncatedTailOnce(file, droppedBytes);
        return {
          seq: entry.seq,
          hash: canonicalHash(entry),
          logFile: file,
        };
      }
      // No valid lines at all in this file — warn, fall through to previous.
      if (lines.length > 0) {
        this._warnTruncatedTailOnce(file, Buffer.byteLength(content, 'utf8'));
      }
    }
    return { seq: 0, hash: GENESIS_HASH };
  }

  _warnTruncatedTailOnce(file, bytes) {
    const key = `${file}:${bytes}`;
    if (this._truncatedTailWarned.has(key)) return;
    this._truncatedTailWarned.add(key);
    console.warn(
      `silo: tolerant tail scan discarded ${bytes} truncated bytes in ${file}`,
    );
  }

  /**
   * Public: append a single entry. Acquires flock + refreshes tail + builds the
   * lock-scoped admission context (slug-existence guard, v0.2.5) + delegates to
   * _appendUnlocked. Admission validation happens inside the unlocked primitive
   * — wrappers do NOT pre-validate.
   *
   * @param {Object} args - see buildEntry parameters
   * @returns {Promise<{seq: number, hash: string, entry: Object}>}
   */
  async append(args) {
    return this._locked(async () => {
      const handle = await acquireFlock(this.siloDir);
      try {
        this._tail = await this._scanTailUnlocked();
        const admissionContext = await this._freshAdmissionContext();
        return await this._appendUnlocked(args, admissionContext);
      } finally {
        await releaseFlock(handle);
      }
    });
  }

  /**
   * Public: append an array of entries atomically (single concatenated write
   * + fsync). Used by accept_suggestion for the metadata + accept pair.
   *
   * @param {Array<Object>} entries
   * @returns {Promise<Array<{seq, hash, entry}>>}
   */
  async batchAppend(entries) {
    return this._locked(async () => {
      const handle = await acquireFlock(this.siloDir);
      try {
        this._tail = await this._scanTailUnlocked();
        const admissionContext = await this._freshAdmissionContext();
        return await this._appendBatchUnlocked(entries, admissionContext);
      } finally {
        await releaseFlock(handle);
      }
    });
  }

  /**
   * Build the ephemeral, lock-scoped admission context for a bare public append
   * (slug-existence guard, v0.2.5 §4.2 / R4-MAJOR-1). MUST be called with the
   * flock held and the tail freshly rescanned — folds the log ONCE here so the
   * guard never re-folds per entry (the O(N²) trap). `withAppendLock` callers
   * build the context from their EXISTING freshState instead (no double-fold).
   */
  async _freshAdmissionContext() {
    return buildAdmissionContext(await this._freshAdmissionState());
  }

  /**
   * Fold the log to the State the admission context needs (last_seq + the topic
   * maps deriveWriteAdmissible reads), under the flock — without re-folding the
   * WHOLE log on every append (the O(writes × log-size) trap).
   *
   * PERF: only the ACTIVE (newest) month-file is folded each call; every OLDER
   * ("sealed") month is folded ONCE into a lightweight projection (its
   * write-admissible slug set + the chain hash at its boundary + a per-file
   * (size,mtime) fingerprint) and reused while those files are byte-stable. Cost
   * per append is O(active month) + O(#sealed files) stats, not O(whole log).
   *
   * CORRECTNESS — this is the rev-3 fix for gauntlet CRITICAL #2. The prior
   * "seq + tail-hash" accept condition was NOT a certificate of the folded
   * prefix: canonicalHash(tail) binds only the tail entry's own bytes (its
   * hash_prev is stored DATA, not a re-verified link), so a restore/rewrite of
   * an already-folded prefix that left the tail line byte-for-byte intact passed
   * the check and served the ERASED timeline. The fix re-PROVES the prefix
   * instead of inferring it:
   *
   *   - the ACTIVE month is RE-FOLDED from the sealed anchor every call (reusing
   *     interpret()'s `foldStream`), so any rewrite of its already-folded prefix
   *     breaks the chain exactly as a full fold would — NO residual on the active
   *     month;
   *   - SEALED months are append-only-frozen; each is folded from an O_NOFOLLOW
   *     handle and fingerprinted `(size,mtimeMs,ctimeMs,ino,dev)` by fstat on that
   *     SAME handle (so the fingerprint certifies the exact inode+bytes folded —
   *     symlink/path swaps are irrelevant, non-regular files are refused), re-stat'd
   *     (lstat) each call; any change ⇒ rebuild. On ext4 (prod) ctime closes the
   *     same-size+mtime-forge case (NOT a cross-platform guarantee — see the
   *     _statFingerprint helper below for the FS-scoped residual).
   *
   * Equivalence to a full fold holds by construction: foldStream is the single
   * fold path, and deriveWriteAdmissible distributes over the split
   * (admissible(sealed++active) = admissible(sealed) ∪ admissible(active)); the
   * combined last_seq is the active tail (or the sealed tail if the active month
   * is empty/orphaned), so the §4.2 tail-safety gate trips identically.
   *
   * Must be called with the flock held and `this._tail` freshly rescanned.
   */
  async _freshAdmissionState() {
    const files = await this._listMonthFiles();
    if (files.length === 0) {
      // Empty/degenerate log — a full fold is already O(0). Drop any cache.
      this._admSealed = null;
      this._admStateMonth = null;
      return interpret(this);
    }
    const activeMonth = files[files.length - 1];
    const sealedFiles = files.slice(0, -1);
    this._admStateMonth = activeMonth; // informational (the tail's month-file)

    // (1) Sealed projection: reuse while the active month is unchanged and every
    //     sealed file is byte-stable; else (re)build it (rare — month rollover,
    //     or an external rewrite/restore of a sealed month).
    let sealed = this._admSealed;
    if (!(sealed
          && sealed.activeMonth === activeMonth
          && sealed.files.size === sealedFiles.length
          && await this._sealedFingerprintsMatch(sealed.files))) {
      sealed = await this._buildSealedProjection(sealedFiles, activeMonth);
      if (sealed === null) {
        // The sealed months wouldn't settle across the fold (an in-flight
        // restore raced the rebuild — CRITICAL #3). Do the authoritative full
        // fold for this call and cache nothing that might mix timelines.
        this._admSealed = null;
        return interpret(this);
      }
      this._admSealed = sealed;
    }

    // (2) Re-fold the active month-file fresh from the sealed anchor — this is
    //     what re-verifies the active chain each call (closes CRITICAL #2 for
    //     the active month with no residual).
    const activeState = await this._foldFiles([activeMonth], sealed.anchorHash);

    // (3) Combine. last_seq is the active tail, or the sealed tail when the
    //     active month folded nothing (empty, or its head orphaned by a break).
    // `||` (NOT `??`) is deliberate and load-bearing: seqs are 1-INDEXED
    // (newState().last_seq = 0; first real seq is 1), so activeState.last_seq===0
    // means "the active month folded nothing" — exactly when the sealed tail is
    // the right last_seq. `??` would keep 0 and falsely trip the §4.2 gate.
    const lastSeq = activeState.last_seq || sealed.lastSeq;
    const tailHash = activeState.tail_hash ?? sealed.anchorHash;
    return this._combinedAdmissionView(sealed.admissible, activeState, lastSeq, tailHash);
  }

  /** Sorted month-files in the log dir (ENOENT → none). */
  async _listMonthFiles() {
    try {
      return (await fs.readdir(this.logDir))
        .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
        .sort();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Pure per-file fingerprint from a Stats object: `(size, mtimeMs, ctimeMs,
   * ino, dev)`.
   *   - size + mtime catch the common append/rewrite;
   *   - ctimeMs (inode change-time) closes the mtime-forge residual — `touch`/
   *     `utimensat` can set mtime but the act of setting it bumps ctime, and any
   *     content write bumps ctime, so a size+mtime-preserving rewrite is caught
   *     on ext4 (prod);
   *   - ino + dev catch a sealed file replaced via rename (rsync default: temp +
   *     rename → new inode) or inode-number reuse across devices.
   * ext4 (the prod target) is where ctime is the REAL guard: an in-place
   * same-size rewrite bumps ctime, closing the same-size+mtime-forge case. This
   * is NOT a cross-platform guarantee — on other FSes (e.g. NTFS) ctime/ino may
   * not move under an in-place same-size rewrite, so THERE that specific
   * adversarial rewrite is a residual. What holds on EVERY platform: symlink/path
   * swaps are closed by construction (fstat-on-fd + the lstat regular-file
   * refusals), and the active month is re-folded every call. Overall residual
   * (ext4): an attacker who can forge the inode change-time / clock — one who
   * already owns the box (out of the single-host threat model).
   */
  _statFingerprint(st) {
    return { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, dev: st.dev };
  }

  _fingerprintEq(a, b) {
    return !!b && a.size === b.size && a.mtimeMs === b.mtimeMs
      && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev;
  }

  /**
   * True iff every fingerprinted sealed file is still a REGULAR file with the
   * same fingerprint. `lstat` (not stat) so a month file swapped for a SYMLINK is
   * refused (isFile() false) rather than followed — pairs with the O_NOFOLLOW +
   * fstat-on-fd binding in _foldSealedOnce.
   */
  async _sealedFingerprintsMatch(recorded) {
    for (const [file, fp] of recorded) {
      let st;
      try {
        st = await fs.lstat(join(this.logDir, file));
      } catch {
        return false; // sealed file vanished → invalidate
      }
      // `lstat().isFile()` is the SOLE symlink defense on the reuse path AND on
      // platforms where O_NOFOLLOW no-ops (Windows) — a month file swapped for a
      // symlink is refused here, never followed. Do not weaken it in a refactor.
      if (!st.isFile()) return false; // symlink / non-regular → never trust the cache
      if (!this._fingerprintEq(fp, this._statFingerprint(st))) return false;
    }
    return true;
  }

  /**
   * Fold the sealed (older-than-active) months once into a lightweight
   * projection: their write-admissible slug set, the chain hash at the boundary,
   * the last sealed seq, and a per-file fingerprint. The heavy folded State is
   * discarded — only the slug SET admission needs is kept.
   *
   * Retries the atomic fold (below) on an in-flight change; returns null after
   * MAX_ATTEMPTS or on a non-regular month file → the caller does an
   * authoritative full fold for this call and caches nothing.
   */
  async _buildSealedProjection(sealedFiles, activeMonth) {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await this._foldSealedOnce(sealedFiles);
      if (result === 'retry') continue;
      if (result === null) return null; // non-regular / anomalous → refuse to cache
      return { ...result, activeMonth };
    }
    return null; // wouldn't settle across the fold — caller full-folds, caches nothing
  }

  /**
   * One atomic sealed fold, binding the fingerprint to the EXACT inode folded
   * (CRITICAL #3 + #4 fix). For each sealed month file: open O_NOFOLLOW (a
   * symlink → ELOOP → refuse), fstat the handle BEFORE, fold FROM that handle,
   * fstat AFTER — so both the certified stat and the folded bytes come from the
   * IDENTICAL inode; a symlink/path swap is irrelevant by construction, and an
   * in-place rewrite during the fold shows in the after-fstat. A final lstat
   * confirms the path still resolves to that regular inode (no rename swap). Any
   * inconsistency → 'retry'; a non-regular file → null (refuse). The whole set is
   * bracketed (open + fstat-before ALL, fold ALL, fstat/lstat-after ALL) so a
   * late rewrite of an earlier file is caught too.
   */
  async _foldSealedOnce(sealedFiles) {
    // ALL sealed handles are opened up front (before ANY fold) deliberately: the
    // before/after fstat must bracket the whole set at once so a LATE rewrite of
    // an earlier file is caught — chunking (open+fold+close one file at a time)
    // would reopen a TOCTOU window between files. The count is bounded (~#months,
    // ~12/yr), well under the fd limit; if `fs.open` ever hits EMFILE it throws
    // into the catch below → null → the caller does a full fold (fail-safe).
    const handles = [];
    try {
      const before = new Map();
      for (const f of sealedFiles) {
        let fh;
        try {
          fh = await fs.open(join(this.logDir, f), O_RDONLY_NOFOLLOW);
        } catch {
          return null; // ELOOP (symlink) / EMFILE / missing → refuse to cache, full-fold
        }
        handles.push({ f, fh });
        const st = await fh.stat();
        if (!st.isFile()) return null; // non-regular → refuse
        before.set(f, st);
      }

      const state = newState();
      let prevHash = GENESIS_HASH;
      for (const { f, fh } of handles) {
        prevHash = await foldStream(state, this._readHandle(fh, f), { prevHash });
      }

      const files = new Map();
      for (const { f, fh } of handles) {
        const after = await fh.stat();
        if (!after.isFile()) return 'retry';
        // content stable during the fold (in-place rewrite → mtime/ctime/size move)
        if (!this._fingerprintEq(this._statFingerprint(before.get(f)), this._statFingerprint(after))) return 'retry';
        // path still resolves to the exact inode we folded (no rename/symlink swap).
        // NB: `lst.isFile()` here is the SOLE symlink defense where O_NOFOLLOW
        // no-ops (Windows) — the open above then followed the link, so this lstat
        // is what refuses it. Do not weaken it in a refactor.
        let lst;
        try {
          lst = await fs.lstat(join(this.logDir, f));
        } catch {
          return 'retry';
        }
        if (!lst.isFile() || lst.ino !== after.ino || lst.dev !== after.dev) return 'retry';
        files.set(f, this._statFingerprint(after));
      }
      return {
        admissible: deriveWriteAdmissible(state),
        anchorHash: state.tail_hash ?? GENESIS_HASH,
        lastSeq: state.last_seq,
        files,
      };
    } finally {
      for (const { fh } of handles) { try { await fh.close(); } catch { /* best-effort */ } }
    }
  }

  /**
   * Like _readFiles, but reads from an already-open O_NOFOLLOW FileHandle (the
   * sealed path, where the fingerprint must be bound to this exact inode). Drops
   * a trailing newline-less line, matching readAll()/_readFiles/_scanTailUnlocked
   * — do NOT flush it (that would fold a line the full fold drops → divergence).
   */
  async *_readHandle(fh, file) {
    const stream = fh.createReadStream({ encoding: 'utf8', autoClose: false, start: 0 });
    let buffer = '';
    let lineNumber = 0;
    for await (const chunk of stream) {
      buffer += chunk;
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        lineNumber += 1;
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        yield { entry, logFile: file, lineNumber };
      }
    }
  }

  /** Fold the given month-files (in order) from `prevHash` into a fresh State. */
  async _foldFiles(files, prevHash) {
    const state = newState();
    await foldStream(state, this._readFiles(files), { prevHash });
    return state;
  }

  /** Like readAll(), but only over the given month-files, in order. */
  async *_readFiles(files) {
    for (const file of files) {
      const full = join(this.logDir, file);
      const stream = createReadStream(full, { encoding: 'utf8' });
      let buffer = '';
      let lineNumber = 0;
      for await (const chunk of stream) {
        buffer += chunk;
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          lineNumber += 1;
          if (!line) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          yield { entry, logFile: file, lineNumber };
        }
      }
    }
  }

  /**
   * Build the State object admission consumes from the sealed∪active split.
   * deriveWriteAdmissible reads topic_content (length>0) + topic_index
   * (topic_type); we union the sealed-admissible slugs (as non-empty sentinels)
   * with the freshly folded active state's real maps — O(#topics), not
   * O(entries). Only last_seq + deriveWriteAdmissible are read downstream (by
   * buildAdmissionContext + the equivalence tests); content/values are never
   * read off this view, so the sentinels are safe.
   */
  _combinedAdmissionView(sealedAdmissible, activeState, lastSeq, tailHash) {
    const topic_content = new Map();
    for (const slug of sealedAdmissible) topic_content.set(slug, ADMISSIBLE_SENTINEL);
    for (const [slug, history] of activeState.topic_content) topic_content.set(slug, history);
    return {
      last_seq: lastSeq,
      tail_hash: tailHash,
      topic_content,
      topic_index: activeState.topic_index,
      skipped: activeState.skipped,
    };
  }

  /**
   * Public: run an async function while holding the flock + in-process mutex
   * and with a fresh interpret() snapshot. The callback receives
   * { writer, freshTail, freshState } and is expected to call
   * `writer._appendUnlocked` / `_appendBatchUnlocked` for any appends —
   * calling `writer.append` from inside would re-enter `_locked()` and
   * deadlock.
   *
   * Used by MCP `accept_suggestion` / `dismiss_suggestion` to re-validate
   * suggestion state under the lock before committing the batch.
   *
   * The callback also receives `admissionContext` — the lock-scoped
   * slug-existence context (v0.2.5) built ONCE from this session's freshState
   * (no second fold). Callers that append must forward it to
   * `_appendBatchUnlocked` so write_events are guarded and every append passes
   * the session-level tail-safety gate.
   */
  async withAppendLock(asyncFn) {
    return this._locked(async () => {
      const handle = await acquireFlock(this.siloDir);
      try {
        this._tail = await this._scanTailUnlocked();
        const freshState = await interpret(this);
        const admissionContext = buildAdmissionContext(freshState);
        return await asyncFn({
          writer: this,
          freshTail: this._tail,
          freshState,
          admissionContext,
        });
      } finally {
        await releaseFlock(handle);
      }
    });
  }

  /**
   * Single-entry primitive. Internal/test use only — callers inside
   * `withAppendLock` may use this directly to avoid re-entering the lock.
   * Validates payload, builds entry, persists, updates tail. Does NOT
   * acquire any lock. `admissionContext` (v0.2.5) is forwarded to the batch
   * primitive — required for a write_event, see `_appendBatchUnlocked`.
   */
  async _appendUnlocked(args, admissionContext = null) {
    const [result] = await this._appendBatchUnlocked([args], admissionContext);
    return result;
  }

  /**
   * Batch primitive. All entries validate + serialize + hash-chain in
   * memory; then a single fs.write + fsync persists them. On crash mid-
   * write, the file is recoverable via tolerant _scanTailUnlocked (any
   * partial trailing line is dropped).
   *
   * Inside a batch:
   *   - hash_prev of entry N (N>0) = canonicalHash(entry N-1)
   *   - validatePayloadForAppend sees maxKnownSeq = tail.seq + stagedCount,
   *     so retire-style payloads cannot reference entries staged in the
   *     SAME batch (only entries previously persisted).
   *
   * `admissionContext` (v0.2.5, slug-existence guard) is the ephemeral
   * lock-scoped context built by the public entrypoints / `withAppendLock`.
   * When supplied it enforces, under the same lock:
   *   - the session-level TAIL-SAFETY GATE (spec §4.2/G8/build-note #2):
   *     refuse if the physical tail seq != the folded last_seq — a broken
   *     physical tail an append would silently orphan onto. Generalizes
   *     `silo retire`'s per-op gate to EVERY append (write_event AND
   *     TOPIC_METADATA_SET), so topic creation can't orphan either.
   *   - the per-entry SLUG-EXISTENCE GUARD (§4.1-§4.3): a write_event is
   *     admitted only to a reserved sink / write-admissible / intra-batch-
   *     staged slug. A write_event with NO context is rejected (G2).
   */
  async _appendBatchUnlocked(entriesInput, admissionContext = null) {
    if (!Array.isArray(entriesInput) || entriesInput.length === 0) {
      throw new Error('_appendBatchUnlocked: non-empty array required');
    }
    const tail = this._tail ?? { seq: 0, hash: GENESIS_HASH };

    // ── TAIL-SAFETY GATE (spec §4.2/G8/build-note #2) ──
    // Session/append-level. `_scanTailUnlocked` is hash-chain-BLIND: it returns
    // the last syntactically-valid line as the physical tail, and a new append
    // chains onto THAT. If the physical tail is itself broken/malformed,
    // interpret() skipped it AND would skip our new append (which chains onto
    // the skipped tail) — silently orphaning the write while we return success.
    // context.stateSeq is the last FOLDED seq; tail.seq is the physical tail
    // seq. They are equal iff interpret accepted the physical tail; they differ
    // ONLY on a broken/unfolded tail — never on a historical MIDDLE break
    // (those re-sync, the tail stays folded). Mirrors retire's gate exactly.
    // Seq-compare, NOT hash-compare (tail_hash inits null vs GENESIS_HASH on an
    // empty log, so a hash form would false-positive at genesis; the integer
    // form degrades to 0 === 0). Inert on a healthy tail.
    if (admissionContext && tail.seq !== admissionContext.stateSeq) {
      throw new AdmissionError('LOG_TAIL_NOT_INTERPRETABLE', {
        last_seq: admissionContext.stateSeq,
        tail_seq: tail.seq,
      });
    }

    const staged = []; // [{ entry, bytes, hash }]
    for (let i = 0; i < entriesInput.length; i++) {
      const input = entriesInput[i];
      const { type, isStateBearing, intentId, principal, payload, ts, socket, mode } = input;

      // M3 — Matrix admission gate. Runs BEFORE payload validation so
      // unauthorized callers don't get payload-shape feedback for events
      // they were never allowed to emit. See proposals/m3-admission-gate.md
      // §3.2. socket/mode are writer-control metadata, not persisted —
      // they're consumed here and never reach buildEntry().
      const socketOrDefault = socket ?? 'standard';
      if (mode != null && mode !== 'normal') {
        throw new AdmissionError('INVALID_WRITER_MODE', {
          type, socket: socketOrDefault, mode,
          reason: 'broker modes are reserved; M3 only accepts mode="normal" or absent',
        });
      }
      if (!MATRIX.isKnown(type)) {
        throw new AdmissionError('UNKNOWN_EVENT_TYPE_NOT_REGISTERED', { type });
      }
      if (socketOrDefault !== 'standard' && socketOrDefault !== 'admin') {
        // Matrix.isAdmissible would throw on this — catch it as a structured
        // error rather than letting the generic Error propagate.
        throw new AdmissionError('EVENT_NOT_ADMISSIBLE', {
          type, socket: socketOrDefault, mode: 'normal',
          reason: `invalid socket: ${JSON.stringify(socketOrDefault)}`,
        });
      }
      if (!MATRIX.isAdmissible(type, socketOrDefault, 'normal')) {
        throw new AdmissionError('EVENT_NOT_ADMISSIBLE', {
          type, socket: socketOrDefault, mode: 'normal',
        });
      }

      // maxKnownSeq is FROZEN to tail.seq for the whole batch — entries
      // cannot reference seqs staged earlier in this same batch, only
      // entries already persisted (Phase 2.2 §5.2 + payload-validators.js
      // "Batch-append note"). This is what makes retire-style payloads
      // safe under batch semantics.
      validatePayloadForAppend(
        { type, payload },
        { maxKnownSeq: tail.seq },
      );

      // ── SLUG-EXISTENCE GUARD (v0.2.5, spec §4.1-§4.3) ──
      // Beside the matrix gate (throws AdmissionError). Runs AFTER payload
      // validation so a malformed slug surfaces its precise shape error first.
      // Admits a write_event only to a reserved sink / write-admissible /
      // intra-batch-staged slug; a TOPIC_METADATA_SET(type) stages its slug for
      // later same-batch writes. Processing entries in order makes staging
      // causal (a creation earlier in the batch admits a write later in it).
      guardSlugExistence({ type, payload }, admissionContext);

      const hashPrev = i === 0 ? tail.hash : staged[i - 1].hash;
      const entry = buildEntry({
        type,
        isStateBearing,
        seq: tail.seq + i + 1,
        hashPrev,
        intentId,
        principal,
        payload,
        ts,
      });
      const bytes = serializeEntry(entry);
      const hash = entryHash(entry);
      staged.push({ entry, bytes, hash });
    }

    const totalBytes = Buffer.concat(staged.map((s) => s.bytes));
    const logFile = currentLogFilename();
    const path = join(this.logDir, logFile);

    const fh = await fs.open(path, 'a');
    try {
      await writeFully(fh, totalBytes);
      await fh.sync();
    } finally {
      await fh.close();
    }

    const last = staged[staged.length - 1];
    this._tail = { seq: last.entry.seq, hash: last.hash, logFile };

    return staged.map((s) => ({
      seq: s.entry.seq,
      hash: s.hash,
      entry: s.entry,
    }));
  }

  /**
   * In-process serialization mutex. Each call to a public write method
   * waits for the previous one to settle before proceeding.
   */
  async _locked(fn) {
    const prev = this._lock;
    let resolveNext;
    this._lock = new Promise((r) => (resolveNext = r));
    try {
      await prev;
      return await fn();
    } finally {
      resolveNext();
    }
  }

  /**
   * Return current tail state ({seq, hash, logFile?} or null before init).
   */
  tail() {
    return this._tail ? { ...this._tail } : null;
  }

  /**
   * Async iterator over all log entries, in order.
   * Yields { entry, rawLine, logFile, lineNumber }.
   * Tolerates malformed lines (skip + warn-once via interpret state.skipped).
   */
  async *readAll() {
    const files = (await fs.readdir(this.logDir))
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort();

    for (const file of files) {
      const full = join(this.logDir, file);
      const stream = createReadStream(full, { encoding: 'utf8' });

      let buffer = '';
      let lineNumber = 0;
      for await (const chunk of stream) {
        buffer += chunk;
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          lineNumber += 1;
          if (!line) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            // Malformed entry — surfaced via interpret().skipped[] when
            // entry.seq is missing; see validateEntryShape there.
            continue;
          }
          yield { entry, rawLine: line, logFile: file, lineNumber };
        }
      }
      // Any leftover buffer is a truncated tail — recovered by
      // _scanTailUnlocked on next init.
    }
  }
}
