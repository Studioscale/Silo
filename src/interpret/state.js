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
    retired_curated_seqs: new Set(), // seq numbers of CURATED write_events superseded by TOPIC_BULLETS_RETIRED

    // ── Phase 2.2 topic-proposal slots (§3) ─────────────────────────────────
    // Map<seq, {seq, slug, name, description, supporting_seqs, rationale, ts,
    //          source, status: 'pending'|'accepted'|'dismissed',
    //          resolved_at, resolved_by_seq, accepted_slug}>
    topic_suggestions: new Map(),
    // Set<seq>
    pending_topic_suggestion_seqs: new Set(),
    // Map<accepted_slug, suggestion_seq> — for bootstrap (raw slug → suggestion seq).
    accepted_topic_suggestion_by_slug: new Map(),
    // Map<normalized_slug, Array<{suggestion_seq, source_dismissal_seq,
    //   dismissed_at, cooldown_days, until_ts, support_fingerprint,
    //   reason, cleared_by_accept_seq}>>
    // Append-only history; one entry per (dismissal, suggestion_seq) pair.
    dismissed_topic_suggestion_history: new Map(),
    // DERIVED VIEW: computed during interpret() finalization from history.
    // Map<normalized_slug, {source_dismissal_seq, until_ts, cleared_by_accept_seq}>
    cooldowns_by_normalized_slug: new Map(),
    // Map<seq, {slug, tag, content, ts, source, principal}> — every write_event,
    // by seq, for cross-slug accept-time semantic re-validation + bootstrap
    // event lookup.
    seq_to_event: new Map(),

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
    retired_curated_seqs: [...state.retired_curated_seqs].sort((a, b) => a - b),
    // Phase 2.2: surface counts only (full maps stay opaque to debug output).
    topic_suggestions_total: state.topic_suggestions.size,
    pending_topic_suggestion_count: state.pending_topic_suggestion_seqs.size,
    active_cooldown_count: state.cooldowns_by_normalized_slug.size,
    last_seq: state.last_seq,
    tail_hash: state.tail_hash,
    skipped: state.skipped,
  };
}
