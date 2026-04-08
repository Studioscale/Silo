# Silo

A structured memory architecture for AI assistants that actually works across sessions.

Silo replaces flat memory files (like OpenClaw's `MEMORY.md` or Claude Code's built-in memory) with a three-layer topic file system, a tagged event log, and automated extraction/curation pipelines. The result: your AI assistant remembers what matters, forgets what doesn't, and can tell you *when* and *why* something changed.

## The problem

Most AI memory systems work like this:
- A single flat file that grows forever
- No domain organization (your motorcycle notes next to your business financials)
- No way to know when a fact was last confirmed
- No changelog (old values are silently overwritten)
- Everything loads every session (wasting tokens on irrelevant context)
- No confidence tracking ("we should maybe do X" stored the same as "we decided to do X")

## What Silo does differently

**Domain-organized topic files.** Each subject (a project, a person, a hobby, a business domain) gets its own file with three physical layers:
- **Layer 1 (Header):** Metadata — slug, type, tags, entities, status, dates, summary
- **Layer 2 (Curated Facts):** The truth. Structured, distilled knowledge. Updated in place with mandatory changelog entries. This is what your AI loads when the topic is relevant.
- **Layer 3 (Source Material):** Raw conversation excerpts and context. Never loaded directly — searchable via BM25 and semantic search. Preserves provenance.

**Tagged event log.** Every fact, decision, change, and action item gets a one-line entry with a topic slug and a standardized tag:
```
[DECISION] acme-crm: Chose Flask/SQLite for backend. Django too heavy for our scale.
[FACT] team: Ana promoted to lead developer. Was: senior developer. Effective 2026-05.
[CHANGED] workshop: Mileage updated to 4,200 km. Was 3,800 km. Routine check.
[TODO] business: Follow up with accountant re Q2 filing. Due 2026-04-15.
```

**Automated extraction.** A script reads session transcripts, extracts facts/decisions with confidence levels (CONFIRMED, TENTATIVE, CONTEXT), deduplicates against existing entries, and writes them to the event log. Runs on a schedule and at session end.

**Nightly curation.** A separate pipeline processes modified topic files: promotes new facts from Layer 3 to Layer 2, propagates event log entries, updates metadata, flags contradictions. Only touches files that changed — zero cost on quiet nights.

**Topic suggestion.** When facts accumulate under the generic `general` slug (no dedicated topic file), a nightly script detects clusters and suggests creating new topic files. User approves, a script creates the file, and future facts route automatically.

**Search hierarchy.** Seven levels, cheapest first:
1. Current context (free)
2. Topic index scan (free, already loaded)
3. Loaded topic file Layer 2 (free, already in context)
4. Today's event log (free, already loaded)
5. BM25 keyword search (free, local)
6. Semantic search (cheap, ~1-3c/query)
7. Ask the user (free, last resort)

## Numbers

| Metric | Silo | Flat MEMORY.md |
|--------|-----------|----------------|
| Auto-load per session | ~5-8 KB (rules + index + today's events) | 10-50 KB (everything, always) |
| Context relevance | High (load only the topic you need) | Low (entire memory loads every time) |
| Curation cost | ~$2-6/month (GPT-4o extraction + GPT-4o-mini curation) | $0 (no curation = no cost = no quality) |
| Fact staleness tracking | Per-topic `last_verified` dates with type-specific thresholds | None |
| Changelog | Every change recorded with old value, new value, date, reason | None (overwritten silently) |
| Confidence levels | CONFIRMED / TENTATIVE / CONTEXT | None |
| Domain organization | Unlimited topic files, each independently loadable | One file, everything mixed |
| Contradiction detection | Flagged during curation | Silent conflicts |

## Who this is for

**OpenClaw users** — Full native support. Scripts run as cron jobs inside the container. Search tools are built-in. The topic file format works with OpenClaw's `projectContext` auto-loading.

**Claude Code users** — Works with Claude Code's `CLAUDE.md` auto-loading and filesystem access. The automated pipelines need manual triggers (no built-in cron), but the architecture and file formats work as-is.

**Other AI assistants** — The architecture is file-based markdown. Any system that can read and write files can implement Silo. The automated pipelines need platform-specific adaptation, but the core design (topic files + event log + search hierarchy) is universal.

## Who this is NOT for

- If your AI conversations are casual and you don't need cross-session memory, this is overkill.
- If you have one narrow use case and 20 facts to remember, a flat file is fine.
- If you want zero-cost, zero-maintenance memory, look at [MemPalace](https://github.com/milla-jovovich/mempalace) (zero LLM cost, 96.6% retrieval, but no curation, no changelogs, no domain organization).

## Quick start

- **OpenClaw:** [quickstart/openclaw/SETUP.md](quickstart/openclaw/SETUP.md) — Full setup with automated pipelines (~30 minutes)
- **Claude Code:** [quickstart/claude-code/SETUP.md](quickstart/claude-code/SETUP.md) — Manual workflow with auto-loaded files (~15 minutes)
- **Other platforms:** [reference/adapting-to-other-platforms.md](reference/adapting-to-other-platforms.md)

## Architecture deep dive

- [ARCHITECTURE.md](ARCHITECTURE.md) — Full system design
- [reference/search-hierarchy.md](reference/search-hierarchy.md) — The 7-level search system
- [reference/curation-pipeline.md](reference/curation-pipeline.md) — How automated curation works
- [reference/extraction-pipeline.md](reference/extraction-pipeline.md) — How session extraction works
- [reference/topic-suggestion-pipeline.md](reference/topic-suggestion-pipeline.md) — How topic detection works
- [reference/comparison.md](reference/comparison.md) — Silo vs MEMORY.md vs MemPalace vs SimpleMem

## Origin

Silo was designed by [Helder Santiago](https://github.com/Studioscale) as the memory system for a production AI assistant managing 23 knowledge domains for a metal fabrication business in Brazil. It handles bilingual content (Portuguese/English), business operations, personal projects, technical systems, and hobby tracking — all with domain separation, confidence tracking, and full audit trails.

The architecture was researched, directed, and decided by Helder. Engineering and documentation were done with Claude (Opus, 1M context). The design was stress-tested through 4 rounds of independent review with 3 reviewers (78 issues found and resolved). The implementation runs on OpenClaw with GPT-4o for extraction and GPT-4o-mini for curation.

## License

MIT
