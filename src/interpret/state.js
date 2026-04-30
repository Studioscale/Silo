/**
 * State record returned by interpret() — v12.5 spec §3.0.
 *
 * Every subsystem that needs "current state" consumes this output.
 * No subsystem reads raw log bytes.
 *
 * Deterministic, total, non-mutating.
 *
 * M1 subset: the fields we need for basic write + read + search.
 * Deferred to M2+: install_journal_state, checkpoint pointers,
 *                  principal_nonces, procedure_blobs, tag_schema_active.
 */

export function newState() {
  return {
    tier: 'T1',
    current_mode: 'normal', // 'normal' | 'install_freeze' | 'read_only' | 'recovery'
    feature_flags: new Set(),
    principals: new Map(), // name -> { class, created_at_seq, status }
    uid_principal_bindings: new Map(), // uid -> principal_name
    principal_keys: new Map(), // principal -> key_fingerprint
    acl_table: new Map(), // topic_slug -> Set<principal>
    topic_index: new Map(), // slug -> { slug, last_updated_seq, tags: Set, hash }
    dedup_witness_set: new Map(), // intent_id -> { seq, principal, op, payload_hash }
    topic_content: new Map(), // slug -> array of event summaries (for M1 simple reads)
    last_seq: 0,
    tail_hash: null,
    skipped: [], // [{ seq, reason }]
  };
}

/**
 * Convert Maps/Sets in a State to plain JSON for serialization (e.g., MCP response).
 * Keeps the in-memory state efficient while still being easy to inspect.
 */
export function stateToJson(state) {
  return {
    tier: state.tier,
    current_mode: state.current_mode,
    feature_flags: [...state.feature_flags],
    principals: Object.fromEntries(state.principals),
    uid_principal_bindings: Object.fromEntries(state.uid_principal_bindings),
    principal_keys: Object.fromEntries(state.principal_keys),
    acl_table: Object.fromEntries(
      [...state.acl_table.entries()].map(([slug, readers]) => [slug, [...readers]]),
    ),
    topic_index: Object.fromEntries(
      [...state.topic_index.entries()].map(([slug, meta]) => [
        slug,
        { ...meta, tags: [...meta.tags] },
      ]),
    ),
    dedup_witness_size: state.dedup_witness_set.size,
    last_seq: state.last_seq,
    tail_hash: state.tail_hash,
    skipped: state.skipped,
  };
}
