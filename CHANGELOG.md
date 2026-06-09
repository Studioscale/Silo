# Changelog

All notable changes to Silo. Format loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows what `package.json` declares (which the in-band update check compares against `releases/latest` on GitHub).

## [Unreleased]

### Added
- **`scripts/silo-backup.sh`** — reference nightly snapshot of the silo data dir (`tar.gz` + integrity test + count-based rotation, default keep-14). Count-based rotation chosen over age-based so a silently-stalled backup cron freezes the archive set instead of draining it to zero. Hot-copy safe: the operation log's replay-safe prefix recovery means a snapshot taken mid-write is still a valid restorable log. Emits `[FACT] system:` status events (`source=silo-backup`) bookending each run, same pattern as curate/detect.

### Fixed
- README §Status: stale test count (129 → 494) and stale date; now also names the npm version (0.2.1) alongside the v12.5 spec lineage.
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
