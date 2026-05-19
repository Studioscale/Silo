# Adapting Silo to Other Platforms

Silo is file-based markdown. Any system that can read and write files can
implement it. Here's what you need to adapt for each platform.

---

## Universal MCP client contract

If your client speaks MCP, you don't need filesystem access at all — point it at the bundled `silo-mcp` server and follow the protocol below. This is the path ChatGPT custom connectors, Anthropic Console MCP test harnesses, and homegrown MCP clients should take. Claude Code uses the same tools but layers on CLAUDE.md for cross-cutting rules; non-Claude-Code clients get those rules from `silo_bootstrap` instead.

### Step 1 — call `silo_bootstrap` once

At session start, call `silo_bootstrap` and cache the response for the rest of the session. The response is a structured contract describing:

- `system` / `purpose` / `contract_version` — identification + shape version.
- `capabilities` — what this Silo instance supports (booleans + version strings like `context_pack: "v0"`).
- `rules` — startup behavior, retrieval order, do-not list, notices handling, citation policy.
- `memory_model` — Zone A (operation log, source of truth) vs. Zone B (projection), Layer 1 (header) / 2 (curated facts) / 3 (raw evidence).
- `tools` — per-tool one-line descriptions oriented to the rule book.

Do not call `silo_bootstrap` repeatedly within a session. It's idempotent and the contract is stable for a given server version — caching it preserves token budget.

### Step 2 — pick a retrieval strategy

The rule of thumb: **slug known → drill straight in; task vague → context pack first; everything else → search.**

| Situation | First call | Then |
|---|---|---|
| User mentions a specific slug or topic by name | `get_topic` (or `fetch topic:<slug>`) | Done unless evidence needed. |
| User asks a vague question that maps to a domain ("what do we have on the CRM?") | `silo_context_pack_v0` with the user's question as `task` | Inspect `selected_topics` + `confidence`; follow `recommended_next_tool_calls`. |
| You don't know what topics exist | `read_index` | Pick a slug, then `get_topic`. |
| All else / fallback | `search` | Results are BM25-ranked and MAY include raw Layer 3 — treat as evidence, not curated truth. |

`silo_context_pack_v0` is the best first move for an unfamiliar task: it ranks candidate topics via BM25 and returns Layer 2 excerpts so you don't have to enumerate the index. Low-confidence responses (no strong matches) lead the recommendation list with a `search` call.

### Step 3 — write policy

Writes go through MCP tools, never direct file edits — even if your client has filesystem access. The operation log under `/root/.silo/` is the source of truth; editing projection files (under `/root/clawd-v3/`) is futile because the next `silo regenerate` will overwrite them.

Confirm explicit user intent before calling write tools:

- `write_event` — confirm before recording decisions, user facts, or project updates.
- `write_handoff` — confirm before queueing curator-review work.
- `accept_suggestion` / `dismiss_suggestion` — confirm before accepting or rejecting auto-detected topics.

The bootstrap contract's `do_not` list and per-tool descriptions (annotated `WRITE_SIDE_EFFECT`) carry this rule, but it bears repeating: writes without user intent will create durable, audit-logged memory entries that survive regen. There is no quiet undo.

### Step 4 — notices

Read-tool responses (`read_index`, `search`, `list_handoffs`, `silo_context_pack_v0`) may include a `_silo_notices` array. Each entry has a `kind` discriminator; current kinds:

- `pending_topic_suggestions` — Silo auto-detected a recurring theme in `general`-slug events and proposes a new topic. The user can review via `list_pending_suggestions`.
- `update_available` — A newer Silo release is available.
- `update_check_unhealthy` — GitHub update check has been failing.

Surface these to the user **once per session** when relevant to their current task. Don't repeat the same notice in every response — that becomes noise.

### ChatGPT / custom connector notes

ChatGPT custom connectors connect MCP servers as "apps" the model can invoke. As of mid-2026 the UI is still evolving:

- **The model may not auto-invoke Silo in every chat.** Users may need to select the Silo connector explicitly via the apps picker, especially in new chats. Don't promise transparent memory in every conversation — the user has to opt the connector in.
- **The model sees the tool catalog but not your prompt-engineering.** Whatever rules you'd put in a Claude Code `CLAUDE.md` must come through `silo_bootstrap` instead. Stage 2 explicitly designed the contract to carry those rules.
- **Tokens add up.** Calling `silo_bootstrap` on every turn defeats the purpose; cache the response in the client's working memory for the session.
- **OAuth is not yet wired.** Current deployments use bearer-token auth. A hosted multi-user variant would need per-user OAuth — see `proposals/universal-client-protocol.md` §5.

If you're building a fresh custom connector against `silo-mcp`, the design note (`proposals/universal-client-protocol.md`) documents the versioning policy, the capabilities-vs-contract_version axes, and the Stage 3 roadmap for smarter ranking.

---

## Core requirements (any platform)

1. **A writable filesystem** — topic files, event logs, and the topic index are
   plain markdown files on disk.

2. **A way to auto-load 2-3 files at session start** — the operating rules,
   the topic index, and today's event log. This is ~5-8 KB.

3. **A way to search across files** — at minimum, keyword search (grep).
   Ideally, BM25 + semantic search.

---

## What needs adapting

### Session extraction

The extraction pipeline reads session transcripts, calls an LLM to extract facts,
and writes them to the event log. You need:

- **Access to session transcripts** — whatever format your platform exports
- **An LLM API** — GPT-4o recommended for extraction quality
- **A trigger mechanism** — cron, hooks, or manual invocation

If your platform doesn't export transcripts, you can skip automated extraction
and rely on manual event log entries + the "remember this" command.

### Nightly curation

The curation pipeline processes modified topic files. You need:

- **A scheduler** — cron, Windows Task Scheduler, or similar
- **A cheap LLM** — GPT-4o-mini or equivalent for curation tasks
- **File modification tracking** — compare mtime vs last_curated dates

If you don't have a scheduler, you can run curation manually ("review and curate
the modified topic files") — it's just less automated.

### Topic suggestion

The suggestion pipeline detects general-slug clusters. This is the least critical
pipeline — you can always create topic files manually.

---

## Platform-specific hints

### ChatGPT (with code interpreter)

ChatGPT can read and write files within a session, but files don't persist across
sessions. You'd need to:
- Upload topic files at the start of each session
- Download modified files at the end
- Run curation manually

This is cumbersome. Silo is a better fit for platforms with persistent
filesystem access.

### LangChain / LlamaIndex agents

If you're building a custom agent:
- Mount the Silo directory as the agent's workspace
- Add the topic index to the system prompt
- Implement the search hierarchy as a tool chain
- Use LangChain's file tools for reading/writing topic files

### Local LLMs (Ollama, llama.cpp)

Silo works with any LLM. The extraction and curation prompts are in the
reference implementations — adapt them for your model. Note:
- Models under ~7B parameters may struggle with structured output (event log format)
- Local embeddings (via ChromaDB or similar) can replace Gemini semantic search
- BM25 keyword search is always free and local

### Cursor / Windsurf / Other AI IDEs

Similar to Claude Code — filesystem access, no built-in cron. Use the Claude Code
quickstart as a template. The main adaptation is how the IDE loads context at
session start (equivalent of CLAUDE.md auto-loading).

---

## Minimum viable implementation

If you just want the core benefit (organized memory with changelogs) without
any automation:

1. Create topic files manually using TEMPLATE.md
2. Write event log entries manually during conversations
3. Update topic file Layer 2 when facts change (with changelog entries)
4. Keep a topic index by hand

This gives you 80% of the value with zero infrastructure. The automation
(extraction, curation, suggestion) optimizes the remaining 20%.
