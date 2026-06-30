# Silo

A structured memory architecture for AI assistants that actually works across sessions.

Silo replaces flat memory files (like OpenClaw's `MEMORY.md` or Claude Code's built-in memory) with a three-layer topic file system, a tagged event log, and automated extraction/curation pipelines. The result: your AI assistant remembers what matters, forgets what doesn't, and can tell you *when* and *why* something changed.

> **Status (2026-06):** v0.2.5 (implementing the v12.5 spec) in production on a single-user Hetzner VPS managing ~25 knowledge domains. 592 unit tests passing. Spec finalized after 57 audit rounds across 19 drafts (three independent reviewers per round — Claude, ChatGPT, Gemini). Implementation in [`src/`](src/), described in [IMPLEMENTATION.md](IMPLEMENTATION.md).

```
                Telegram / IDE / MCP client
                          │ writes
                          ▼
               ┌──────────────────────────┐
               │  operation log (Zone A)  │  ← single source of truth
               │  /.silo/  JCS + SHA-256  │     (canonical, hash-chained)
               └────────────┬─────────────┘
                            │ regenerate
                            ▼
              ┌─────────────────────────────┐
              │  topic files + event logs   │  ← Zone B projection
              │  /memory-files/  markdown   │     (what AI agents read)
              └─────────────────────────────┘
                            │ index
                            ▼
                   BM25 / lexical search
                         (Zone C)
```

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
- **Layer 3 (Source Material):** Raw conversation excerpts and context. Never loaded directly — searchable via BM25 (lexical) keyword search. Preserves provenance.

**Tagged event log.** Every fact, decision, change, and action item gets a one-line entry with a topic slug and a standardized tag:
```
[DECISION] acme-crm: Chose Flask/SQLite for backend. Django too heavy for our scale.
[FACT] team: Ana promoted to lead developer. Was: senior developer. Effective 2026-05.
[CHANGED] workshop: Mileage updated to 4,200 km. Was 3,800 km. Routine check.
[TODO] business: Follow up with accountant re Q2 filing. Due 2026-04-15.
```

**Automated extraction.** A script reads session transcripts, extracts facts/decisions with confidence levels (CONFIRMED, TENTATIVE, CONTEXT), deduplicates against existing entries, and writes them to the event log. Runs on a schedule and at session end.

**Nightly curation.** A separate pipeline processes modified topic files: promotes new facts from Layer 3 to Layer 2, propagates event log entries, updates metadata, flags contradictions. Only touches files that changed — zero cost on quiet nights.

**Topic suggestion.** When facts accumulate under the generic `general` slug (no dedicated topic file), a nightly detection pipeline (`silo suggest --run-now`, cron-driven) clusters them and writes `TOPIC_SUGGESTED` events to the log. The MCP server surfaces pending suggestions via a `_silo_notices` array on `read_index` / `search` / `list_handoffs` responses, plus a dedicated `list_pending_suggestions` tool. The user says yes/no in conversation — `accept_suggestion` emits an atomic (TOPIC_METADATA_SET, TOPIC_SUGGESTION_ACCEPTED) batch and the topic file appears on the next regen; `dismiss_suggestion` records a per-slug cooldown so the same cluster doesn't re-propose until the cooldown expires. Operator-side admin via `silo suggest --list / --accept / --dismiss / --status`.

**Search hierarchy.** Cheapest first:
1. Current context (free)
2. Topic index scan (free, already loaded)
3. Loaded topic file Layer 2 (free, already in context)
4. Today's event log (free, already loaded)
5. BM25 keyword search (free, local)
6. Ask the user (free, last resort)

Search defaults to lexical (BM25 / MiniSearch, with query normalization). An
**optional, opt-in local semantic layer** (step 5) can be fused in — see
[Semantic search](#semantic-search-optional-opt-in). It helps most on large
histories and multi-evidence questions (measured in `eval/longmemeval/`).

## Semantic search (optional, opt-in)

Off by default. When enabled, Silo adds a **local** dense-retrieval arm and fuses
it with the keyword engine (Reciprocal Rank Fusion), so paraphrases and
multi-evidence questions that keyword search misses still surface. It is **local**
(no API, no data leaves the box), **read-only**, and **provably fed into no write**
(a tested call-graph invariant — search results can never be mechanically consumed
by a write/curate/distill path).

**Strictly opt-in — three gates, all required:**

1. **Install it.** `silo semantic install --model=<key>` — pick a model explicitly
   (no silent default). Pins the embedding dep and records the choice. The
   embedding dependency is **not** in `package.json`; this is how it arrives.
   - `bge-small-en-v1.5` — English, 384-dim, ~234 MB RAM.
   - `multilingual-e5-small` — ~100 languages, 384-dim, ~606 MB RAM.
2. **Flag it on.** `export SILO_SEMANTIC=on`.
3. **Build the cache.** `silo regenerate --to <target>` embeds the corpus into a
   local cache projection (`<silo-dir>/projections/embeddings.json`). Search reads
   it; it is never written at search time.

Then `silo search "<query>"` fuses both arms. `silo doctor` reports the gate
state, model, and cache health. Disabled or not-yet-installed → keyword-only, as
before (the envelope says `semantic_status: disabled`).

**Trust tiers + `scope`.** Results are tiered by trust at the chunk level —
`curated` (the authoritative tier) > `note` (short event-log writes) > `source`
(raw imported material). **Default `scope=curated`** returns only the
authoritative tier; `scope=all` adds the advisory tiers, clearly isolated, for
recall (`silo search … --scope=all`). Retired bullets never surface (see
[#17](CHANGELOG.md)). The consumer contract: advisory tiers are unverified — do
not write from them without citing the source, and prefer the curated tier.

**Engine.** `@huggingface/transformers` (v3) running ONNX locally; q8, mean-pooled,
L2-normalized 384-dim vectors. Embeddings never enter the operation log or the
canonical hash, so **log-replay determinism is preserved**. Promotion of
`scope=all` to the default is gated on a pre-registered eval bar (`eval/`) — a
separate, logged decision.

## Numbers

| Metric | Silo | Flat MEMORY.md |
|--------|-----------|----------------|
| Auto-load per session | ~5-8 KB (rules + index + today's events) | 10-50 KB (everything, always) |
| Context relevance | High (load only the topic you need) | Low (entire memory loads every time) |
| Curation cost | ~$2-5/month (Sonnet-4.6 extraction + curation; auto-detected from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) | $0 (no curation = no cost = no quality) |
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

## Prerequisites

### Runtime

- **Node.js 20 or newer** (production runs on Node 24).
- A platform build toolchain BEFORE running `npm install`, so the
  optional `fs-ext` dependency can compile. Without it, Silo runs in
  single-process mode: the in-process mutex still serializes writes
  within one Node process, but **a second concurrent silo writer in a
  different process is not safe**. Fine for single-user CLI use;
  unsafe when crons + interactive commands + MCP can race.

  | Platform        | Toolchain install                                                              |
  |-----------------|--------------------------------------------------------------------------------|
  | Debian / Ubuntu | `apt install build-essential`                                                  |
  | Fedora / RHEL   | `dnf groupinstall "Development Tools"`                                         |
  | macOS           | `xcode-select --install`                                                       |
  | Windows         | Either install C++ Build Tools, or accept degraded single-process mode (fs-ext is a no-op on Windows) |

  After the toolchain is in place: `npm install`. On platforms without
  a toolchain, the build silently skips `fs-ext` and the runtime logs a
  one-time `silo: running in single-process mode` warning the first
  time a writer initializes.

### LLM provider (only for `silo extract` + `silo curate`)

Silo's manual operations (`silo write`, `silo read`, `silo search`, regeneration, MCP bridge) work standalone — no LLM required.

The two automated pipelines need an LLM provider:

- **`silo extract`** — distills events from session transcripts
- **`silo curate`** — promotes events to Layer 2 and retires stale bullets

Set one of the following environment variables before running them:

| Provider  | Env var               | Default model        | Notes                                                                              |
|-----------|-----------------------|----------------------|-------------------------------------------------------------------------------------|
| Anthropic | `ANTHROPIC_API_KEY`   | `claude-sonnet-4-6`  | Recommended. Production cron has used this since 2026-05-10.                        |
| OpenAI    | `OPENAI_API_KEY`      | `gpt-5.4`            | Recommended OpenAI tier. `gpt-4o` works as a budget fallback but loses anti-bundling + retire-detection nuance at the smaller-model tier — don't use it for curate. |

The curate / extract prompts target flagship-tier reasoning (anti-bundling, contradiction detection, retire-vs-add discrimination). Cheaper tiers (`claude-haiku-*`, `gpt-4o-mini`, `o<N>-mini`) compile and run, but the output quality drops noticeably. Stick to Sonnet-4-6 / GPT-5.4 unless you've measured your own use case and the cheaper tier is acceptable for you.

If both keys are set, Anthropic is preferred. Override the default with `--model=<id>` — the provider is auto-detected from the model prefix (`claude-*` → Anthropic, `gpt-*` / `o<digit>` / `chatgpt-*` → OpenAI).

Without a provider configured, `silo curate` and `silo extract` fail fast with an `ANTHROPIC_API_KEY or OPENAI_API_KEY required` error. All other commands work as-is.

### When the API call fails

Silo retries transient errors automatically — rate limits (429), provider 5xx, network blips, timeouts — with exponential backoff (2s, 4s, 8s, max 30s, 3 attempts total). Retry attempts log to stderr so cron operators see what's happening:

```
silo: LLM rate limit — retrying in 2s (attempt 1/2 of 2 retries)
```

After retries are exhausted, or for fail-fast errors, the CLI prints a classified message:

```
silo curate: LLM call failed (quota_exceeded / HTTP 400).
  Account out of credit / over quota. Top up at https://console.anthropic.com/settings/billing
  — or pass --model=gpt-5.4 to fail over to OpenAI (OPENAI_API_KEY must be set).
  Raw: Anthropic 400: Your credit balance is too low to access the Anthropic API.
```

Error categories:

| Category | Examples | Retryable? | Recovery |
|---|---|---|---|
| `auth_invalid` | 401, "invalid x-api-key" | No | Verify `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is set to a valid key. |
| `quota_exceeded` | Anthropic 400 "credit balance too low", OpenAI 429 "insufficient_quota", any 402 | No | Top up at the provider's billing page, or pass `--model=<other-provider-model>` if both keys are configured. |
| `rate_limited` | 429 (RPM hit) | Yes (auto-backoff) | Retries automatically; if exhausted, wait a few minutes. |
| `request_invalid` | 400, 404 (bad model name) | No | Check model name + provider compatibility. |
| `server_error` | 500, 502, 503 | Yes (auto-backoff) | Retries automatically; if exhausted, check provider status. |
| `request_timeout` | Client-side timeout (60s) | Yes (auto-backoff) | Usually transient. |
| `network_error` | `ECONNRESET`, `ENOTFOUND` | Yes (auto-backoff) | Network blip — usually transient. |

For ongoing curation/detection failures (cron-driven), `silo doctor` surfaces the count of consecutive failures and the last successful run:

```
Curate status: last ran 2026-05-18 05:00 UTC
  Status: failing (3 consecutive failures)
  Last failure: silo-curate run failed (run_id=..., exit=1)
  Last successful curate: 2026-05-15 05:00 UTC
```

What Silo does **not** do automatically:

- **No fallback provider switch.** If your Anthropic account hits quota and OpenAI is configured, Silo does not auto-fail-over. Pass `--model=gpt-5.4` explicitly. Some users prefer the explicit signal over silent quality drift.
- **No partial-run resume.** If `silo curate` fails mid-loop after processing 3 of 10 topics, those 3 are persisted (events are append-only); the next cron run re-detects the remaining 7 as still needing curation and tries them again from scratch.

### Running the MCP bridge under systemd

If you want to run `silo-mcp/` as a long-lived MCP server for Claude
Code / Claude Desktop / IDE consumers, the conventional layout splits
the git checkout from the runtime path so `git pull` stays safe:

- `/opt/silo/` — git checkout of this repo
- `/opt/silo-mcp/` — runtime path the systemd unit serves (gets a
  copy of `silo-mcp/server.js` + `notices.js`, plus its own
  `node_modules/` and `.env`)

`scripts/deploy-silo-mcp.example.sh` is a template deploy script
covering this pattern. Edit the path constants at the top and `chmod
+x` it, then run after each `git pull` to refresh the bridge.

### Universal-client surface (Stage 1 + Stage 2)

For generic MCP clients (ChatGPT custom connectors, Anthropic Console
test harness, homegrown clients) the bridge exposes two protocol-level
tools so the rules that CLAUDE.md gives Claude Code travel with the
server itself:

- **`silo_bootstrap`** — call ONCE per session, cache the response.
  Returns the structured contract: memory model (Zone A/B + Layers
  1/2/3), retrieval order, write policy, tool catalog, and
  `contract_version` for forward-compat parsing.
- **`silo_context_pack_v0`** — best first call for a vague task. Given
  a free-form `task` description, returns a small bundle of relevant
  topics + Layer 2 excerpts plus a confidence rating and recommended
  next tool calls. Ranking is BM25-deterministic via the silo CLI;
  the `v0` suffix is explicit — Stage 3 can swap in smarter ranking
  without changing the tool's API surface.

Plus the OpenAI-compatible `fetch` tool (Stage 1) and enriched
`search` results carrying stable IDs. See
[reference/adapting-to-other-platforms.md](reference/adapting-to-other-platforms.md)
for the full client contract and
[proposals/universal-client-protocol.md](proposals/universal-client-protocol.md)
for the design note (versioning policy, Stage 3 roadmap).

## Quick start

- **OpenClaw:** [quickstart/openclaw/SETUP.md](quickstart/openclaw/SETUP.md) — Full setup with automated pipelines (~30 minutes)
- **Claude Code:** [quickstart/claude-code/SETUP.md](quickstart/claude-code/SETUP.md) — Manual workflow with auto-loaded files (~15 minutes)
- **Other platforms:** [reference/adapting-to-other-platforms.md](reference/adapting-to-other-platforms.md)

## Topic suggestions (Phase 2.2)

Silo can propose new topic files automatically when `general`-slug events
cluster around a coherent subject. This is the only Silo feature that
writes a *suggestion* (rather than a fact) into the log — the user
decides whether to act on it.

**Detection** (cron, daily 04:00 UTC): `scripts/silo-detect.sh` runs
`silo suggest --run-now`, which scans recent `general` events, calls an
LLM with an anti-fragmentation prompt, and emits one `TOPIC_SUGGESTED`
event per validated cluster. Validators reject clusters whose slug
collides with an existing topic, whose normalized slug is in an active
cooldown, or whose support fingerprint overlaps ≥0.65 Jaccard with any
pending / cooldown-active suggestion.

**Surfacing** (passive): the MCP server adds a `_silo_notices` array
(`kind: "pending_topic_suggestions"`) to `read_index` / `search` /
`list_handoffs` responses when at least one suggestion is pending. The
consumer LLM is expected to mention the notice once per session when
relevant, then leave it alone. `list_pending_suggestions` returns the
full envelope on demand.

**Resolution**: `accept_suggestion({suggestion_seq, slug?, description?,
type?, tags?})` emits an atomic batch (`TOPIC_METADATA_SET` +
`TOPIC_SUGGESTION_ACCEPTED`) under the operation-log lock. After lock
release the server regenerates projections and the topic file appears.
`dismiss_suggestion({suggestion_seqs, cooldown_days?, reason?})` records
a per-normalized-slug cooldown so the same cluster won't re-propose
until expiry.

**Operator/debug**: `silo suggest --list | --accept <seq> | --dismiss
<seq> | --status | --bulk-scan` covers the same surface from the CLI
without needing MCP.

## Update notifications (Phase 2.3)

Silo polls GitHub Releases once per 24h (per deployment, throttled via
`<silo-dir>/update-status.json`) and surfaces the result the same way
topic suggestions are surfaced — as `kind: "update_available"` entries
in the MCP `_silo_notices` array. The check fires from a detached child
process at the top of every non-`silo doctor` CLI invocation so the
host command never waits on network I/O. Health failures surface as
`kind: "update_check_unhealthy"` after 7 consecutive failures (or
immediately on a 404). Opt out by setting `SILO_DISABLE_UPDATE_CHECK=1`
in the environment — this disables both the outbound fetch and the
inbound notice surfacing.

`silo doctor` prints local version + cached check status + operation-
log tail + cache-file diagnostics. `silo doctor --check-updates` forces
a fresh fetch synchronously; `--force` overrides opt-out for that
single invocation.

## Threat model + known limitations

Silo is the canonical store for the operator's memory. The architecture
prioritizes auditability (every change is an event with a hash chain) +
recoverability (Zone B projections are always rebuildable from Zone A).
A few specific limitations live in the implementation, documented here so
operators know what's enforced vs. what's roadmap:

**Trust model.** All write paths in the current implementation assume a
trusted operator. The `silo` CLI, the MCP bridge (behind a bearer token),
and the cron scripts (`silo-curate.sh`, `silo-detect.sh`) all share the
same `LogWriter` and write at the same trust level. There is no
multi-principal authorization at write time today (no per-user OAuth, no
per-token capability restrictions) — that's roadmap work behind a future
multi-tenant deployment.

**What IS enforced at write time today:**
- **Matrix admission gate** (M3, `src/log/append.js` +
  `src/log/admission-error.js`): `LogWriter._appendBatchUnlocked` calls
  `Matrix.isAdmissible(type, socket, 'normal')` for every staged entry
  before payload validation. Admin-only event types (`ACL_SEALED`,
  `PRINCIPAL_*`, install/feature/tag/broker meta) are rejected on the
  standard socket with `AdmissionError('EVENT_NOT_ADMISSIBLE')`; unknown
  event types are rejected with `UNKNOWN_EVENT_TYPE_NOT_REGISTERED`;
  `mode != 'normal'` is rejected with `INVALID_WRITER_MODE` (broker
  modes are reserved-but-unimplemented). The CLI dispatcher surfaces
  these as `ADMISSION_REFUSED:<code>` on stderr; the MCP bridge picks
  up the token and forwards it to AI clients distinct from
  `INVALID_EVENT_PAYLOAD`. Call sites that legitimately emit admin
  events (`silo init`, `silo import-jarvis`'s `ACL_SEALED` line) pass
  `socket: 'admin'` explicitly per call.
- **Per-event-type payload validation** (`src/admission/payload-validators.js`):
  `write_event`, `TOPIC_BULLETS_RETIRED`, `TOPIC_METADATA_SET`,
  `TOPIC_SUGGESTED`, `TOPIC_SUGGESTION_ACCEPTED`,
  `TOPIC_SUGGESTION_DISMISSED` all have hand-coded validators that
  reject unknown fields, out-of-range values, and (where applicable)
  multi-line content for tags that project to single-line markdown.
  Other event types pass through payload checks today — see the file's
  header comment for the full list. (The admission gate above runs
  BEFORE payload validation, so admin-only types never reach the
  validator if the socket is wrong.)
- **Slug canonical form**: all slugs at admission match
  `^[a-z0-9]+(-[a-z0-9]+)*$` with length 2..40. The extraction parser
  (`src/distill/parse.js`) was tightened to the same regex so an
  LLM-emitted slug can't land via `write_event` and then be rejected
  later by `TOPIC_METADATA_SET`.

**Layering note (M3):** the admission gate protects callers that go
through `LogWriter`. It does NOT stop a process with raw filesystem
write access from appending directly to
`/root/.silo/operation-log/*.jsonl`. The hash-chain verification at
read time catches such tampering. Write-path authorization (M3) and
read-path integrity (hash chain) are different defenses.

**What IS verified at read time:**
- **Hash chain integrity**: `interpret()` checks
  `entry.hash_prev === canonicalHash(prevEntry)` on every fold; breaks
  land in `state.skipped` with `reason='hash_chain_break'` and the
  offending entry is NOT applied to state. `silo doctor` surfaces the
  break count + first few details; `silo regenerate --strict` refuses
  to project from a log with breaks.
- **Shape integrity**: `interpret()` rejects malformed entries
  (missing/wrong-type seq, hash_prev, etc.) into the same `state.skipped`
  channel.

**MCP bearer auth surface:**
- Bearer token is the only authentication. The token is configured via
  `SILO_MCP_TOKEN` env at server startup and is shared by all clients.
- The server accepts the token via `Authorization: Bearer ...` header
  OR `?token=...` query string. Query strings leak via proxy logs,
  browser history, and referer headers; the OR-semantic is currently
  required for a legacy OpenClaw bundle-mcp client. **Roadmap**: gate
  query-token acceptance behind `SILO_MCP_ALLOW_QUERY_TOKEN` (default
  false) once that legacy client is fixed.

**Cross-process write safety:**
- The operation-log flock (via `fs-ext`, optional dependency) gives real
  cross-process write serialization on Linux + macOS. Windows installs
  without the C++ toolchain run in **single-process mode** — see the
  Prerequisites section for the platform toolchain table. Single-process
  mode is safe for one-user-one-shell setups; cron + interactive shell
  + MCP racing each other under degraded mode is NOT safe.

**Out of scope of Silo itself:**
- Token revocation / rotation (rotate `SILO_MCP_TOKEN` + restart the
  systemd unit).
- Backup of `/root/.silo/` (operator's responsibility — Silo doesn't
  schedule its own backups; a reference nightly-snapshot script ships at
  [`scripts/silo-backup.sh`](scripts/silo-backup.sh) — tar.gz with
  integrity check + count-based rotation, safe against a live writer
  because the log recovers any torn trailing line on read).
- Network-level access control to the MCP endpoint (the bridge listens
  on 127.0.0.1 by default; expose via reverse proxy + your normal TLS +
  firewall posture).

## Architecture deep dive

- [ARCHITECTURE.md](ARCHITECTURE.md) — Full system design
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — Implementation detail
- [reference/comparison.md](reference/comparison.md) — Silo vs MEMORY.md vs MemPalace vs SimpleMem
- [reference/adapting-to-other-platforms.md](reference/adapting-to-other-platforms.md) — Running Silo on platforms other than OpenClaw
- [CHANGELOG.md](CHANGELOG.md) — release history + migration notes (read this before upgrading from a pre-0.2.0 install)

## Origin

Silo was designed by [Helder Santiago](https://github.com/Studioscale) as the memory system for a production AI assistant managing 25 knowledge domains for a metal fabrication business in Brazil. It handles bilingual content (Portuguese/English), business operations, personal projects, technical systems, and hobby tracking — all with domain separation, confidence tracking, and full audit trails.

The architecture was researched, directed, and decided by Helder. Engineering and documentation were done with Claude (Opus, 1M context). The v12.5 spec was stress-tested through 57 audit rounds across 19 drafts, with three independent reviewers each round (Claude, ChatGPT, Gemini). The implementation runs on OpenClaw with Claude Sonnet 4.6 for extraction and curation (previously GPT-5.4 — switched 2026-05-10). Production cutover happened 2026-04-22; the system has been the live memory authority since.

For the journey from v3.x (script-based, files-as-truth) to v12.5 (operation-log + projections), see [IMPLEMENTATION.md](IMPLEMENTATION.md).

## License

MIT
