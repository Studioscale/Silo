/**
 * interpret(logReader, asOfSeq?) → State — v12.5 §3.0.
 *
 * The SINGLE function that reads the operation log. Every subsystem (broker,
 * CLI, MCP server) consumes interpret() output. No subsystem reads raw log
 * bytes.
 *
 * Properties:
 *   - Deterministic: same bytes + same as_of_seq → same State.
 *   - Total: every byte sequence produces a State (never throws on malformed
 *     data; surfaces it via skipped[]).
 *   - Non-mutating: only reads.
 *   - Pure: no wall-clock; all time-bearing values come from the log itself.
 *
 * M1 scope: folds event types that affect topic writes, principals, ACL,
 * and dedup. Install-journal + checkpoints + nonce set deferred to M2+.
 */

import { newState } from './state.js';
import { canonicalHash, nfcNormalize } from '../log/canonical.js';
import canonicalize from 'canonicalize';

const DEDUP_WINDOW = 100_000; // v12.5 §8.5 — last 100k entries

/**
 * @param {LogWriter} logReader - anything with async readAll() yielding { entry, ... }
 * @param {Object} [matrix] - Matrix instance (optional; for registry-authoritative flag validation)
 * @param {number} [asOfSeq] - stop folding at this seq (inclusive); defaults to all
 * @returns {Promise<Object>} State
 */
export async function interpret(logReader, matrix = null, asOfSeq = Infinity) {
  const state = newState();

  for await (const { entry, lineNumber, logFile } of logReader.readAll()) {
    if (entry.seq > asOfSeq) break;

    if (!validateEntryShape(entry)) {
      state.skipped.push({
        seq: entry.seq ?? null,
        reason: 'malformed_entry_shape',
        logFile,
        lineNumber,
      });
      continue;
    }

    // Registry-authoritative is_state_bearing check (v12.5 §3.8)
    // For M1 we just trust the log's value; M2 will enforce via matrix.
    if (matrix && matrix.isKnown(entry.type)) {
      const registryFlag = matrix.isStateBearing(entry.type);
      if (entry.is_state_bearing !== registryFlag) {
        // Client-submitted override ignored per v12.5; broker uses registry.
        // Record for audit but still fold the event with the registry interpretation.
        entry.is_state_bearing = registryFlag;
      }
    }

    applyEntry(state, entry);

    state.last_seq = entry.seq;
    state.tail_hash = canonicalHash(entry);
  }

  return state;
}

function validateEntryShape(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.seq !== 'number') return false;
  if (typeof entry.type !== 'string') return false;
  if (typeof entry.hash_prev !== 'string' || entry.hash_prev.length !== 64) return false;
  if (typeof entry.principal !== 'string') return false;
  if (typeof entry.intent_id !== 'string') return false;
  return true;
}

/**
 * Fold a single entry into state.
 * Switch on event type; each handler is small and side-effect-local to state.
 */
function applyEntry(state, entry) {
  // Record in dedup witness set (seq-bound, last DEDUP_WINDOW entries)
  recordDedup(state, entry);

  switch (entry.type) {
    // ── Topic writes ─────────────────────────────────────────────────────
    case 'write_event': {
      applyWriteEvent(state, entry);
      break;
    }

    // ── Identity event family (v12.5 §3.6) ───────────────────────────────
    case 'PRINCIPAL_DECLARED': {
      const { principal, class: cls } = entry.payload;
      if (principal && !state.principals.has(principal)) {
        state.principals.set(principal, {
          class: cls || 'human',
          created_at_seq: entry.seq,
          status: 'declared',
        });
      }
      break;
    }
    case 'PRINCIPAL_UID_BOUND': {
      const { principal, uid } = entry.payload;
      if (principal && typeof uid === 'number') {
        state.uid_principal_bindings.set(uid, principal);
      }
      break;
    }
    case 'PRINCIPAL_UID_UNBOUND': {
      const { uid } = entry.payload;
      if (typeof uid === 'number') {
        state.uid_principal_bindings.delete(uid);
      }
      break;
    }
    case 'PRINCIPAL_KEY_BOUND': {
      const { principal, key_fingerprint } = entry.payload;
      if (principal && key_fingerprint) {
        state.principal_keys.set(principal, key_fingerprint);
      }
      break;
    }
    case 'PRINCIPAL_ACCESS_ENABLED': {
      const { principal } = entry.payload;
      const p = state.principals.get(principal);
      if (p) p.status = 'active';
      break;
    }
    case 'PRINCIPAL_ACCESS_DISABLED': {
      const { principal } = entry.payload;
      const p = state.principals.get(principal);
      if (p) p.status = 'disabled';
      break;
    }
    case 'PRINCIPAL_TOMBSTONE': {
      const { principal } = entry.payload;
      const p = state.principals.get(principal);
      if (p) p.status = 'tombstoned';
      break;
    }

    // ── Feature flags ────────────────────────────────────────────────────
    case 'FEATURE_ACTIVE': {
      const { feature } = entry.payload;
      if (feature) state.feature_flags.add(feature);
      break;
    }
    case 'FEATURE_ROLLED_BACK': {
      const { feature } = entry.payload;
      if (feature) state.feature_flags.delete(feature);
      break;
    }

    // ── ACL (admin-only per v12.5 fix 8) ─────────────────────────────────
    case 'ACL_SEALED': {
      const { topic, readers } = entry.payload;
      if (topic && Array.isArray(readers)) {
        state.acl_table.set(topic, new Set(readers));
      }
      break;
    }

    // ── Topic verification (Jarvis review #5) ────────────────────────────
    case 'TOPIC_VERIFIED': {
      const { topic } = entry.payload;
      if (!topic) break;
      ensureTopicMetaSlot(state, topic, entry.seq, canonicalHash(entry));
      const meta = state.topic_index.get(topic);
      meta.last_verified_seq = entry.seq;
      meta.last_verified_ts = entry.ts;
      break;
    }

    case 'TOPIC_CURATED': {
      const { topic } = entry.payload;
      if (!topic) break;
      ensureTopicMetaSlot(state, topic, entry.seq, canonicalHash(entry));
      const meta = state.topic_index.get(topic);
      meta.last_curated_seq = entry.seq;
      meta.last_curated_ts = entry.ts;
      break;
    }

    case 'TOPIC_METADATA_SET': {
      const { topic, type, tags, entities, status, sensitivity, created, summary, summary_trailing_blank } = entry.payload;
      if (!topic) break;
      ensureTopicMetaSlot(state, topic, entry.seq, canonicalHash(entry));
      const meta = state.topic_index.get(topic);
      // Latest-wins merge; only overwrite fields explicitly present in this event
      if (type !== undefined) meta.topic_type = type;
      if (tags !== undefined) meta.topic_tags = Array.isArray(tags) ? [...tags] : meta.topic_tags;
      if (entities !== undefined) meta.topic_entities = Array.isArray(entities) ? [...entities] : meta.topic_entities;
      if (status !== undefined) meta.topic_status = status;
      if (sensitivity !== undefined) meta.topic_sensitivity = sensitivity;
      if (created !== undefined) meta.topic_created = created;
      if (summary !== undefined) meta.topic_summary = summary;
      if (summary_trailing_blank !== undefined) meta.topic_summary_trailing_blank = summary_trailing_blank;
      break;
    }

    // ── Mode transitions ─────────────────────────────────────────────────
    case 'RECOVERY_MODE_ENTERED': {
      state.current_mode = 'recovery';
      break;
    }
    case 'RECOVERY_MODE_EXITED': {
      state.current_mode = 'normal';
      break;
    }

    // ── Heartbeat / non-state-bearing: skip ──────────────────────────────
    case 'INSTALL_STEP_HEARTBEAT':
      // Non-state-bearing per matrix; no-op
      break;

    // ── All other types: M1 skip + defer to M2/M3 ────────────────────────
    default:
      // Unknown or deferred — state unchanged.
      // Keep minimal; v12.5 unknown-type behavior lives in the admission oracle,
      // not in interpret().
      break;
  }
}

/**
 * Ensure a topic_index slot exists (for events that reference a topic without
 * needing to be a write_event). Used by TOPIC_VERIFIED / TOPIC_CURATED /
 * TOPIC_METADATA_SET which can all precede or follow the first write.
 *
 * Does NOT seed the ACL — ACL is seeded on first write_event so the writer
 * becomes a reader. Metadata-only topics (no writes) have no ACL until a
 * write lands or ACL_SEALED is explicit.
 */
function ensureTopicMetaSlot(state, slug, seq, hash) {
  if (!state.topic_index.has(slug)) {
    state.topic_index.set(slug, {
      slug,
      last_updated_seq: seq,
      tags: new Set(),
      hash,
    });
  }
}

/**
 * Apply a write_event: update topic_index, seed ACL at T1 (creator + operator),
 * record in topic_content.
 */
function applyWriteEvent(state, entry) {
  const { slug, tag, content } = entry.payload;
  if (!slug) return; // malformed payload — M1 skip

  // Merge into existing slot (which may already carry topic_* metadata from
  // prior TOPIC_METADATA_SET / TOPIC_VERIFIED / TOPIC_CURATED events).
  // Do NOT overwrite the whole slot or those fields get lost.
  const meta = state.topic_index.get(slug) ?? {
    slug,
    tags: new Set(),
  };
  if (tag) {
    if (!meta.tags) meta.tags = new Set();
    meta.tags.add(tag);
  }
  meta.last_updated_seq = entry.seq;
  meta.hash = canonicalHash(entry);
  state.topic_index.set(slug, meta);

  // T1 default ACL: creator + operator (for M1; T2 will use tag-keyed defaults)
  if (!state.acl_table.has(slug)) {
    const readers = new Set();
    if (entry.principal) readers.add(entry.principal);
    readers.add('operator'); // T1 always-reader
    state.acl_table.set(slug, readers);
  }

  // Keep a trailing summary for M1 simple reads (M2 memory cards replace this)
  const history = state.topic_content.get(slug) ?? [];
  history.push({
    seq: entry.seq,
    tag: tag || null,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    principal: entry.principal,
    ts: entry.ts,
  });
  state.topic_content.set(slug, history);
}

/**
 * Seq-bound dedup witness set (v12.5 §8.5 — last DEDUP_WINDOW entries).
 */
function recordDedup(state, entry) {
  if (!entry.intent_id) return;

  // Content-bound fingerprint: {principal, type, canonical_payload_hash}
  const payloadStr = canonicalize(nfcNormalize(entry.payload ?? {})) ?? '{}';
  const payloadHash = canonicalHash({ _payload: entry.payload ?? {} });

  state.dedup_witness_set.set(entry.intent_id, {
    seq: entry.seq,
    principal: entry.principal,
    op: entry.type,
    payload_hash: payloadHash,
  });

  // Enforce window size
  while (state.dedup_witness_set.size > DEDUP_WINDOW) {
    const firstKey = state.dedup_witness_set.keys().next().value;
    state.dedup_witness_set.delete(firstKey);
  }
}
