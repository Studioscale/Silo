# Adapting Silo to Other Platforms

Silo is file-based markdown. Any system that can read and write files can
implement it. Here's what you need to adapt for each platform.

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
