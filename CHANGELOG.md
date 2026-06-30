# Changelog

All notable changes to Silo. Format loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows what `package.json` declares (which the in-band update check compares against `releases/latest` on GitHub).

## [Unreleased]

## [0.3.0] — 2026-06-30

### Added — local hybrid (lexical ⊕ semantic) search

Optional, strictly opt-in local semantic search fused with the keyword engine via Reciprocal Rank Fusion, with **chunk-level trust tiering** and a **default `scope=curated`**. Off by default — the one universal change is **#17** (below). Search stays **read-only** and is **provably fed into no write** (a tested call-graph invariant). Ratified design: [`proposals/hybrid-search.md`](proposals/hybrid-search.md). Built in the build-brief's order (foundation+cache → no-write guard → lexical-per-unit+RRF+tiering → install+gates+doctor → eval), each step tested and green.

**Measured (LongMemEval, real bge-small-en model, recall_all@5):** full `_S` (479 q) — lexical **75.6%** → hybrid **87.7%** (**+12.1 pts**). Fusion is RRF with the lexical arm down-weighted (w_L=0.5, tuned off-prod on a flat plateau) so hybrid ≥ semantic-alone while keeping exact-term (part-number) matches that the lexical arm nails. Ships `scope=curated` by default; promoting `scope=all` stays gated on the §5 pre-registered bar (a separate, logged decision).

- **#17 (universal, standalone): retired CURATED bullets no longer surface in keyword search** — excluded from `buildIndex`'s per-topic content, the per-unit lexical index, and escalated `contentFor` output. Retired = removed; reachable only via the audit log. (`test/retired-exclusion-17.test.js`.)
- **Embedder primitive** (`src/embedding/embedder.js`) — triple-gate loader (`semanticEnabled()` = `silo semantic install` marker + `SILO_SEMANTIC=on` + explicit model), pinned model registry (`multilingual-e5-small` / `bge-small-en-v1.5`, 384-dim q8, prefix profiles), fs-ext-style degrade-on-missing. Embedding deps are **not** in `package.json`.
- **Chunker** (`src/retrieval/chunk.js`) — per-`seq` fixed-window (`max_tokens=512`, `chunk_size=256`, `chunk_overlap=64`), never crossing a seq boundary; identity-manifest fields.
- **Trust tiers** (`src/retrieval/tiers.js`) — `classifyTier` from raw events (curated/note/source), per-chunk, never rolled up to the slug.
- **Cache-projection builder** (`src/projection/embed-cache.js`) — built by `silo regenerate` (gated, zero-cost when disabled); content-addressed vector store + occurrence index + split **identity** (rebuild) / **freshness** (use-as-is) manifest; separate projection lock; vector reuse on identity match; retire/orphan pruning that preserves dedup.
- **Ranker** (`src/retrieval/semantic.js`, `fusion.js`, `provenance.js`) — `liveSearchUnits` driven from State (retired excluded), tier+vector by occurrence-index **lookup only**; cosine; RRF (k=60, 1-based, **absent arm omitted**); `similarity_floor=0.30`, `n_pre=100`, `bounded_prior_cap=0` (tier is a pure label). `contextRetrievalHybrid` adds the semantic arm async with a whole-block try/catch → lexical fallback; tiered envelope (`semantic_status`/`cache_status`, `authoritative/advisory/must_not_write_from` tiers, `grouped_by_tier`, provenance).
- **No-write invariant** (`src/admission/retrieval-origin-guard.js`) — (1) import-graph lint: write/curate/distill may not import the ranker (`test/no-write-guard.test.js`); (2) choke-point: every `write_event` admission rejects a retrieval-origin payload (object/JSON/stringified/handoff/curate/distill/CLI).
- **`silo semantic install --model=<key>`** (`src/embedding/install.js`) — explicit model choice (no silent default), dep pins, install marker; `silo doctor` reports semantic status + cache health + per-tier counts. Engine: **`@huggingface/transformers` v3** (the maintained successor to the frozen `@xenova/transformers` v2 — v3 takes `dtype` not `quantized`; same model ids, same 384-dim q8 outputs). Cross-platform dep install (the prototype's bare `spawnSync('npm', …)` returned a null status on Windows where `npm` is `npm.cmd` and Node refuses to spawn a `.cmd` without a shell); install now reports success/failure honestly and still records the marker on a failed dep install so `silo doctor` can guide recovery.
- **Eval** — `eval/longmemeval/run-longmemeval.js` gains `--retriever=lexical|semantic|hybrid` and 4 harness-correctness fixes (has_answer gold, user-turns-only index, full-haystack emit, `recall_all@5` headline); `eval/silo-native/` adds a tiered fixture, the answer-level over-trust gate, and the pre-registered promotion bar. Both tracks run offline on tiny fixtures (`test/eval-harness.test.js`).

`scope=all` stays opt-in until the §5 pre-registered bar passes on a holdout (a separate, logged decision).

## [0.2.5] — 2026-06-16

Write-event slug-existence guard — a `write_event` whose slug is neither a reserved sink (`general`, `system`) nor already write-admissible is **rejected at the `LogWriter` admission boundary** (`AdmissionError('SLUG_NOT_ADMITTED')`), on **every socket including `admin`** and through **every writer** (CLI, MCP, import, extract, cron). New topics are born only via a `TOPIC_METADATA_SET` that sets a `topic_type` — `accept_suggestion`, import, or the new `silo topic create`. This closes the self-creating-topic seam (a `write_event` to a novel slug used to silently mint the topic; the only existence gate lived on the MCP bridge against the projected index — projection-lag-prone and bypassed by any non-MCP writer). A 30-day census found zero junk slugs: this is **preventive insurance** for a future non-MCP writer the owner won't be watching, and for the multi-user tier. The guard is **content-integrity, orthogonal to access-control** (it is `write_event`-only; gating `TOPIC_METADATA_SET` topic-creation is deferred to the multi-user ACL/tier layer). Ratified design (4-round multi-reviewer gauntlet): [`proposals/slug-existence-guard.md`](proposals/slug-existence-guard.md).

### Added
- **The slug-existence guard** (`src/admission/slug-existence.js`) — `deriveWriteAdmissible(state)` (`{slugs with ≥1 write_event} ∪ {slugs whose TOPIC_METADATA_SET set topic_type}`), `buildAdmissionContext`, `isSlugWriteAdmissible`, `guardSlugExistence`. The write-admissible set + intra-batch staging live in an **ephemeral, lock-scoped admission context** derived from `interpret()` under the append flock — computed **once per locked session** (threaded into `_appendBatchUnlocked`, never a long-lived `LogWriter` cache, never re-folded per entry), so loop writers stay O(N). Reserved sinks `{general, system}` are exempt (`system` is the cron/backup status sink). The round-2 bypass is closed: a `TOPIC_VERIFIED`/`TOPIC_CURATED`-only slot sets neither `topic_content` nor `topic_type`, so it is **not** write-admissible.
- **`silo topic create <slug>`** — deterministic topic creation: emits `TOPIC_METADATA_SET` (`--type`, default `reference`; `status=active`) through the locked public write path. `SLUG_COLLISION` if the slug already has a `topic_type`; `PENDING_SUGGESTION_EXISTS` (normalized-slug match) unless `--dismiss-pending` (dismisses all matches with `cooldown_days=1` in the same locked batch first); `COOLDOWN_ACTIVE` unless `--override-cooldown`. Reuses `acceptSuggestion`'s collision guard + `detect`'s cooldown helper (shared, not duplicated). `--summary` / `--tags` optional; `--to` regenerates.
- **Session-level tail-safety gate.** Generalized `silo retire`'s per-op gate to the append boundary: **every** locked append (write_event AND `TOPIC_METADATA_SET`) refuses (`LOG_TAIL_NOT_INTERPRETABLE`) when the folded `last_seq` ≠ the physical tail seq, so topic creation can't silently orphan onto a broken physical tail either. Inert on a healthy tail; never trips on the production log's historical mid-log breaks.
- New tests: `test/slug-existence.test.js` (21 — guard core, bypass-closed, creation-marker, intra-batch staging, grandfathering, tail-gate, context-lifecycle, reserved sinks, admin-socket, airtight-on-omission), `test/topic-create.test.js`, `test/extract-persist.test.js` (reactive reroute + the mandated "non-`SLUG_NOT_ADMITTED` propagates" test), plus a typeless-topic-file import case.

### Changed
- **`LogWriter` (sealed core).** `append` / `batchAppend` build the lock-scoped admission context after the tail rescan; `withAppendLock` builds it once from its existing `freshState` and exposes it to the callback; `_appendBatchUnlocked` takes it as a param and runs the tail gate + the per-entry slug guard (beside the matrix gate, after payload validation, throwing `AdmissionError`). A `write_event` reaching the primitive with **no** context is rejected (no bypass by omission). `retire` / `accept` / `dismiss` / `curate` forward the context.
- **Event-log import** now pre-seeds a `TOPIC_METADATA_SET(type='reference')` for any missing slug and appends the whole day's events under **one batched session** (existence-only preflight) — fixing what would otherwise be an O(N²) per-entry re-fold.
- **Topic-file import** forces `type='reference'` when the source frontmatter omits `type`, so a type-less metadata event can't leave the following same-topic write non-admissible.
- **`silo extract`** reactively re-routes a distilled entry whose slug doesn't exist to `general` (surfaced in the run summary as `rerouted`, never silent) — branching **only** on `SLUG_NOT_ADMITTED` and re-raising every other admission error (a catch-all would mask tail-safety / matrix refusals). The distill prompt now says memory cannot create topics — use an indexed slug or `general`, never invent one.
- **MCP `write_event`** — removed the redundant projected-index pre-gate (`server.js`); the core guard is the single authority (the bridge routes writes through the CLI, inheriting it). The tool description + slug param now say the topic must already exist (create with `silo topic create`); an admission failure surfaces the structured `{slug, hint}` detail to the caller.

## [0.2.4] — 2026-06-15

Curate-liveness — a passive `_silo_notices` "check-engine light" that warns when the nightly curation job hasn't *succeeded* in ~3 days. Motivated by a ~10-day silent curate outage in May: `scripts/silo-curate.sh` lost its executable bit and the kernel refused to exec it, so it died *before its first line ran* — its own heartbeat (`run started` / `run failed`) never got the chance to fire. The fix sources the staleness signal **out-of-band** from curate (in detect's cron, structurally alive when curate is dead) **and** in-band (curate's own `EXIT` trap, for instant recovery reflection), plus a read-path freshness guard so even a both-crons-dead outage isn't fully dark. Additive: a new CLI verb + a read-path consumer on the existing notice rail + two cron traps — no schema or log-format change. Ratified design (multi-reviewer gauntlet, round-2 converged): [`proposals/curate-liveness.md`](proposals/curate-liveness.md).

(0.2.3 is reserved for the planned CLI slug-guidance change and is unreleased; liveness ships as 0.2.4 per the ratified implementation order.)

### Added
- **`silo curate-status`** — pre-computes the curate-liveness verdict into `<silo-dir>/curate-status.json` from the operation log (its own `interpret()` fold → `deriveCuratorStatus` → `foldLiveness`, atomic write). Run by both nightly crons via an `EXIT` trap; **excluded from the update-check auto-fire gate** (it's a cron-frequency call and stays side-effect-free). Never fails a cron — a fresh silo with no curate events writes a valid never-succeeded record and exits 0.
- **Passive notices on the `_silo_notices` rail.** `curate_liveness_stale` (curate hasn't succeeded in N days; the message branches on silent-death vs failed-run vs wedged/in-progress so the next operator gets the diagnosis hint for free); `curate_never_succeeded` (no successful curate since the silo was first observed, past a grace window); and `curate_monitor_stale` / `curate_monitor_unreadable` (the monitor's own writer is dead, or its cache file is corrupt — the both-crons-dead freshness guard, computed from the cache file's `mtime` with **no** log fold, so it works precisely when the cron that would fold is dead).
- **Hysteresis + cooldown, biased toward silence.** Separate `STALE_DAYS=3` / `CLEAR_DAYS=1` thresholds give a 2-day dead band (Schmitt trigger — the verdict can't flap night-to-night around one boundary), and a shared 6h per-emit cooldown (`curate-emit.json`) collapses a read-burst in one session to ~one mention. 24h is the documented conservative knob if fatigue recurs.
- **`SILO_DISABLE_CURATE_LIVENESS`** — a *separate* opt-out from `SILO_DISABLE_UPDATE_CHECK`, so silencing update-fatigue does not also blind curate-death.
- **`EXIT` traps in `scripts/silo-curate.sh` + `scripts/silo-detect.sh`** — refresh the cache on every exit path including an early `exit` (a trailing `|| true` line would be skipped), registered *after* the flock so a flock-fail skip correctly does not fire them (the instance already running writes the status).
- New tests across `test/curate-liveness.test.js` (verdict / hysteresis / in-progress / first-run / cache I/O), `test/curate-status-cli.test.js` (CLI end-to-end + the writer→read-path contract the bridge glues), and `test/mcp-notices.test.js` (cooldown, monitor-freshness, opt-out independence, the discriminated-envelope contract, cache isolation).

### Changed
- **`deriveCuratorStatus` moved to `src/util/curate-liveness.js`** (from `src/cli/silo.js`) and exported, so the new subcommand *and* unit tests reuse it. `cmdDoctor` still renders the "Curate status" readout live and does **not** read the cache — doctor stays the independent live-fold backstop for the both-crons-dead case. It now also reports `last_event_kind` (the most-recent heartbeat's kind) so an in-progress run is identified by event *ordering*, not by the failure message that `deriveCuratorStatus` preserves across a later `run started`.

The dual-writer race the design panel converged on as the one blocker is **structurally absent**: the cron writes `curate-status.json`, the read path writes `curate-emit.json`, and no two processes ever read-modify-write the same file.

## [0.2.2] — 2026-06-14

`silo retire` — a first-class, audited primitive to retire curated Layer-2 bullets on demand. Additive (new CLI verb + MCP tool + ops module) plus one hardening edit to the curate command's retire emission. No schema or log-format change; rides the existing `TOPIC_BULLETS_RETIRED` event type. Ratified design (multi-reviewer gauntlet + independent source re-verification): [`proposals/retire-primitive.md`](proposals/retire-primitive.md).

### Added
- **`silo retire --slug=<s> --seq=<n>[,<n>...] [--reason=<txt>] [--to=<path>]`** — retire one or more currently-active CURATED bullets on a single topic, all-or-nothing. Re-validates every seq under the operation-log lock before appending, so a bad request never pollutes the append-only log with a no-op event. Strict `--seq` parsing (`^[1-9]\d*$` + safe-integer) rejects `1.5` / `12abc` / unsafe ints as usage errors. **Granularity:** retires the entire `write_event` at each seq — for import-origin writes that is a whole `## Heading` section, not a single line. No un-retire; restore by re-curating.
- **`retire_bullet` MCP tool** — mirrors the CLI 1:1; `destructiveHint: true` so generic clients confirm. `reason` is admission-matched (non-blank, single-line, ≤120 chars).
- **Tail-safety integrity gate.** Retire refuses (`LOG_INTEGRITY_UNSAFE`) when the operation log's physical tail is itself broken or malformed (`freshState.last_seq !== freshTail.seq`) — because `LogWriter._scanTailUnlocked` is hash-chain-blind, a new append would otherwise chain onto a broken tail and be silently orphaned. Does NOT trip on the production log's historical mid-log breaks (the tail stays folded). Manual-op only; the nightly curate emitter stays ungated (self-healing). Independently re-derived from source and confirmed by a fresh clean-room review before ratification.
- **`SILO_MCP_PRINCIPAL`** — one server-deployment principal routed through all four MCP write tools (`write_event` / `accept_suggestion` / `dismiss_suggestion` / `retire_bullet`), so a single caller never logs under two principals. Defaults to `desktop-claude` (prior behavior). Records *which deployment* wrote, not caller identity (shared bearer token).
- 24 new `test/retire-ops.test.js` cases (518 total), including both tail-gate branches (historical-middle-break allowed; broken / shape-malformed tail refused), TOCTOU, and every referential pre-flight error.
- **`scripts/silo-backup.sh`** — reference nightly snapshot of the silo data dir (`tar.gz` + integrity test + count-based rotation, default keep-14). Count-based rotation chosen over age-based so a silently-stalled backup cron freezes the archive set instead of draining it to zero. Hot-copy safe: the operation log's replay-safe prefix recovery means a snapshot taken mid-write is still a valid restorable log. Emits `[FACT] system:` status events (`source=silo-backup`) bookending each run, same pattern as curate/detect.

### Changed
- **`cmdCurate` retire emission is now lock-scoped (§B1).** Re-validates `superseded_seqs` against a fresh active-CURATED set under `withAppendLock` and reports the actually-retired set in its summary — so a concurrent manual `silo retire` can no longer make the nightly curate emit a no-op retire. Byte-identical payload on the common (no-race) path. The tail-safety gate is deliberately NOT mirrored here (the batch is self-healing).

### Fixed
- `printHelp` `--principal` default doc string corrected (`helder` → `operator`) to match the actual `GLOBAL_OPTIONS` default.
- README §Status: stale test count (129 → 494) and stale date; now also names the npm version alongside the v12.5 spec lineage.
- `src/admission/payload-validators.js` header comments no longer claim `write_event` is unvalidated (it has been since 0.2.0) and no longer track the M3 matrix-gate wiring as a pending follow-up (it shipped — the gate runs in `LogWriter._appendBatchUnlocked` before payload validation).

## [0.2.1] — 2026-05-24

UX polish release. CLI + docs only — no MCP bridge changes, no schema changes, no migration steps. Existing 0.2.0 installations continue to work without reconfiguration; this release adds a `--version` flag, sharper admission error messages, and a recommended Claude Code CLAUDE.md addition for batch-save behavior.

### Added
- `silo --version` / `silo -v` / `silo version` — print the version and exit. Same value `silo doctor` shows; just shorter to type.
- **Recommended CLAUDE.md catch-up directive for Claude Code + MCP users.** New "Recommended: catch-up directive for the Silo MCP bridge" section in [`quickstart/claude-code/SETUP.md`](quickstart/claude-code/SETUP.md). Drop-in rule for `~/.claude/CLAUDE.md` that codifies how the assistant should respond to "save to silo" / "catch up silo" / similar — retrospectively scan the conversation, write any silo-worthy events via `mcp__silo__write_event`, acknowledge inline as one short sentence, no confirmation prompts. Useful both as a safety net for what the in-the-moment `write_event` discipline missed AND as a cross-instance coordination tool when running parallel Claude Code instances against the same project.

### Changed
- `AdmissionValidationError` messages now inline `actual=` / `max=` / `tag=` from the detail object so the failure mode is readable without inspecting `.detail` programmatically. Field-specific hints added for the two `write_event` content rejections (length cap, multi-line for event-log tags) pointing at the right workaround (`tag=CURATED` for ≤50 KB Layer-2 sections, `tag=SOURCE` for ≤200 KB Layer-3 blockquotes).
- `silo` no-args usage banner now reads the version from `package.json` instead of the hardcoded `silo — v12.5 M1` string.

## [0.2.0] — 2026-05-19

Major release covering Phase 2.2 (topic proposal), Phase 2.3 (update notification), an audit-response round, the Universal-client compatibility surface (Stage 1 + 2 — ChatGPT / generic MCP clients), and M3 (matrix admission gate). Tag: [`phase-2.3-update-notification`](https://github.com/Studioscale/Silo/releases/tag/phase-2.3-update-notification).

### Migration notes — read this if upgrading from 0.1.x

**`write_event` admission is stricter.** Existing log entries are unaffected (admission only runs at write time), but new writes that previously succeeded may now reject. Concretely:

| Field | Pre-0.2.0 | 0.2.0+ |
|---|---|---|
| `slug` | accepted underscores, single-char slugs | canonical regex enforced: `^[a-z0-9]+(-[a-z0-9]+)*$`, length 2..40 |
| `tag` | any string | must be in `{FACT, DECISION, CHANGED, PROCEDURE, TODO, EVENT, SECURITY, CURATION, CURATED, SOURCE}` |
| `content` | any length | per-tag cap: 500 chars for event-log tags, 50_000 for CURATED, 200_000 for SOURCE |
| Multi-line `content` | tolerated, silently truncated in event-log projection | rejected at admission for event-log tags; use `tag=CURATED` or `tag=SOURCE` for long-form |

**If you've been writing ~1-3 KB content with an event-log tag** (`FACT`, `DECISION`, etc.), those writes now reject. The fix is one of:
- Switch the tag to `CURATED` (for Layer-2-style curated facts) or `SOURCE` (for Layer-3 raw material) depending on intent.
- Keep the entry under 500 chars.

**Matrix admission gate is now enforced.** Custom write paths that emit admin-only event types (`PRINCIPAL_*`, `ACL_SEALED`, `RECOVERY_MODE_*`) without explicitly passing `socket='admin'` will throw `AdmissionError`. The shipped `silo init` and other CLI paths are already updated; only custom integration code needs review.

**Hash chain verification on read.** `interpret()` now checks `entry.hash_prev` against the canonical hash of the previous accepted entry. Breaks land in `state.skipped` with `reason='hash_chain_break'`. `silo doctor` surfaces the count; `silo regenerate --strict` refuses to project from a log with breaks. Default non-strict regen still works.

If your existing log has historical chain breaks (e.g., from a prior migration), `silo doctor` will flag them — that's "accept-as-history" and doesn't block anything. Strict mode is opt-in for the cases where you want it.

**`update-status.json` cache file.** The Phase 2.3 update-check writes `<silo-dir>/update-status.json` on first CLI use. If you version-control your silo data dir (e.g., syncing memory across machines via git), add this file to your `.gitignore` — it's a per-machine cache, not portable. See [`reference/adapting-to-other-platforms.md`](reference/adapting-to-other-platforms.md) for the recommended `.gitignore` template.

### Added
- **Phase 2.2 — Topic proposal.** A daily cron clusters `general`-slug events; MCP `list_pending_suggestions` / `accept_suggestion` / `dismiss_suggestion` tools resolve them. Pending suggestions surface passively via `_silo_notices` arrays on read-tool responses. Per-slug cooldowns prevent re-proposal of dismissed clusters. New event types: `TOPIC_SUGGESTED`, `TOPIC_SUGGESTION_ACCEPTED`, `TOPIC_SUGGESTION_DISMISSED`. New CLI: `silo suggest --run-now | --list | --accept | --dismiss | --status | --bulk-scan`.
- **Phase 2.3 — Update notification.** Detached worker polls `github.com/Studioscale/Silo/releases/latest` once per 24h; surfaces `update_available` + `update_check_unhealthy` notices in the same `_silo_notices` array. `silo doctor` for diagnostics; `SILO_DISABLE_UPDATE_CHECK=1` to opt out.
- **Universal-client compatibility (Stages 1 + 2).** Stage 1: `fetch` tool (OpenAI MCP-compatible shape), enriched `search` results with `id`/`title`/`url`/`metadata`, tool annotations (`readOnlyHint` / `idempotentHint`) on all 13 MCP tools. Stage 2: `silo_bootstrap` tool returning a structured client contract (`contract_version` + `capabilities` + retrieval rules + tool catalog); `silo_context_pack_v0` returning task-relevant topics with BM25-ranked confidence scoring.
- **M3 — Matrix admission gate.** `LogWriter._appendBatchUnlocked` now calls `Matrix.isAdmissible(type, socket, mode)` before payload validation. Defense-in-depth against unintended admin-event emission.
- **`fs-ext` cross-process flock.** Optional dependency; provides real flock(2) on Linux/macOS with a build toolchain. Degrades to single-process mutex on Windows / without toolchain.
- **`silo doctor` diagnostic.** Shows local version, LLM provider config, update-check status, operation-log tail, hash-chain integrity, and curate-cron health.
- **`silo regenerate --strict`.** Refuses to project Zone B from a log with hash-chain breaks or shape-malformed entries.
- **Cron status events.** Both `silo-detect.sh` (new) and `silo-curate.sh` (existing, now updated) emit `[FACT] system: silo-detect|curate run started|complete|failed` events; `silo doctor` parses these for health.
- **README sections.** Threat model + known limitations; "When the API call fails" with the error-category taxonomy + retry policy.

### Changed
- **Default OpenAI model.** `gpt-4o` → `gpt-5.4` for `silo extract` / `silo curate`. The README's Prerequisites table now flags Sonnet-4-6 + GPT-5.4 as recommended; cheaper tiers (Haiku, 4o-mini) "compile and run but the output quality drops noticeably on anti-bundling + retire-detection."
- **Slug regex unified.** `src/distill/parse.js` was accepting underscores via `[a-z0-9][a-z0-9_-]*`; now matches the canonical `[a-z0-9]+(-[a-z0-9]+)*` from `src/admission/slug.js`.
- **MCP search hardened.** The bridge's `search` tool previously built a `docker exec` shell command from the query and ran it via `execSync` — exploitable as command injection if a bearer token leaked. Now uses `spawnSync` with argv. Same defense-in-depth applied to remaining shell calls in the bridge.

### Security
- **Fixed: MCP command injection** in the `search` tool (above).
- **Tool annotations** mark read-only vs write/side-effect tools per OpenAI Apps SDK security guidance, enabling least-privilege + confirmation-prompt UX in compatible clients.

### Deprecated / Removed
- Nothing removed. The Universal-client work is purely additive; existing CLI commands and MCP tools behave the same way as before for callers that don't opt into the new surface.

---

## [0.1.0] — Initial v12.5 production

Operation log as source of truth; Zone B projections (topic files, event logs, TOPIC-INDEX.md) regenerable from the log. Three layers per topic file: header / curated facts / source material. CLI: `init`, `status`, `write`, `read`, `search`, `import-jarvis`, `extract`, `curate`, `regenerate`. MCP bridge with bearer-token auth + 7 tools (read_index, get_topic, read_events, search, list_handoffs, write_event, write_handoff). Tested through 57 audit rounds across 19 drafts (Claude / ChatGPT / Gemini reviewers).
