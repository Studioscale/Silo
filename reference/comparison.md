# Silo vs Other Memory Systems

Honest comparison based on architecture review and source code analysis.

---

## vs OpenClaw MEMORY.md (built-in)

OpenClaw's default memory: a single flat markdown file that accumulates facts.
Optional "dreaming" system for background consolidation.

| | Silo | MEMORY.md + Dreaming |
|---|---|---|
| Organization | Topic files per domain | One flat file |
| Context loading | ~3-5 KB per topic, on demand | Entire file, every session |
| Changelogs | Every change tracked with old/new values | Overwritten silently |
| Confidence | CONFIRMED / TENTATIVE / CONTEXT | None |
| Staleness | Per-topic `last_verified` dates | None |
| Curation | Nightly pipeline, targeted | Dreaming (experimental, all-or-nothing) |
| Search | BM25 + semantic hybrid | Same infrastructure (shared) |
| Maintenance | Custom scripts, cron jobs | Zero |
| Upgrade risk | Scripts may need updates | None (built-in) |

**When MEMORY.md wins:** If you have <20 facts, one domain, and don't care about
history. The zero-maintenance model is genuinely easier.

**When Silo wins:** Multiple knowledge domains, business use, anything where
you need to know *when* something changed or *why* a decision was made.

---

## vs MemPalace

[MemPalace](https://github.com/milla-jovovich/mempalace) — zero-LLM memory system
using ChromaDB vector storage with regex-based classification.

| | Silo | MemPalace |
|---|---|---|
| LLM dependency | GPT-4o extraction, GPT-4o-mini curation | Zero LLM calls |
| Cost | ~$2-6/month | $0 |
| Retrieval (benchmark) | Not benchmarked | 96.6% R@5 (LongMemEval) |
| Search | BM25 + semantic hybrid | Semantic only (production) |
| Curation | Nightly automated pipeline | None (filed once, never revisited) |
| Organization | Structured topic files | Flat vector store with metadata tags |
| Changelogs | Full audit trail | None |
| Confidence | Three levels, used in routing | Schema exists, never set |
| Entity handling | Integrated in topic files | Separate KG, manually populated |
| Scalability | Quality improves with curation | Quality degrades (noise grows) |

**When MemPalace wins:** Zero cost, zero maintenance, strong retrieval baseline
with no API keys. If you want "install and forget" personal memory.

**When Silo wins:** Curated knowledge > raw accumulation. Domain organization.
Changelogs. Confidence tracking. Hybrid search catches what semantic search misses.

**MemPalace ideas worth borrowing:**
- Temporal knowledge graph (valid_from/valid_to on entity relationships)
- Deterministic IDs for storage-level dedup
- Multi-format conversation normalizer (Claude, ChatGPT, Slack)

---

## vs SimpleMem

SimpleMem — LLM-based memory with multimodal support. Reported to outperform
Claude's native memory by 64% on LoCoMo benchmark.

| | Silo | SimpleMem |
|---|---|---|
| Architecture | File-based, structured | LLM-based, API-driven |
| Merge threshold | BM25 Jaccard 0.8 (coarse, by design) | 0.95 cosine similarity |
| Multimodal | No (text only) | Yes (text, image, audio, video) |
| Organization | Domain-specific topic files | Flat memory entries |
| Curation | Nightly pipeline | Automatic merge on ingest |
| Token usage | Reported misleadingly (multiple LLM calls per query) | ~$2-6/month total |
| Minimum model size | Any LLM for the assistant; GPT-4o for extraction | ~7B+ for structured output |

**When SimpleMem wins:** Multimodal memory. If you need to remember images and audio.

**When Silo wins:** Domain organization, changelogs, confidence tracking,
lower cost with transparent accounting. SimpleMem's token usage reporting was
flagged as misleading (multiple LLM calls per operation not disclosed upfront).

---

## Summary

| System | Best for | Weakness |
|--------|----------|----------|
| Silo | Multi-domain business/personal use with audit needs | Maintenance burden |
| MEMORY.md | Simple single-domain, low-fact-count use | No organization, no history |
| MemPalace | Zero-cost personal memory, install-and-forget | No curation, search-only recall |
| SimpleMem | Multimodal memory needs | Cost opacity, model size requirements |
