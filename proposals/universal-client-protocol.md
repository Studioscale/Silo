# Silo Universal-Client Protocol — Design Note

**Author**: desktop-claude
**Date**: 2026-05-19
**Status**: Stage 1 (fetch + enriched search + tool annotations) shipped on `main`. Stage 2 (silo_bootstrap + silo_context_pack_v0 + docs) shipped on `main`. Stage 3 (smarter ranking, query-token env-gate) deferred to roadmap.
**Scope**: Extend Silo's MCP surface so a generic LLM client (e.g. ChatGPT custom connector) can use Silo correctly with NO project-side instruction file. ~600 LOC across Stages 1+2 including tests + docs.

---

## 0. Problem statement

Silo's behavioral rules — when to read curated facts vs. raw evidence, how to cite topic slugs, which tools mutate state, which require explicit user confirmation — currently live in `~/.claude/CLAUDE.md` (and per-project `CLAUDE.md` files). That works for Claude Code: the harness reads CLAUDE.md and prepends it to every session.

Generic MCP clients have no equivalent surface. ChatGPT (via the Apps SDK / custom connectors), the Anthropic Console MCP test harness, and homegrown LLM clients all start each session with **only the tool catalog** — they see tool names, descriptions, and input schemas. There is no place to communicate:

- The Zone A (operation log) vs. Zone B (projection) split.
- The Layer 1 / 2 / 3 hierarchy — when curated facts suffice vs. when search-then-fetch is warranted.
- The "don't load all topics by default" budget rule.
- The "writes require explicit user intent" policy.
- The `_silo_notices` channel — what it carries and how to surface it.

Without those rules, a fresh ChatGPT session will guess: it might load every topic eagerly, treat raw Layer 3 evidence as canonical, or write events without confirming with the user. That's not a tool-description problem (per-tool descriptions can't carry cross-cutting rules); it's a protocol gap.

---

## 1. Current Claude Code success path

For reference — the path the protocol must preserve:

1. Claude Code starts; reads `~/.claude/CLAUDE.md`, finds the Jarvis section pointing to the project workspace.
2. Reads `<project>/CLAUDE.md`, learns the Silo-MCP rules: routing writes through MCP tools, the read order, the "don't fall back to SSH-write" rule.
3. Each tool call sees per-tool descriptions + READ_ONLY / WRITE_SIDE_EFFECT annotations.
4. Read-tool responses carry `_silo_notices` — the model surfaces suggestions to the user when relevant.

All four pieces matter; Stage 2's bootstrap moves pieces 1–2 (the cross-cutting rules) into the server itself for clients with no per-project instruction file.

---

## 2. Why bootstrap is needed (vs. richer tool descriptions)

Three reasons rule out "just put it all in tool descriptions":

1. **Cross-cutting rules don't fit in a per-tool string.** "Inspect `_silo_notices` and surface pending suggestions once per session" applies to every read tool but isn't a property of any one tool.
2. **Tool descriptions are read on every call.** Bloating every description with the full rule book burns tokens per request. Bootstrap is a single call the client caches.
3. **Some rules are about the SYSTEM, not the tool surface.** The memory model (Zone A / B, Layers 1/2/3) isn't reachable through the tool catalog at all — it's the framing the catalog operates inside.

The bootstrap call is read-only, idempotent, and explicitly cacheable per the contract — clients are expected to call it once at session start and reuse the result.

---

## 3. Tool catalog + contract shape

**`silo_bootstrap`** — returns the contract (see `silo-mcp/bootstrap-contract.js`). Read-only. Annotated `{readOnlyHint, idempotentHint, openWorldHint: false}`. Returns both `structuredContent` (machine-readable) and `content[0].text` (JSON-encoded for older clients).

Top-level contract keys:

| Key | Purpose |
|---|---|
| `system`, `purpose` | One-line identification. |
| `contract_version` | Shape version (see §4). |
| `capabilities` | What THIS instance supports (booleans + version strings). |
| `rules` | Cross-cutting behavioral rules (startup, retrieval_order, do_not, notices, citation). |
| `memory_model` | Zone A / B + Layer 1/2/3 descriptions. |
| `tools` | Per-tool one-line descriptions oriented to the rule book (when to call, what to expect). |

**`silo_context_pack_v0`** — given a free-form task description, returns a small bundle of relevant topics + Layer 2 excerpts plus confidence + recommended next tool calls. Read-only. Ranking is delegated to `silo search --mode=context` (BM25 backend via minisearch). Confidence buckets (eyeballed from current CLI score distribution):

| Best BM25 score | Confidence | Default next call |
|---|---|---|
| ≥ 4 | high | `fetch` per selected topic |
| ≥ 1.5 | medium | `fetch` per topic + `search` for evidence |
| < 1.5 / no results | low | `search` first |

The v0 in the name is explicit: the API shape is stable but the ranking implementation is the simplest thing that works. Stage 3 can swap in BM25 with tunable boosts, hybrid keyword+semantic, or a dedicated semantic index without changing the tool's surface — that's the value of the `context_pack: "v0"` capability marker.

---

## 4. Versioning policy

`contract_version` follows a semver-shaped string (`MAJOR.MINOR`). The two-part shape is deliberate — patch numbers don't carry useful information for clients that only need to know whether they can keep parsing the response.

| Change | Bump |
|---|---|
| Add a new top-level field (additive) | minor |
| Add a new key inside `capabilities` / `rules` / `tools` | minor |
| Add a new tool to the catalog | minor |
| Loosen an enum (e.g. add a new `confidence` bucket) | minor |
| Rename a field | **major** |
| Remove a field | **major** |
| Change a field's type | **major** |
| Change a rule's semantics (e.g. retrieval_order meaning) | **major** |
| Tighten an enum (remove a value) | **major** |

Stage 2 ships at `contract_version: "1.0"`. Future Stage-3 additions (e.g. surfacing per-instance feature flags, adding a `quickstart_links` block) bump to `1.1`, `1.2`, etc.

### `capabilities` vs. `contract_version` — different axes

`contract_version` answers: **"Can the client parse this response?"** Bumped when the SHAPE of the contract changes.

`capabilities` answers: **"What does THIS Silo deployment support?"** Bumped per-key when a deployment turns a feature on or off — e.g. a future read-only deployment might set `write_event: false`. Two Silo servers can return the same `contract_version` but different `capabilities`. The version-string capability values (`context_pack: "v0"`) let a single feature evolve through implementations without forcing a contract-shape bump.

---

## 5. Future work

### Stage 3 — smarter `silo_context_pack`

The v0 ranking shells out to `silo search --mode=context`. The CLI's BM25 over slug + tags + content is fine for narrow queries but degrades on:

- Multi-topic synthesis ("how does CRM relate to production scheduling?").
- Synonym misses ("clients" vs. "customers", "orçamentos" vs. "estimates").
- Conceptual queries that don't share vocabulary with curated facts.

Stage 3 options, in increasing order of complexity:

1. **Tunable BM25 boosts** — expose slug / tag / content weights as query parameters; tune from real ChatGPT usage logs.
2. **Embedding-augmented retrieval** — keep BM25 as primary; add a small embedding index over Layer 2 excerpts; merge ranks with reciprocal rank fusion.
3. **Synthesis cards** — produce multi-topic cards (v12.5 M2 in the existing roadmap) that BM25 can match directly without a fusion step.

Gate on real usage data: ChatGPT integration must be live and producing context_pack calls before we tune thresholds or invest in semantic ranking.

### `quickstart/chatgpt/SETUP.md`

ChatGPT's custom-connector UI is in flux (as of 2026-05). A dedicated setup guide will be valuable once the UI stabilizes — for now, the `reference/adapting-to-other-platforms.md` "Universal MCP client contract" section covers the basics.

### OAuth + multi-user

Bearer-token auth is fine for the single-user Hetzner deployment. A hosted multi-tenant Silo would need OAuth (or at least per-user tokens) so each user's writes are correctly principal-tagged. Out of scope for the current architecture; flagged for any future hosted variant.

### Per-client capabilities

`capabilities` is currently the same for every client connecting to a given Silo instance. A future enhancement could vary the response per-client based on the bearer token (e.g. some tokens grant write_event, others are read-only). Useful for hosted deployments with multiple consumers.

### Read-only vs. read-write modes

For low-trust contexts (e.g. a public-facing demo connector), expose only the read tools. Easiest implementation: a `SILO_MCP_MODE=readonly` env var that suppresses write-tool registration. Defer until there's a concrete use case.

### Query-string token auth env-gate

`SILO_MCP_ALLOW_QUERY_TOKEN` — disable the URL-token authentication path once the OpenClaw bundle-mcp legacy reason for keeping it is gone. Currently kept for compatibility per a known-client requirement. Separate decision; tracked outside this design note.

### Matrix admission gate wiring

M3 work in the v12.5 roadmap. The bootstrap contract may eventually surface admission-gate state under `capabilities` (e.g. `admission_gate: "matrix"` vs. `"open"`).

---

## 6. Acceptance criteria

Stage 2 considered complete when:

- Suite green at every commit. (476/476 at Stage 2 ship.)
- Existing Claude Code workflows unchanged.
- `silo_bootstrap` callable; returns valid structured contract with both `structuredContent` and `content[0].text`.
- `silo_context_pack_v0` returns relevant topics for a narrow task; low-confidence matches clearly labeled.
- Tool descriptions on the bootstrap + context_pack tools are self-explanatory to a generic LLM client.
- Annotations declared on both new tools.
- Design note (this file) covers the versioning policy + future work.
- Deploy via `/root/deploy-silo-mcp.sh` on the VPS; verify the new tools appear in the tools/list MCP response.
- Memory event under `jarvis-claw` slug when Stage 2 ships.

---

*Stages 1+2 of the universal-client protocol are now complete. Stage 3 work is gated on real ChatGPT usage data.*
