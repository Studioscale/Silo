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
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { buildEntry, entryHash, serializeEntry, GENESIS_HASH } from './entry.js';
import { canonicalHash } from './canonical.js';
import { validatePayloadForAppend } from '../admission/payload-validators.js';
import { acquireFlock, releaseFlock } from './file-lock.js';
import { interpret } from '../interpret/index.js';
import { loadMatrix } from '../matrix/load.js';
import { AdmissionError } from './admission-error.js';

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
   * Public: append a single entry. Acquires flock + refreshes tail + delegates
   * to _appendUnlocked. Admission validation happens inside the unlocked
   * primitive — wrappers do NOT pre-validate.
   *
   * @param {Object} args - see buildEntry parameters
   * @returns {Promise<{seq: number, hash: string, entry: Object}>}
   */
  async append(args) {
    return this._locked(async () => {
      const handle = await acquireFlock(this.siloDir);
      try {
        this._tail = await this._scanTailUnlocked();
        return await this._appendUnlocked(args);
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
        return await this._appendBatchUnlocked(entries);
      } finally {
        await releaseFlock(handle);
      }
    });
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
   */
  async withAppendLock(asyncFn) {
    return this._locked(async () => {
      const handle = await acquireFlock(this.siloDir);
      try {
        this._tail = await this._scanTailUnlocked();
        const freshState = await interpret(this);
        return await asyncFn({
          writer: this,
          freshTail: this._tail,
          freshState,
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
   * acquire any lock.
   */
  async _appendUnlocked(args) {
    const [result] = await this._appendBatchUnlocked([args]);
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
   */
  async _appendBatchUnlocked(entriesInput) {
    if (!Array.isArray(entriesInput) || entriesInput.length === 0) {
      throw new Error('_appendBatchUnlocked: non-empty array required');
    }
    const tail = this._tail ?? { seq: 0, hash: GENESIS_HASH };

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
