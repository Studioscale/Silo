/**
 * Bootstrap contract — Stage 2 of the universal-client compatibility work.
 *
 * Returns the structured contract a fresh MCP client (e.g., ChatGPT) reads
 * ONCE to learn Silo's memory model, retrieval rules, write policy, and tool
 * catalog. Replaces the visibility CLAUDE.md gives Claude Code: generic MCP
 * clients have no per-project bootstrap file, so the rules travel with the
 * server itself.
 *
 * Pure-data helpers — no MCP SDK / fs imports — so the silo workspace test
 * runner can exercise the module without silo-mcp/node_modules locally.
 * Mirrors the pattern in silo-mcp/notices.js and silo-mcp/fetch.js.
 *
 * Contract versioning (see proposals/universal-client-protocol.md):
 *   - additive extensions (new fields, new tools)            → minor bump
 *   - field removals / type changes / rule renames           → major bump
 *   - capabilities block names what THIS instance supports;
 *     contract_version names the SHAPE the consumer should expect.
 */

export const CONTRACT_VERSION = '1.0';

/**
 * Build the bootstrap contract. Pure function — no I/O, deterministic shape.
 * Stage 2 returns a fixed contract; future revisions may surface per-instance
 * feature flags (e.g., whether the operation log is matrix-routed).
 *
 * @returns {Object} contract envelope — return both as structuredContent
 *                   AND JSON-encoded in content[0].text per OpenAI MCP guidance.
 */
export function buildBootstrapContract() {
  return {
    system: 'Silo',
    purpose: 'Structured long-term memory for AI assistants',
    contract_version: CONTRACT_VERSION,

    capabilities: {
      bootstrap: true,
      search: true,
      fetch: true,
      context_pack: 'v0',
      write_event: true,
      write_handoff: true,
      suggestions: true,
      notices: true,
    },

    rules: {
      startup: 'Read this once per new client session. Cache it; do not call repeatedly.',
      retrieval_order: ['silo_context_pack_v0', 'read_index', 'get_topic', 'fetch', 'search'],
      do_not: [
        'Load all topics by default',
        'Treat raw Layer 3 / search results as curated truth',
        'Edit projection files directly — writes go through write_event or write_handoff',
        'Write without explicit user intent',
      ],
      notices: 'Inspect `_silo_notices` on read_index / search / list_handoffs / silo_context_pack_v0 responses. Surface pending suggestions ONCE per session when relevant to the user\'s task.',
      citation: 'When referencing memory, cite the topic slug and (for events) the seq. Layer-2 facts > Layer-3 evidence.',
    },

    memory_model: {
      zone_a: 'Operation log — append-only source of truth, lives under /root/.silo. Never edit directly.',
      zone_b: 'Projected topic files + dated event logs + TOPIC-INDEX.md. Normal read surface; rebuilt from Zone A by `silo regenerate`.',
      layers: {
        layer_1: 'Topic header metadata (YAML frontmatter): slug, type, tags, summary, status.',
        layer_2: 'Curated facts inside <!-- CURATED_START --> ... <!-- CURATED_END -->. Preferred memory source.',
        layer_3: 'Raw source material — historical events appended below Layer 2. Search / fetch only when curated facts are insufficient.',
      },
    },

    tools: {
      silo_bootstrap: 'Return this contract. Read-only. Call ONCE per session and cache.',
      silo_context_pack_v0: 'Given a task description, return a small curated bundle of relevant topics + Layer 2 excerpts. Deterministic ranking via the silo CLI BM25 backend. Read-only. Best first call when slug is unknown.',
      read_index: 'List available topic slugs with one-line summaries. Read-only. Call before get_topic when slug is unknown.',
      get_topic: 'Load a single topic\'s curated memory (Layer 2 + header). Read-only. Prefer this over search when slug is known.',
      read_events: 'Read tagged event-log entries by date (defaults to today). Read-only. Filterable by source / slug.',
      search: 'Full-text BM25 search across all Silo content; results MAY include raw Layer 3. Read-only. Treat results as evidence, not curated truth.',
      fetch: 'Retrieve full content by canonical ID — `topic:<slug>[#layer-1|layer-2]`. Read-only. Pairs with search-then-fetch.',
      list_handoffs: 'List handoff reports (pending or processed). Read-only. Handoffs are markdown files for curator review.',
      list_pending_suggestions: 'List topic suggestions awaiting accept / dismiss. Read-only. See `_silo_notices.pending_topic_suggestions`.',
      write_event: 'Append a tagged memory event (max 500 chars, single line). WRITE — confirm explicit user intent first. Routes through the operation log.',
      write_handoff: 'Write a multi-paragraph handoff report for curator review. WRITE — confirm user intent first; for complex changes only; prefer write_event for facts.',
      accept_suggestion: 'Accept a pending topic suggestion. WRITE — only after explicit user approval. Optional overrides for slug / summary / type / tags.',
      dismiss_suggestion: 'Reject pending topic suggestions with a cooldown (default 90d). WRITE — only after explicit user approval.',
    },
  };
}
