/**
 * Operation log append writer — v12.5 spec §8.5.
 *
 * Single-writer discipline:
 *   - One append at a time (in-process mutex for M1; OS-level flock at T2+ via broker)
 *   - Canonical serialization (NFC + JCS)
 *   - fsync per commit
 *   - Hash chain: each entry's hash_prev = canonicalHash(previousEntry)
 *
 * File layout per v12.5:
 *   .silo/operation-log/YYYY-MM.jsonl
 *   (one log file per month; broker rotates; append is always to the current month's file)
 */

import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { buildEntry, entryHash, serializeEntry, GENESIS_HASH } from './entry.js';
import { canonicalHash } from './canonical.js';
import { validatePayloadForAppend } from '../admission/payload-validators.js';

function currentLogFilename(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}.jsonl`;
}

export class LogWriter {
  /**
   * @param {string} siloDir - base .silo/ directory
   */
  constructor(siloDir) {
    this.siloDir = siloDir;
    this.logDir = join(siloDir, 'operation-log');
    this._lock = Promise.resolve(); // serialization mutex
    this._tail = null; // { seq, hash, logFile } cached tail state
  }

  async init() {
    await fs.mkdir(this.logDir, { recursive: true });
    this._tail = await this._scanTail();
  }

  /**
   * Scan the log directory for the tail. Returns { seq, hash } or null if empty.
   * Cheap because it only reads the last file in the directory.
   */
  async _scanTail() {
    const files = (await fs.readdir(this.logDir))
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort();
    if (files.length === 0) return { seq: 0, hash: GENESIS_HASH };

    const latest = files[files.length - 1];
    const content = await fs.readFile(join(this.logDir, latest), 'utf8');
    if (!content) return { seq: 0, hash: GENESIS_HASH };

    // Split by LF, keep non-empty
    const lines = content.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return { seq: 0, hash: GENESIS_HASH };

    const lastLine = lines[lines.length - 1];
    let entry;
    try {
      entry = JSON.parse(lastLine);
    } catch (err) {
      // Last line is malformed — treat as truncated_tail per v12.5 §4.8.
      // M1: surface this as an error; broker boot-recovery (later) will skip it.
      throw new Error(`tail entry is malformed JSON: ${err.message}`);
    }

    return {
      seq: entry.seq,
      hash: canonicalHash(entry),
      logFile: latest,
    };
  }

  /**
   * Append a new entry to the log.
   * Serializes access (single-writer discipline).
   *
   * @param {Object} args
   * @param {string} args.type
   * @param {boolean} args.isStateBearing - from registry; pass matrix.isStateBearing(type)
   * @param {string} args.intentId - UUIDv7
   * @param {string} args.principal
   * @param {Object} args.payload
   * @param {string} [args.ts]
   * @returns {Promise<{seq: number, hash: string, entry: Object}>}
   */
  async append(args) {
    return this._locked(() => this._doAppend(args));
  }

  async _doAppend({ type, isStateBearing, intentId, principal, payload, ts }) {
    const tail = this._tail ?? { seq: 0, hash: GENESIS_HASH };

    // Phase 2.1: payload admission validation before canonicalize/hash-chain.
    // Currently only TOPIC_BULLETS_RETIRED has admission-time validation;
    // other event types pass through. Throws AdmissionValidationError on
    // failure — bad payloads never land. Test-only paths that need to write
    // malformed events for replay-tolerance tests use
    // test/helpers/append-unsafe.js, which lives outside src/ and is not
    // reachable from production imports.
    validatePayloadForAppend({ type, payload }, { maxKnownSeq: tail.seq });

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

    const logFile = currentLogFilename();
    const path = join(this.logDir, logFile);
    const bytes = serializeEntry(entry);

    // Append + fsync.
    const fh = await fs.open(path, 'a');
    try {
      await fh.write(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }

    const hash = entryHash(entry);
    this._tail = { seq: entry.seq, hash, logFile };
    return { seq: entry.seq, hash, entry };
  }

  /**
   * Serialize access: queue each append behind the previous.
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
   * Return current tail state.
   */
  tail() {
    return this._tail ? { ...this._tail } : null;
  }

  /**
   * Async iterator over all log entries, in order.
   * Yields { entry, rawLine, logFile, lineNumber }.
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
            // Malformed entry — for M1 skip + warn.
            // TODO M2: wire into interpret().skipped[]
            continue;
          }
          yield { entry, rawLine: line, logFile: file, lineNumber };
        }
      }
      // Any leftover buffer is a truncated tail — skip for M1.
    }
  }
}
