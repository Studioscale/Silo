# Silo — Implementation (v12.5)

This document describes the **production implementation** of Silo at v12.5 — what's in `src/`, how the modules fit together, and how to use the CLI.

For the architectural design (the conceptual model), see [ARCHITECTURE.md](ARCHITECTURE.md). For the headline value proposition, see [README.md](README.md).

## Status

- **Version:** v12.5
- **Production:** deployed 2026-04-22 on a single-user Hetzner VPS (managing ~25 knowledge domains)
- **Tests:** 129 unit tests, all passing on Node 20+
- **Spec maturity:** v12.5 went through 57 audit rounds across 19 drafts, with three independent reviewers (Claude, ChatGPT, Gemini) finding and resolving issues each round

## What v12.5 changed from earlier specs

The original Silo design (v3.x — what most of the README and ARCHITECTURE.md describes) treated topic files as the source of truth. Scripts wrote to topic files directly; the curation pipeline reorganized them in place.

v12.5 inverts that: a **canonical operation log** is the source of truth, and topic files / event logs are **regenerated projections** of the log.

```
v3.x:   scripts ──write──> topic files (truth)
                           └─ curation reorganizes in place

v12.5:  writes ──append──> operation log (truth)
                           └─ regenerate ──> topic files + event logs (projections)
```

Why: the projection model gives you replayability, byte-identical regeneration after any edit, and a single audit trail. If a curation run produces a bad topic file, you don't have to undo edits — you just regenerate from the log.

## Repository layout

```
src/
  log/                  # The operation log (the authority)
    canonical.js          NFC + RFC 8785 JCS + SHA-256 hash chain
    entry.js              Entry construction, schema versioning
    append.js             LogWriter (in-process mutex, fsync, async iterator)
  matrix/               # Event Capability Matrix (admission rules)
    matrix.yaml           Ground-truth (socket, mode) cells per event type
    load.js               Matrix class + isAdmissible(type, socket, mode)
  interpret/            # Fold log into State (deterministic, total, non-mutating)
    index.js              interpret(logReader, matrix?, asOfSeq?) → State
    state.js              State factory (topic_index, acl_table, principals, etc.)
  retrieval/            # Three retrieval modes (exact / context / orientation)
    index.js              BM25 via minisearch; ACL filter before ranking
  import-jarvis/        # Migration tools (import existing topic files + event logs)
    index.js              importDirectory + importTopicFile
    events.js             parseEventLine + importEventLogFile
  projection/           # Regenerate Zone B files from the log
    regenerate-topic-file.js
    regenerate-topic-index.js
    regenerate-event-log.js
    index.js              regenerateProjections (atomic writes)
  distill/              # LLM-driven extraction + curation primitives
    tokenize.js           Bilingual tokenizer + Jaccard similarity
    parse.js              Strict-format LLM output parser
    transcript.js         Read .jsonl session transcripts (delta-aware)
    distill.js            distill() pipeline with pluggable LLM client
    openai-client.js      OpenAI HTTP client (gpt-5.x and gpt-4o)
  cli/
    silo.js               Single binary: init, status, write, read, search,
                          import-jarvis, extract, curate, regenerate

test/                   # 129 unit + integration tests (node:test)
  fixtures/                Real-corpus parity fixtures
  *.test.js                One per module
```

## CLI

```
silo init     --silo-dir=<path> --operator=<name> --uid=<n>
silo status   --silo-dir=<path>
silo write    --slug=<s> --tag=<t> --content="..." [--principal=<p>] [--confidence=<c>]
silo read     --slug=<s>
silo search   <query> [--mode=exact|context|orient] [--flags=full_context] [--principal=<p>]
silo import-jarvis  --from=<dir>           # imports topics/ and events/
silo extract  --from-session=<.jsonl> [--state-file=<path>] [--model=gpt-5.4] [--dry-run]
silo curate   [--slug=<s>] [--days-back=14] [--min-events=3] [--model=gpt-5.4] [--dry-run]
silo regenerate  --to=<target-dir>          # rebuild Zone B from log
```

### Example session

```bash
$ silo init --silo-dir=./.silo --operator=alice --uid=1000
silo: initialized at ./.silo
  operator = alice (uid 1000)
  tail = seq 3

$ silo write --slug=acme-crm --tag=DECISION --content="Chose Flask/SQLite. Django too heavy."
written: seq 4 slug=acme-crm tag=DECISION

$ silo search "django" --silo-dir=./.silo
{
  "mode": "context_retrieval",
  "results": [{ "slug": "acme-crm", "score": 4.2, "preview": "Chose Flask/SQLite..." }]
}

$ silo regenerate --silo-dir=./.silo --to=./memory-files
{ "topics": 1, "event_logs": 1, "target": "./memory-files" }
```

## Three retrieval modes

`silo search` (or `mcp__silo__search` via the bridge) dispatches to one of three modes:

| Mode | Use case | Characteristic |
|---|---|---|
| `exact_lookup` | Find a specific known thing (slug, version, name) | Slug-boost ×5, narrow fuzzy, escalation only on `full_context` flag |
| `context_retrieval` (default) | "Most relevant surrounding memory" | BM25 with content + tag boosts, escalation on score margin or low evidence |
| `orientation_view` | "Show me the map" | **Metadata only**, never returns content; ACL-filter-before-rank; clamped to MAX_N=50 |

ACL is enforced **before** ranking in all three modes — global rankings are never observable to a principal who can't read a topic.

## Auth model (T1 → T3)

| Tier | Reader rule |
|---|---|
| T1 | Single operator. All topics readable by the operator. |
| T2 | Multi-principal. Per-topic ACL via `ACL_SEALED` events. Reader is in topic's reader set. |
| T3 | Per-topic ACL with admin-only seal events. Synchronous retrieval-time authorization. |

The current production deployment runs at T1 (single operator) but the matrix and interpret layers handle all three.

## Pipelines (v12.5)

### Session extraction (every 30 min)

```
chat conversation → session transcript .jsonl
                              ↓
                   readSessionDelta(file, lastLine)
                              ↓
                   distill({messages, recentTokens, llm})
                              ↓
                   parseExtractedBatch + Jaccard dedup
                              ↓
                   write_event entries → operation log
                              ↓
                   regenerate Zone B files
```

State per session is tracked in a JSON file (`lastProcessedLine` per `.jsonl`) so re-runs only see deltas.

### Layer 2 promotion (nightly, "curate")

```
For each topic with ≥N new events in last D days:
  build prompt: existing curated content + recent events
  → LLM (gpt-5.4)
  → bullets per topic
  → write_event(tag=CURATED) per bullet → operation log
  → regenerate Zone B files
```

Prompt is anti-bundling-aware: split distinct decisions into separate bullets. Output is English by default regardless of source language.

### Migration (one-shot)

`silo import-jarvis --from=<root>` replays existing topic files and event logs into the operation log, byte-perfect-regenerable: 22/23 topics + 20/21 event logs match originals byte-for-byte. The two diffs are cosmetic only (one YAML field position, one trailing newline).

## Development

```bash
git clone https://github.com/Studioscale/Silo.git
cd Silo
npm install
node --test test/*.test.js   # 129 tests
node src/cli/silo.js help
```

Dependencies: `canonicalize` (RFC 8785 JCS), `js-yaml`, `minisearch` (BM25), `uuid`. No native modules.

## What's not yet in the implementation

- **Silod-lite broker** — the spec's admission-time gate. CLI currently calls `LogWriter.append` directly; broker would route through matrix cells. M3 scope.
- **Tier-3 LLM synthesis on retrieval** — the highest-ROI documented upgrade per Silo's own audit. Spec'd, not built.
- **Changelog automation** — deferred to post-cutover per the v12.5 review chain. Scaffolding present in events; pipeline stub only.

These are tracked as known follow-ups in the production deployment's memory.
