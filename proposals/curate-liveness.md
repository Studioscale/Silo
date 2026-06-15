# SPEC — Curate-Liveness "Check-Engine Light"

**Purpose:** Passively surface a `_silo_notices` warning when the nightly curation job hasn't *successfully* run in N days, so a silent curate outage is caught without anyone running `silo doctor`.

**Status: RATIFIED — round-2 converged (2026-06-11)**
**Round-2 panel:** fresh Claude (READY-WITH-CHANGES) + fresh ChatGPT (READY-WITH-CHANGES), both "no new blocker/major." The Gemini seat was **discarded** (ran on Flash while Pro was rate-limited; category-errored by flagging unbuilt design-spec features as missing-implementation BLOCKERs — verified invalid). All round-2 minors (**L1**, **L2**, **R2-Live-3**) folded below. Adjudication: `silo-design-history/11-retire-and-liveness-audit-archive/ROUND2-FOLD-SYNTHESIS.md` ("Liveness — CONVERGED" is authoritative).
**Supersedes:** the v1 draft at `silo-design-history/11-retire-and-liveness-audit-archive/SPEC-curate-liveness.md` (DRAFT, pre-audit). Round-1 change→finding map: `silo-design-history/11-retire-and-liveness-audit-archive/ROUND2-CHANGELOG.md`.
**Folds:** the round-1 3-reviewer adjudication panel (fresh Claude, ChatGPT, Gemini) recorded in `silo-design-history/11-retire-and-liveness-audit-archive/FOLD-SYNTHESIS.md` ("Liveness — fold decisions" is authoritative), plus the round-2 minors (see Round-2 panel above). All §9 open questions are RESOLVED below.
**Repo:** `C:\Users\studi\OneDrive\Desktop\Claude Code\silo` (paths below are repo-relative; runtime paths are VPS-absolute)
**Ships as:** v0.2.4 (implementation order: retire → v0.2.2, liveness → v0.2.4).

---

## 0. What the audit changed (delta from the draft)

The draft was rated READY-WITH-CHANGES by Claude and ChatGPT, NOT-READY by Gemini. Every NOT-READY/MAJOR converged on **one** structural fault — the dual-writer race on `curate-status.json` — plus a cluster of smaller hardening items. The ratified design folds all of them:

| # | Change | Source finding | Section |
|---|---|---|---|
| 1 | **Split the emit-stamp into its own file** (`curate-emit.json`). Cron writes status-only `curate-status.json`; the MCP read path writes its own cooldown stamp. No shared file → the dual-writer RMW race is dissolved, not merely tolerated. | Gemini BLOCKER + ChatGPT MAJOR + Claude MAJOR (unanimous fix) | §5.1, §5.5, §5.7, §6 |
| 2 | **Both crons write the status.** In-band tail call in `silo-curate.sh` (immediate recovery reflection at 05:00) **and** out-of-band call in `silo-detect.sh` (death detection when curate is dead). | Adjudicated (Claude ≤24h-latency vs ChatGPT post-curate-timing) | §4, §5.3, §7 |
| 3 | **Both-crons-dead freshness guard, built.** The read path raises a distinct notice when the status file's own `mtime`/`computed_at` is older than `STALE_DAYS` — works when the cron writer is dead. Minimal: one extra read-path condition, not a registry. | Claude + ChatGPT "build it"; Gemini #2 agrees on the mechanism, only objects to over-framing | §5.8, §7 F2 |
| 4 | **First-run / never-succeeded blind spot closed.** Persist `first_observed_at`; if curate has never succeeded and `first_observed_at` is older than a grace window, emit a "never succeeded" notice (same cooldown). | ChatGPT MAJOR | §5.1, §5.4, §7 F4 |
| 5 | **Separate `SILO_DISABLE_CURATE_LIVENESS` env var** — does NOT reuse `SILO_DISABLE_UPDATE_CHECK`. | ChatGPT MAJOR + Claude | §5.6 |
| 6 | **Unconditional run via bash `trap`**, not `\|\| true` after the body — fires even if the host script `exit`s early. | ChatGPT MAJOR #2 | §5.3 |
| 7 | **In-progress (started, no terminal) treated as stale**, with a dedicated "started but not completed" message branch. | Unanimous (ChatGPT nuance) | §5.7, §7 F3 |
| 8 | **Robustness:** invalid/NaN `last_emitted_at` → treat as "due" (don't suppress forever); malformed/unreadable status file → a "monitor-unreadable" notice after cooldown (reconciled with #3 into one coherent "monitor is broken" signal). | ChatGPT MINORs | §5.5, §5.8, §7 F7 |
| 9 | **`foldLiveness`'s full output object pinned** — every field specified. With the stamp split out (#1) it no longer carries `last_emitted_at`. | impl-blocking under-spec | §5.4 |
| 10 | **`loadCurateStatus` gets its OWN `curateCache` module var** — not a reuse of `updateCache`. | impl-blocking under-spec | §6 |

Panel **consensus kept from the draft** (no change): dedicated `silo curate-status` subcommand (not piggyback); doctor stays live-fold-only; `STALE_DAYS=3` / `CLEAR_DAYS=1`; `EMIT_COOLDOWN` 6h (24h as the conservative knob); reuse update-check's atomic-write + mtime-cache patterns; `deriveCuratorStatus` must be exported for tests.

> **Line-citation note.** All `file:line` anchors below are reconciled against the current tree (the draft's citations had drifted by a few lines). Verified anchors: `deriveCuratorStatus` at `src/cli/silo.js:1230` (returns `{last_run_at, last_success_at, consecutive_failures, last_failure_msg}` at `:1260-1265`, **returns `null` when no curate events** at `:1259`); auto-fire gate at `src/cli/silo.js:1385`; dispatcher switch `:1394-1432`; `buildSiloNotices` signature `{pendingPath, updateStatus, updateCheckDisabled}` at `silo-mcp/notices.js:111`; `updateCache` module var at `notices.js:26`; `siloNoticesForRead` at `silo-mcp/server.js:212-219`; `UPDATE_STATUS_PATH` at `server.js:55`; atomic write at `src/util/update-check.js:107-115`; failure fold at `:203-219`.

### Round-2 → ratified (delta from REVISED DRAFT v2)

The round-2 panel (fresh Claude RWC + fresh ChatGPT RWC) raised **no new blocker/major** — only three minors, all folded here. The Gemini seat was discarded (Flash category-error; invalid). The two competent seats converged, so liveness is RATIFIED.

| # | Minor | Source | Fix folded | Sections |
|---|---|---|---|---|
| **L1** | The freshness guard can't see the file mtime: `loadCurateStatus` cloned from `loadUpdateStatus` (`silo-mcp/notices.js:62-77`), which returns only parsed JSON — `mtimeMs` is never exposed, so `resolveMonitorFreshness` had nothing to key off. | Claude + ChatGPT | `loadCurateStatus` now returns a **discriminated envelope** `{kind:'ok',status,mtimeMs} \| {kind:'absent'} \| {kind:'corrupt',mtimeMs?}`; `resolveMonitorFreshness` and the read-path notice logic consume the envelope (no separate `stat()`). | §5.7, §5.8, §6, T17–T33 |
| **L2** | The `undefined`-as-malformed sentinel (ENOENT→`null`, corrupt→`undefined`) collides with "caller omitted the arg." | Claude + ChatGPT | The envelope from L1 removes the overload: absent → `{kind:'absent'}`, corrupt → `{kind:'corrupt'}`. §5.7/§6 now specify the loader's error path explicitly and stop calling it a field-for-field clone of `loadUpdateStatus` (it deliberately diverges there). | §5.7, §6 |
| **R2-Live-3** | "started but not completed" was masked after a prior failure: `deriveCuratorStatus` (`src/cli/silo.js:1244-1257`) preserves `last_failure_msg` until a `run complete`, so a post-failure `run started` with no terminal still carried the old failure message → the read path picked the "failed" branch instead of "started but not completed." | ChatGPT | `foldLiveness` now detects in-progress by **event ordering** (`raw.last_event_kind === 'started'`), not by `last_failure_msg == null`. `deriveCuratorStatus` gains `last_event_kind`. New fixture: success → failure → started/no-terminal → expect "started but not completed," not the failed branch. | §5.4, §5.7, §7-F3, T10, T15a, T27 |

---

## 1. Reviewer orientation (read this first)

This feature rides existing primitives. Three things to know:

- **It clones the update-check subsystem.** `src/util/update-check.js` + `silo-mcp/notices.js` already implement *exactly* the cache-file-plus-passive-notice pattern this feature needs. Wherever this spec says "mirror X", X is real, shipped code — cited by file:line.
- **The owner just had notice-fatigue** from a *correct* `update_available` notice that nagged every read. Notice-spam is a first-class failure mode here. The design is biased toward silence: separate stale/clear thresholds (can't flap) + a per-emit cooldown (nags ~once/session, not per-read).
- **One sketch claim was wrong and the code won.** The motivating analysis said curate/detect status events use `source=silo-curate` / `source=silo-detect`. Curate is right; **detect's source value is actually `silo-topic-detector`** (`scripts/silo-detect.sh:62`). Corrected throughout. This does not affect the design (we host in detect's *cron*, and read curate's *events*), but reviewers checking the sketch against the code should know it was reconciled.

---

## 2. Problem & motivation

Curation is Silo's entire quality mechanism: the nightly `silo curate` pass is what promotes raw events into Layer-2 durable bullets and retires stale ones. If it stops, memory silently rots — new facts never consolidate, and nothing in the read path looks different.

**This session it was silently dead for ~10 days.** The cron fired nightly on schedule, but `scripts/silo-curate.sh` had lost its executable bit and the kernel refused to exec it — it died *before its first line ran*. The heartbeat that would have reported the failure (`silo-curate run started` / `... failed`, written from *inside* the script at `scripts/silo-curate.sh:51` and `:84`) never got the chance to fire. **The heartbeat died with the monitored process.** No `started`, no `failed`, no log line — just silence. (Root cause now fixed and snapshotted: commit `d11599d` "fix: mark cron entrypoint scripts executable 100644 → 100755".)

A diagnostic already exists — `silo doctor` parses those same status events into a "Curate status" readout (last run / last success / consecutive failures) via `deriveCuratorStatus` (`src/cli/silo.js:1230`). **But it is pull-only.** Nobody runs `silo doctor` unprompted; the 10-day gap proves it. The signal exists; it just never reaches anyone passively.

**The fix:** a single passive "check-engine light" on the existing MCP notice rail (`_silo_notices`) that lights up when curate's last *success* is too old — written **out-of-band** from curate (by detect) so it can report curate's death even when curate can't, and **in-band** from curate (when alive) so a recovery is reflected the moment it happens. With a read-path freshness guard so even a *both-crons-dead* outage isn't completely dark.

---

## 3. Goals / Non-goals

### Goals
- G1. When curate's last successful run is older than a staleness threshold, surface **one** notice (`curate_liveness_stale`) on the `_silo_notices` rail that MCP read tools already carry.
- G2. The death-detection path runs **out-of-band** from `silo-curate.sh` — hosted in detect, structurally guaranteed to be alive when curate is dead. (The whole bug is that curate's own heartbeat can't outlive curate.) An **additional** in-band tail call in curate reflects a *recovery* immediately, without reintroducing that dependency (the in-band call only runs when curate is alive; death is caught by detect).
- G3. Rare, high-signal, hysteresis-guarded, dismissable. A correct notice must not nag on every read. It must not flap night-to-night around the threshold boundary.
- G4. Auditable & cheap: ride existing primitives, no new daemon, no change to the log/projection model, smallest viable diff. Reuse `deriveCuratorStatus`, the atomic-write cache pattern, the opt-out family.
- G5. **No single-point monitor blindness.** If the status writer itself dies (both crons down) or its file is corrupt, the read path still raises a *distinct* signal rather than going silently dark (§5.8). This is the freshness guard the panel voted to build.

### Non-goals
- NG1. **A general health-monitoring framework.** This is ONE light for ONE subsystem (curate) plus a minimal self-freshness check on its own writer. Not a plugin system, not a registry of monitored jobs, not a generic "liveness rule engine". If detect later wants the same treatment it copies this, deliberately, in its own diff. The freshness guard (#3) is explicitly *one extra read-path condition*, not the seed of a registry — see §5.8.
- NG2. Changing the operation-log model, the projection model, or the heartbeat event format. We *read* existing status events; we never add a new event type or a new projected field.
- NG3. Active alerting (push to Telegram, email, etc.). The notice rail is the delivery channel. The consuming LLM decides whether to mention it, exactly as it does for `pending_topic_suggestions` and `update_available`. (Gemini's suggested external watchdog — e.g. Healthchecks.io for true global cron observability — is a valid *external complement* but is out of scope for Silo and is **not** a substitute for the read-path guard; see §9c resolution.)
- NG4. Fixing the `deriveCuratorStatus` / `deriveDetectorStatus` near-duplication (see §10). Flagged, out of scope.

---

## 4. Design overview

Four pieces: two cron writers, one cache file (plus a tiny separate emit stamp), and the read-path consumer. Each is a near-clone of a shipped update-check counterpart.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ silo-detect.sh   (cron, 04:00 UTC — ALWAYS-ALIVE relative to curate)      │
│   ... existing detect pass + regen ...                                    │
│   trap 'node silo.js curate-status …' EXIT   ← NEW (death-detection path) │
│        └─ unconditional via trap: fires even if detect exits early        │
└──────────────┬────────────────────────────────────────────────────────────┘
               │                                                  ┌──────────┐
┌──────────────┴──────────────────────────────────────────────┐ │ writes   │
│ silo-curate.sh   (cron, 05:00 UTC — the MONITORED job)        │ │ STATUS   │
│   ... existing curate pass + regen + status heartbeat ...     │ │ ONLY     │
│   trap 'node silo.js curate-status …' EXIT   ← NEW (recovery) │ │          │
│        └─ only runs when curate is alive → reflects success   │ ▼          │
└──────────────────────────────────────────────────────────────┘ <silo-dir>/
                    both invoke ────────────────────────────────► curate-status.json
                    silo curate-status                            (NO last_emitted_at)
                         │                                              │
                         │ each does its OWN interpret() fold,          │ mtime-cached read
                         │ deriveCuratorStatus, hysteresis,             ▼
                         │ atomic-writes curate-status.json    ┌─────────────────────────┐
                         ▼                                     │ silo-mcp/notices.js      │
              deriveCuratorStatus (reuse, now exported)        │   loadCurateStatus()     │  ← curateCache
                                                               │   + curate_liveness_stale│
                                                               │   + curate_never_succeed │
   <silo-dir>/curate-emit.json   ← NEW, written ONLY by the    │   + curate_monitor_stale │
   read path. Holds last_emitted_at. No cron writer ever       │   (freshness/unreadable) │
   touches it → the dual-writer race is structurally gone.     │   → into _silo_notices   │
                         ▲ read-modify-written by read path ───┘ on read_index/search/...
```

**Why pre-compute into a cache (the load-bearing decision):**
The update-check notice is cheap to compute on every MCP read because `loadUpdateStatus` is a tiny mtime-cached JSON read (`silo-mcp/notices.js:62-77`). Curate-liveness is *not* cheap: deriving it requires a full `interpret()` fold over the operation log (`deriveCuratorStatus` consumes `state.topic_content` / `state.seq_to_event`, `src/cli/silo.js:1231-1237`). Paying a full log fold on **every** MCP read is wrong — reads are hot, the fold is heavy. So we **pre-compute** the verdict into `curate-status.json` on a cadence (nightly, in the crons) and the read path only does the same cheap mtime-cached JSON read it already does for updates. This is the exact split update-check uses (worker computes; MCP reads cache) — we just relocate the "worker" into the crons instead of a detached subprocess, because the cadence is daily, not per-invocation.

**Why both crons write it (resolves the timing question):**
- **detect (04:00, out-of-band) is the death detector.** detect and curate are *independent* cron entries with *independent* exec bits, *independent* lockfiles (`/var/lock/silo-detect.lock` vs `/var/lock/silo-curate.lock`), and *independent* failure surfaces. Detect kept running through the entire 10-day curate outage — it is empirically the always-alive sibling. When curate is dead and can't write its own status, detect's call is what ages `last_success_at` into staleness and trips the light.
- **curate (05:00, in-band tail) is the recovery reflector.** When curate runs successfully, its own tail call rewrites `curate-status.json` immediately — so a fixed/recovered curate clears the light *that night at 05:00* instead of waiting up to 24h for the next detect run. The in-band call only executes when curate is alive enough to reach its trap, so it does **not** reintroduce "the heartbeat dies with the monitored" — detect's out-of-band call is the one that catches death. Best of both: immediate recovery + reliable death detection. (Adjudicated: Claude's ≤24h-recovery-latency concern + ChatGPT's post-curate-timing preference, resolved by writing from both.)

**Why a separate emit-stamp file:** see §5.5. In one line: the cron writes the *status*, the read path writes the *cooldown stamp*, and putting them in different files means no two processes ever read-modify-write the same file — the entire race class the panel blocked on simply cannot occur.

---

## 5. Detailed design

### 5.1 `curate-status.json` schema (STATUS ONLY — no emit stamp)

Lives at `<silo-dir>/curate-status.json` — i.e. under `SILO_DIR` (`/root/.silo`, the data dir), **not** `SILO_BASE` (the projection target). This matches where `update-status.json` is pinned (`silo-mcp/server.js:55`, `const UPDATE_STATUS_PATH = join(SILO_DIR, 'update-status.json')`): the CLI writes under `SILO_DIR`; the MCP server reads from the same place.

Fields mirror `update-status.json` (built by `performCheck`, `src/util/update-check.js:187-219`) where the analogy holds. **The cooldown stamp `last_emitted_at` is NOT in this file** — it lives in `curate-emit.json` (§5.5), written only by the read path. This file has exactly one writer: `silo curate-status` (called by both crons).

```jsonc
{
  "schema_version": 1,              // mirror update-check SCHEMA_VERSION (update-check.js:41)

  // ── Raw facts folded from deriveCuratorStatus(state) ──
  "last_run_at":            "2026-06-10T05:00:31Z",  // any started|complete|failed, or null
  "last_success_at":        "2026-06-10T05:00:31Z",  // last "run complete" ts, or null
  "consecutive_failures":   0,                        // running count of "run failed"
  "last_failure_msg":       null,                     // full content of last "run failed", or null
  "last_event_kind":        "complete",              // 'started' | 'complete' | 'failed' | null — the MOST RECENT curate event's kind (R2-Live-3 in-progress discriminator)
  "in_progress":            false,                    // most recent event is 'started' with no later terminal (F3)

  // ── Liveness verdict (computed here, the new part) ──
  "computed_at":            "2026-06-11T04:00:12Z",  // when THIS check ran (≈ update-check last_checked_at); ALSO the freshness anchor for the both-down guard (§5.8)
  "days_since_success":     0.96,                     // (computed_at - last_success_at) in days, or null if never
  "is_stale":               false,                    // the hysteresis-resolved verdict (see 5.4)

  // ── First-run blind-spot guard (5.4 / F4) ──
  "first_observed_at":      "2026-05-30T04:00:09Z"    // earliest computed_at ever persisted; carried forward. Anchors the "never succeeded" grace window.
}
```

Notes:
- `last_run_at` / `last_success_at` / `consecutive_failures` / `last_failure_msg` / `last_event_kind` are copied verbatim from `deriveCuratorStatus`'s return object (`src/cli/silo.js:1260-1266` — `last_event_kind` is the R2-Live-3 addition), so this file is *also* a doctor-grade snapshot.
- `last_event_kind` is the kind (`'started'` / `'complete'` / `'failed'`) of the **most recent** curate heartbeat event, or `null` when there are none. It is the in-progress discriminator (R2-Live-3): unlike `last_failure_msg` — which `deriveCuratorStatus` preserves across a later `run started` until the next `run complete` (`src/cli/silo.js:1250` only clears it on complete) — `last_event_kind` reflects the *actual ordering*, so a post-failure `started`-with-no-terminal is correctly identified as in-progress rather than failed.
- `in_progress` is derived inside `foldLiveness` (not returned by `deriveCuratorStatus`): true iff `last_event_kind === 'started'` (the most recent event is a `started` with no following terminal). This keys off event ordering, **not** `last_failure_msg == null` — so a `success → failure → started(no terminal)` history is in-progress (R2-Live-3 fix), even though `last_failure_msg` still carries the stale failure text. See §5.4 and F3.
- `computed_at` doubles as the **freshness anchor** for the both-crons-dead guard (§5.8). Because the *file's* `mtime` is what the read path checks (cheap, no fold), `computed_at` is the in-band cross-check; the guard primarily keys off `stat().mtimeMs` and treats `computed_at` as the tie-break/diagnostic.
- `first_observed_at` is **persisted and carried forward** across runs: on each write, `next.first_observed_at = prior?.first_observed_at ?? now`. It anchors the never-succeeded grace window so a brand-new silo stays dark for the grace period, then lights up if curate has *still* never completed (F4).
- `is_stale` is **persisted**, not recomputed by the reader, because hysteresis needs the *prior* verdict to resolve (§5.4). The MCP read path must not need the prior — it just reads `is_stale`.
- Malformed / missing file → §5.8 (the read path raises a `curate_monitor_stale`/unreadable notice after cooldown, rather than silently emitting nothing — reconciled with the freshness guard so there is **one** coherent "monitor is broken" signal). The cron's own `readCurateStatus` still treats malformed-prior as absent (mirrors `readCache`, `update-check.js:96-105`) so a corrupt file self-heals on the next write.

### 5.2 The `silo curate-status` subcommand

New CLI subcommand in `src/cli/silo.js`. It does **not** run curate — it only *reads the log and writes the verdict cache*. Pseudocode:

```js
async function cmdCurateStatus({ 'silo-dir': siloDir, now = Date.now() }) {
  const writer = await openWriter(siloDir);             // src/cli/silo.js:82
  const state  = await interpret(writer);               // imported at silo.js:34
  const raw    = deriveCuratorStatus(state);            // silo.js:1230 — MUST be exported now; may be null
  const prior  = await readCurateStatus(siloDir);       // clone of readCache (update-check.js:96)
  const next   = foldLiveness({ raw, prior, now,        // hysteresis + first_observed + in_progress (5.4)
                                staleDays: STALE_DAYS, clearDays: CLEAR_DAYS });
  await writeCurateStatus(siloDir, next);               // clone of writeCache atomic write (update-check.js:107)
  // NOTE: writes curate-status.json ONLY. Never touches curate-emit.json.
}
```

Registration (mirror existing cases):
- Add `case 'curate-status': await cmdCurateStatus(values); break;` to the dispatcher switch (alongside `src/cli/silo.js:1394-1432`).
- Add a `commands:` line to `printHelp()`.
- **Exclude it from the `maybeFireUpdateCheck` auto-fire gate** at `src/cli/silo.js:1385` — that gate already excludes `doctor`/`help`/`init`; add `curate-status` so the liveness writer doesn't itself trigger an update-check spawn on every cron run. (It's a cron-frequency call; keep it side-effect-free.)
- Writes use the same **atomic unique-tmp + rename** as `writeCache` (`src/util/update-check.js:107-115`: `${finalPath}.${process.pid}.${Date.now()}.tmp` → `fs.rename`). With the emit stamp split out (§5.5), `curate-status.json` now has a *single* writer-class (`curate-status`, serialized per-cron by each cron's bash flock, but two **different** crons can run it 1h apart). Atomic write still matters: it makes the read path's mtime-cached read never observe a torn file, and it keeps the two crons' writes from interleaving badly.

`deriveCuratorStatus` changes required (two, both small):
1. **Export it.** It is currently **module-private** (confirmed by `test/status-events.test.js:8-10`, which can only test it through end-to-end `silo doctor` CLI runs). To reuse it from `cmdCurateStatus` (same module, so technically callable) **and** unit-test `foldLiveness` against its output, export it. One-line `export` addition.
2. **Return `last_event_kind`** (R2-Live-3). The fold loop (`src/cli/silo.js:1244-1257`) already branches on `run started` / `run complete` / `run failed`; record which branch ran *last* into a `lastEventKind` local (`'started'` / `'complete'` / `'failed'`) and add it to the return object (`null` when no curate events → still `null` per the `:1259` guard). This is needed because `last_failure_msg` is preserved across a later `run started` (it only clears on `run complete`, `:1250`), so it cannot distinguish a post-failure in-progress run from a failed one. `last_event_kind` keys off ordering and can. The existing four fields are unchanged; this is purely additive. `cmdDoctor` does not need to consume it (it stays live-fold-only, §6), so no doctor-rendering change.

These are the only edits to existing curate-status-parsing logic.

### 5.3 Where the crons call it — unconditional via `trap`

Both `scripts/silo-curate.sh` and `scripts/silo-detect.sh` get the call. Both currently run under `set -uo pipefail` (no `-e`) and **`exit` with the monitored job's status** as their final statement (`silo-curate.sh:97` `exit "$CURATE_STATUS"`, `silo-detect.sh:106` `exit "$DETECT_STATUS"`). A trailing `node … || true` line placed before that `exit` would be skipped whenever the script took an early `exit` (e.g. the flock-fail `exit 0` at `silo-curate.sh:31` / `silo-detect.sh:35`, or any future early return). **So the call is installed as a `trap … EXIT`** — it fires on *every* path out of the script, including early exits, without changing the script's exit code.

ChatGPT MAJOR #2 ("a `|| true` after the body doesn't run if the script exits early") is the reason. The trap is the fix.

**Trap placement** — register it *after* env/locks are set up (so `$SILO_SRC`, `$SILO_DIR`, `$LOG` are defined) and after the flock is acquired, i.e. immediately after the `source "$ENV_FILE"` block (`silo-curate.sh:39` / `silo-detect.sh:44`). Registering it after the flock means a flock-fail early-exit (another instance already running) does **not** fire it — correct, because the other instance will write the status. Registering it before the main pass means it fires no matter how the pass exits.

In **`scripts/silo-curate.sh`** (the monitored job — in-band recovery reflector):

```bash
# Curate-liveness: refresh the liveness cache on EVERY exit path (success,
# failure, or an early `exit` later in the script). In-band here means a
# SUCCESSFUL curate run reflects recovery immediately at 05:00 — it does NOT
# replace detect's out-of-band call, which is what catches curate *death*
# (a dead curate never reaches this trap). Non-fatal: subshell, never alters
# this script's exit code. See SPEC-curate-liveness §4/§5.3.
trap 'node "$SILO_SRC/src/cli/silo.js" curate-status --silo-dir="$SILO_DIR" >> "$LOG" 2>&1 || true' EXIT
```

In **`scripts/silo-detect.sh`** (the always-alive sibling — out-of-band death detector), the identical trap, placed after `:44`:

```bash
# Curate-liveness check — runs out-of-band from silo-curate so a curate
# outage is detectable even when curate's own heartbeat is dead. Fires on
# every exit path of this cron (trap, not a trailing line, so an early
# `exit` still refreshes it). Non-fatal. See SPEC-curate-liveness §4/§5.3.
trap 'node "$SILO_SRC/src/cli/silo.js" curate-status --silo-dir="$SILO_DIR" >> "$LOG" 2>&1 || true' EXIT
```

Notes:
- `cmdCurateStatus` does its **own** fresh `interpret()` fold (it cannot piggyback the host script's in-process projection regen — that ran in a *separate* `node` invocation). The "the cron already pays a fold this hour" point is about *amortized cron budget*, not sharing an in-memory `state` object. §9b resolution (DECIDED: dedicated subcommand) keeps it this way deliberately — see §9.
- Two traps, two crons, one file: detect writes it at 04:00, curate rewrites it at 05:00. They never overlap (1h apart, different flocks) and each does a full atomic write, so there is no interleaving hazard. The freshness anchor (`computed_at`/`mtime`) is simply "whichever cron wrote last."
- The `\|\| true` inside the trap is belt-and-suspenders so a `curate-status` non-zero exit can never propagate as the trap's status (a trap's failing command would otherwise replace `$?`); `set -e` is not in effect, but the guard makes intent explicit.

### 5.4 Hysteresis (anti-flap), first-run guard, and in-progress — `foldLiveness`

`foldLiveness` is the pure verdict function. It takes `{ raw, prior, now, staleDays, clearDays }` and returns the **complete** persisted object below (#9 — fully pinned; with the stamp split out, it carries **no** `last_emitted_at`):

```jsonc
// foldLiveness return shape (the WHOLE of curate-status.json minus schema_version,
// which writeCurateStatus stamps):
{
  "last_run_at":          string | null,   // raw.last_run_at (raw may be null → null)
  "last_success_at":      string | null,   // raw.last_success_at
  "consecutive_failures": number,          // raw.consecutive_failures ?? 0
  "last_failure_msg":     string | null,   // raw.last_failure_msg
  "last_event_kind":      string | null,   // raw.last_event_kind ('started'|'complete'|'failed'|null)
  "in_progress":          boolean,         // see below — keyed off last_event_kind, NOT last_failure_msg
  "computed_at":          string,          // new Date(now).toISOString()
  "days_since_success":   number | null,   // (now - Date.parse(last_success_at))/DAY_MS, or null
  "is_stale":             boolean,         // hysteresis-resolved (below)
  "first_observed_at":    string           // prior.first_observed_at ?? new Date(now).toISOString()
}
```

**Two separate thresholds** so the verdict cannot flap night-to-night around a single boundary:

- **STALE_DAYS = 3** — `is_stale` flips `false → true` only when `days_since_success > 3`. Curate runs nightly, so 3 days tolerates **~2 consecutive missed nights** before lighting up. One blip (a single failed/skipped night) stays dark.
- **CLEAR_DAYS = 1** — once stale, `is_stale` flips `true → false` only when `days_since_success ≤ 1`, i.e. only after a *genuinely fresh* success (last night). It does NOT clear merely by dropping back under 3.

Because `set` (3) and `clear` (1) differ, the verdict has a 2-day dead band: a `days_since_success` oscillating between 1.5 and 2.5 cannot toggle the light. Schmitt-trigger pattern; `is_stale` is persisted (§5.1) so the prior verdict is available to resolve the band. Constants live in the curate-status module, mirroring how `HEALTHY_FAILURE_THRESHOLD=7` is a constant in update-check (`src/util/update-check.js:42`).

**`first_observed_at` + never-succeeded (F4, #4).** A separate `NEVER_SUCCEEDED_GRACE_DAYS` window (default **2 days**, = STALE_DAYS-1, so a fresh deploy gets two nightly attempts before the light can fire) gates the never-succeeded case. The read path (§5.7), not `foldLiveness`, decides whether to *emit* the never-succeeded notice; `foldLiveness` just persists the facts the read path needs (`last_success_at == null`, `first_observed_at`, `computed_at`).

**`in_progress` (F3, #7; corrected by R2-Live-3).** Set true when the most recent curate event is a `started` with no following terminal — operationally, **`raw.last_event_kind === 'started'`**. This is a wedged-or-running run. It does **not** clear staleness (staleness keys off *success* age) but it lets the read path emit a "started but not completed" message branch (§5.7) instead of the generic silent-death or failed text.

> **R2-Live-3 (ChatGPT MINOR).** The v2 spec keyed `in_progress` off `last_failure_msg == null`. That **masks** a real in-progress run: `deriveCuratorStatus` preserves `last_failure_msg` across a later `run started` (it only clears on `run complete`, `src/cli/silo.js:1250`), so a `success → failure → started(no terminal)` history still carries the failure text, `in_progress` evaluated false, and the read path picked the **failed** branch instead of "started but not completed." Keying off `last_event_kind` (which reflects the actual event ordering) fixes it. The failure *counter* (`consecutive_failures`) is still preserved separately, so we don't lose the failure history — we just stop letting a stale failure *message* hide the fact that a newer run is in flight.

`foldLiveness` logic:
```
days = last_success_at == null ? null : (now - Date.parse(last_success_at)) / DAY_MS

in_progress = raw != null && raw.last_event_kind === 'started'
              // ↑ event-ordering, NOT `last_failure_msg == null` (R2-Live-3).
              //   `success → failure → started(no terminal)` is correctly
              //   in_progress even though last_failure_msg still carries the
              //   stale failure text. The terminal-less `started` is the most
              //   recent event ⇒ last_event_kind === 'started'.

if days == null:                 // never succeeded
    is_stale = false             // do NOT set the hysteresis light; the
                                 // never-succeeded notice is a SEPARATE read-path
                                 // branch gated on first_observed_at age (F4/§5.7)
elif days < 0:                   // success timestamped in the future (clock skew) → fail-safe
    is_stale = false
elif prior.is_stale:             // currently lit
    is_stale = (days > CLEAR_DAYS)   // stay lit until a fresh success
else:                            // currently dark
    is_stale = (days > STALE_DAYS)   // light only after sustained silence
```

The asymmetry is enforced by branching on `prior.is_stale`, not by comparing to one number. `raw == null` (no curate events at all — `deriveCuratorStatus` returns `null`, `silo.js:1259`) is handled by treating every `raw.*` access as null: `last_run_at = null`, `last_success_at = null`, `last_event_kind = null`, `days = null`, `is_stale = false`, `in_progress = false` (since `last_event_kind !== 'started'`), and `first_observed_at` still gets stamped/carried — so a never-run silo persists a valid never-succeeded-grace record.

### 5.5 `last_emitted_at` cooldown — separate file `curate-emit.json` (the race fix, #1)

The hysteresis above stops *flapping*; the cooldown stops *repetition within a stable-stale period*. Without it, a genuinely-stale curate would attach the notice to **every** `read_index` / `search` / `list_handoffs` response — precisely the notice-fatigue the owner just suffered from `update_available`.

**The cooldown stamp lives in its OWN file**, `<silo-dir>/curate-emit.json`, written **only by the MCP read path**. The cron's `curate-status` writes **only** `curate-status.json`. **No process ever read-modify-writes a file another process also writes.** This dissolves the dual-writer race the panel blocked on (Gemini BLOCKER + ChatGPT/Claude MAJOR): there is no shared file, no lost-update window, no "cron overwrites a just-stamped `last_emitted_at`" path. The race class is *structurally absent*, not merely tolerated.

```jsonc
// <silo-dir>/curate-emit.json — single writer: the MCP read path.
{
  "schema_version": 1,
  "last_emitted_at": "2026-06-11T09:14:03Z"   // last time ANY curate-liveness notice was surfaced
}
```

Mechanism, in `buildSiloNotices` (`silo-mcp/notices.js`):
- A curate-liveness notice (`curate_liveness_stale`, `curate_never_succeeded`, `curate_monitor_stale`, or `curate_monitor_unreadable`) is emitted only when its trigger holds **AND** the shared cooldown is due: `last_emitted_at == null` **OR** `now - Date.parse(last_emitted_at) > EMIT_COOLDOWN_MS`.
- **Robustness (#8):** if `last_emitted_at` is present but `Date.parse` yields `NaN` (corrupt/garbled), treat the cooldown as **due** (emit) rather than suppressing forever. A bad stamp must never silence the light indefinitely. (Mirror update-check's `Number.isFinite` guard at `update-check.js:270-271`.)
- The cooldown is **shared across all four curate kinds** — they're the same fatigue surface, so one stamp gates all of them. (A stale-curate read that *also* trips the monitor-stale guard emits at most one per cooldown window, whichever fires first.)
- **`EMIT_COOLDOWN_MS` default 6h** (≈ one working session). Adjudicated **6h** (panel majority — Claude/Gemini 6h, ChatGPT 24h): long enough that a burst of reads in one session yields *one* mention; short enough that a multi-day outage re-pings each day. **24h is the documented conservative knob** if fatigue recurs (single-constant change).
- On emit, the read path does a read-modify-write of **`curate-emit.json` only** (`{ schema_version: 1, last_emitted_at: now }`), atomic unique-tmp+rename (clone of `writeCache`, `update-check.js:107-115`). Concurrent MCP reads racing to stamp is benign last-writer-wins on a single-field file — a lost stamp costs at most one extra emission, and unlike the original design there is no *cross-writer-class* race because the cron never touches this file.

### 5.6 Opt-out — separate `SILO_DISABLE_CURATE_LIVENESS` (#5)

**Resolved to the granular option (DECIDED).** Add a parallel `SILO_DISABLE_CURATE_LIVENESS` predicate — a copy of `isUpdateOptOut` (`silo-mcp/notices.js:42-46`) with the new var name — **rather than reusing `SILO_DISABLE_UPDATE_CHECK`**. Rationale (ChatGPT MAJOR + Claude): the owner silenced update-notices out of fatigue; reusing that var would *also blind them to curate death*, defeating the entire feature. Update-spam and curate-spam must be independently silenceable.

```js
// silo-mcp/notices.js — sibling to isUpdateOptOut, same OPT_OUT_VALUES set.
export function isCurateLivenessOptOut(env = process.env) {
  const v = env.SILO_DISABLE_CURATE_LIVENESS;
  if (v == null) return false;
  return OPT_OUT_VALUES.has(String(v).toLowerCase().trim());
}
```

The predicate is **duplicated across the silo / silo-mcp package boundary** on purpose. `silo-mcp/` is a separate package with its own `package.json` / `node_modules` on the VPS; cross-package imports break the install boundary (documented at `silo-mcp/notices.js:36-40`, "Replicated locally rather than imported … Keep this list in sync"). The `OPT_OUT_VALUES` set (`['1','true','yes','on']`) must stay byte-identical between `src/util/update-check.js:45` and `silo-mcp/notices.js:41`. Adding a curate predicate keeps that discipline — accept the duplication; it is the established convention, not a smell to fix. (Whether the disable var is *also* read on the CLI side is moot: the CLI never suppresses — it always *writes* the cache so `silo doctor` and a re-enable are instant. Only the read path consults the predicate.)

### 5.7 The notice payload (read path)

In `buildSiloNotices` (`silo-mcp/notices.js:111`), after the existing update block (`:131-158`), add the curate-liveness block. The signature gains `curateStatus`, `curateEmit`, and `curateLivenessDisabled`:

```js
export async function buildSiloNotices({
  pendingPath, updateStatus, updateCheckDisabled,
  curateStatus, curateEmit, curateLivenessDisabled,   // NEW
} = {}) {
  const notices = [];
  // ... existing pending + update blocks unchanged ...

  // ── curate-liveness (this spec) ──────────────────────────────────────────
  // `curateStatus` is the discriminated envelope from loadCurateStatus (L1/L2):
  //   { kind:'ok', status, mtimeMs } | { kind:'absent' } | { kind:'corrupt', mtimeMs? }
  // We branch on `.kind` — never on `=== undefined`/truthiness (L2: that overload
  // collided with "caller omitted the arg").
  if (!curateLivenessDisabled) {
    // Shared cooldown gate (curate-emit.json; NaN/missing → due, #8).
    const emittedMs = curateEmit?.last_emitted_at != null
      ? Date.parse(curateEmit.last_emitted_at) : NaN;
    const due = !Number.isFinite(emittedMs) || (now - emittedMs > EMIT_COOLDOWN_MS);

    // (a) Monitor-itself-broken: file corrupt OR its own writer is stale (both
    //     crons down). ONE coherent "monitor is broken" signal (§5.8). The
    //     resolver consumes the WHOLE envelope (L1): it reads `mtimeMs` for the
    //     freshness check and `kind:'corrupt'` for the unreadable case — neither
    //     was reachable when the loader returned only the parsed object.
    //     `kind:'absent'` ⇒ returns null (ENOENT is not a monitor issue, §5.8).
    const monitorIssue = resolveMonitorFreshness(curateStatus, now); // §5.8 → null | {kind, message}

    if (monitorIssue && due) {
      notices.push({ ...monitorIssue, /* kind: curate_monitor_stale | curate_monitor_unreadable */ });
      // stamp curate-emit.json (atomic RMW)
    } else if (curateStatus.kind === 'ok') {
      const s = curateStatus.status;                       // the parsed verdict object
      // (b) Never-succeeded (F4/#4): no success ever, past the grace window.
      const neverSucceeded = s.last_success_at == null;
      const firstMs = Date.parse(s.first_observed_at);
      const pastGrace = Number.isFinite(firstMs)
        && (now - firstMs > NEVER_SUCCEEDED_GRACE_MS);

      if (neverSucceeded && pastGrace && due) {
        notices.push({
          kind: 'curate_never_succeeded',
          first_observed_at: s.first_observed_at,
          last_run_at: s.last_run_at,                      // null if it never even started
          message: s.last_run_at
            ? 'Silo curation has run but has NEVER completed successfully since this silo was first observed. Memory consolidation has never happened — run `silo doctor` and check /var/log/silo-curate.log for the failure.'
            : 'Silo curation has NEVER run on this silo since it was first observed (no heartbeat at all). The silo-curate cron may not be installed, or its script lost its exec bit. Run `silo doctor` and verify the cron + exec bit.',
        });
        // stamp curate-emit.json (atomic RMW)
      }
      // (c) Stale (the main light): had a success, now too old.
      else if (s.is_stale === true && due) {
        const days = Math.floor(s.days_since_success ?? 0);
        let message;
        // Branch order is load-bearing (R2-Live-3): in_progress is now derived
        // from last_event_kind ('started'), so a post-failure started-with-no-
        // terminal correctly takes the "started but not completed" branch even
        // though s.last_failure_msg still carries the stale failure text. If we
        // tested last_failure_msg first it would mask the in-progress run.
        if (s.in_progress) {
          message = `Silo curation started but has not completed in ${days} days — the run may be wedged. Memory consolidation is stalled. Run \`silo doctor\` and check for a hung silo-curate process / stale lock.`;
        } else if (s.last_failure_msg) {
          message = `Silo curation has not succeeded in ${days} days (last run FAILED: ${s.last_failure_msg}). Memory consolidation is stalled — run \`silo doctor\` and check /var/log/silo-curate.log.`;
        } else {
          message = `Silo curation has not run in ${days} days (no heartbeat — the cron may be dead before its first log line). Memory consolidation is stalled — run \`silo doctor\` and verify the silo-curate cron + exec bit.`;
        }
        notices.push({
          kind: 'curate_liveness_stale',
          last_success_at: s.last_success_at,
          days_since_success: s.days_since_success,
          consecutive_failures: s.consecutive_failures,
          last_failure_msg: s.last_failure_msg,
          last_event_kind: s.last_event_kind,
          in_progress: s.in_progress,
          message,
        });
        // stamp curate-emit.json (atomic RMW)
      }
    }
    // curateStatus.kind === 'absent' → no notice (covered by resolveMonitorFreshness
    // returning null); a fresh silo before its first cron stays correctly dark.
  }

  return notices.length > 0 ? notices : null;
}
```

The **three-way message split** matters, and its **branch order is the R2-Live-3 fix** — `in_progress` is tested *first*:
- **`in_progress`** (`last_event_kind === 'started'`, >STALE_DAYS) → "started but not completed / wedged" — points at a hung process or stale lock (F3/#7). Tested first **on purpose**: this branch must win even when `last_failure_msg` is non-null from an *earlier* failed run (R2-Live-3 — `deriveCuratorStatus` preserves that message across a later `run started`).
- **`last_failure_msg` set** (and **not** in-progress, i.e. `last_event_kind === 'failed'`) → the curate run is *executing and failing* — points at the LLM/curate logic.
- **silence** (`last_failure_msg == null`, not in-progress, but stale) → points at the cron/exec-bit class of bug — exactly the 10-day failure. Encoding that hint saves the next operator the diagnosis we just did.

**`loadCurateStatus` returns a discriminated envelope, not a bare object (L1 + L2).** `curateStatus` is loaded by a new `loadCurateStatus(path)` in `notices.js`. It mirrors `loadUpdateStatus` (`silo-mcp/notices.js:62-77`) for the *mtime-cache mechanism* and uses its **own `curateCache` module var** (#10, §6) — but it **deliberately diverges on the return contract** (so it is **not** a field-for-field clone; that phrasing was the L2 ambiguity). Verified: `loadUpdateStatus` returns only the parsed `status` (or `null`), and **never exposes `st.mtimeMs`** (`notices.js:62-77`) — so a pure clone leaves `resolveMonitorFreshness` with no mtime to check (L1) and overloads `undefined` for both "corrupt" and "arg omitted" (L2). The fix:

```js
// silo-mcp/notices.js — loadCurateStatus return shape (L1 + L2).
//   { kind: 'ok',      status, mtimeMs }   // parsed fine; mtimeMs from stat()
//   { kind: 'absent' }                     // ENOENT — file genuinely missing
//   { kind: 'corrupt', mtimeMs }           // exists but JSON.parse threw (+ stderr warn);
//                                          //   mtimeMs is best-effort (stat succeeded before read)
```

- The cache stores `{ mtime, envelope }` and short-circuits on `mtime === st.mtimeMs` exactly like `updateCache` — but the cached value is the envelope, so a cache hit still carries `mtimeMs`.
- `kind:'ok'` carries `mtimeMs` so `resolveMonitorFreshness` can do the both-crons-dead freshness check **without a second `stat()`** (L1). The mtime the loader already fetched is the freshness anchor (§5.8).
- `kind:'corrupt'` replaces the v2 `undefined`-sentinel (L2): the read path branches on `kind`, never on `=== undefined`, so the "caller omitted the arg" collision is gone. (If `stat()` itself failed for a non-ENOENT reason, treat as `{kind:'corrupt'}` with `mtimeMs` omitted — `resolveMonitorFreshness` handles a missing `mtimeMs` by falling back to `computed_at`; see §5.8.)
- `kind:'absent'` is the explicit ENOENT case (replaces the bare `null`). `resolveMonitorFreshness({kind:'absent'}, …)` returns `null` — ENOENT is not a monitor issue (fresh deploy before first cron, §5.8/F4).

`curateEmit` is loaded by `loadCurateEmit(path)`, an even smaller mtime-cached read of `curate-emit.json` (its own `curateEmitCache` var) — it stays a plain `object | null` (no envelope; nothing reads *its* mtime). Both wired in `silo-mcp/server.js`'s `siloNoticesForRead` (`:212-219`).

### 5.8 Both-crons-dead freshness guard + monitor-unreadable — `resolveMonitorFreshness` (#3, #8)

**Resolved: BUILD it (DECIDED, §9c).** This is the panel's converged fix for F2 (both crons dead → nobody refreshes `curate-status.json`). It is deliberately **minimal**: one helper, called once in the read path, no fold, no registry — *not* the seed of a monitoring framework (NG1). Gemini's objection was only to *over-framing*; the mechanism itself (Gemini #2: "MCP must derive staleness if the monitor file mtime > STALE_DAYS") is exactly this.

`resolveMonitorFreshness(curateStatus, now)` takes the **discriminated envelope** from `loadCurateStatus` (L1/L2) and returns `null` (monitor healthy / not-applicable) or a `{ kind, message, … }` payload. It folds together two "the monitor is broken" conditions into **one coherent signal** (#8 reconciliation), so there is never both an "unreadable" and a "stale" notice for the same broken monitor. It branches on `curateStatus.kind` — **never** on `=== undefined` (L2):

```js
// silo-mcp/notices.js — resolveMonitorFreshness(envelope, now) → null | {kind, message}
function resolveMonitorFreshness(curateStatus, now) {
  switch (curateStatus.kind) {
    case 'absent':                       // ENOENT → not a monitor issue (fresh deploy)
      return null;
    case 'corrupt':                      // (1) below
      return { kind: 'curate_monitor_unreadable', message: /* … */ };
    case 'ok': {                         // (2) below — freshness from the envelope's mtime
      const anchorMs = Math.max(
        curateStatus.mtimeMs ?? -Infinity,                 // L1: came straight from loadCurateStatus
        Date.parse(curateStatus.status.computed_at) || -Infinity,
      );
      if (Number.isFinite(anchorMs) && now - anchorMs > MONITOR_STALE_MS) {
        return { kind: 'curate_monitor_stale', message: /* … */ };
      }
      return null;                        // monitor fresh → fall through to (b)/(c) in §5.7
    }
  }
}
```

1. **Unreadable / corrupt** — `loadCurateStatus` returned `{ kind:'corrupt' }`, i.e. the file exists but won't parse (L2: this replaces the v2 `undefined` sentinel). → `kind: 'curate_monitor_unreadable'`, message: "Silo's curate-liveness monitor file is unreadable/corrupt — the liveness check cannot report. Run `silo doctor` (it folds live, independent of this file) and check `<silo-dir>/curate-status.json`." Emitted after the shared cooldown (not silently absent — the draft's silent-`null`-on-malformed was the ChatGPT MINOR). (A `{kind:'corrupt'}` whose `mtimeMs` is absent — non-ENOENT `stat()` failure — still reports unreadable; mtime is only needed for the *stale* branch.)
2. **Stale writer (both crons down)** — `{ kind:'ok' }` (parsed fine) but its freshness anchor is old: `now - max(mtimeMs, Date.parse(status.computed_at)) > MONITOR_STALE_MS` (default `MONITOR_STALE_DAYS = STALE_DAYS = 3`). The anchor's `mtimeMs` comes **from the envelope** (L1 — `loadUpdateStatus` never surfaced it; the clone now does), so this needs **no second `stat()` and no log fold** — it works precisely when the cron that *would* fold is dead. → `kind: 'curate_monitor_stale'`, message: "Silo's curate-liveness monitor hasn't updated in N days — both the curate and detect crons may be down. `silo doctor` is the live backstop; verify both cron entries."

Distinction from `curate_liveness_stale`: that notice means *curate* is stale (and the monitor is fine and saying so). `curate_monitor_stale` means *the monitor itself* is stale (we can't trust its verdict). Different `kind`, different operator action (one cron vs both crons).

ENOENT (file genuinely absent — fresh deploy before the first cron, or `curate-emit.json` never written) is **not** a monitor issue: `loadCurateStatus` returns `{ kind:'absent' }`, `resolveMonitorFreshness` returns `null` (no notice), and the read path's `else if (curateStatus.kind === 'ok')` branch is skipped — so a brand-new silo before its first cron run stays correctly dark (consistent with F4's grace window). Only a *present-but-old* (`kind:'ok'` + stale anchor) or *present-but-corrupt* (`kind:'corrupt'`) file trips the guard.

Gemini's external-watchdog suggestion (Healthchecks.io for true global cron observability) is recorded as a **valid out-of-scope external complement** — it would catch the case where the *whole VPS* is down (no MCP read happens at all, so no Silo-internal signal can fire). It is **not a substitute** for this read-path guard, which covers the realistic "both crons broke but the box and MCP are up" case at zero new infra. (NG3.)

---

## 6. Interaction with existing subsystems

| Subsystem | File:line | Interaction |
|---|---|---|
| **detect cron** | `scripts/silo-detect.sh:44` | Gains a `trap 'node silo.js curate-status …' EXIT` after the env/flock setup (out-of-band death detector). No change to detect's own pass, lock, or status events. |
| **curate cron** | `scripts/silo-curate.sh:39` | Gains the **same** `trap … EXIT` (in-band recovery reflector — only runs when curate is alive). No change to curate's pass or heartbeat. |
| **`deriveCuratorStatus`** | `src/cli/silo.js:1230` | Reused, **must be exported** (currently private; `test/status-events.test.js:8` confirms). `cmdCurateStatus` and the new unit tests call it. Returns `null` when no curate events exist (`:1259`) — `foldLiveness` handles null. **R2-Live-3: gains `last_event_kind`** (`'started'`/`'complete'`/`'failed'`/null — the most-recent event's kind) so in-progress is detected by ordering, not by the preserved `last_failure_msg`. Purely additive to the return; fold loop (`:1244-1257`) just records which branch ran last. The four existing fields unchanged. |
| **`cmdDoctor`** | `src/cli/silo.js` (curate readout ~`:1142-1204`) | **Unchanged.** Still folds + renders "Curate status" live. The new cache is *additive*; doctor does not read it. **Resolved (§9e): doctor stays live-fold-only** — it must not depend on a cache it might be diagnosing. Doctor is the independent backstop for the both-down case (F2). |
| **`notices.js` / `buildSiloNotices`** | `silo-mcp/notices.js:111` | Gains `loadCurateStatus` (own `curateCache` var, #10; **returns the discriminated envelope** `{kind:'ok',status,mtimeMs}\|{kind:'absent'}\|{kind:'corrupt',mtimeMs?}` per L1/L2 — **not** a field-for-field clone of `loadUpdateStatus`, which surfaces neither mtime nor a corrupt-vs-absent distinction), `loadCurateEmit` (own `curateEmitCache` var; plain `object\|null`), `isCurateLivenessOptOut`, `resolveMonitorFreshness` (consumes the envelope), and the curate-liveness branch (four `kind`s). The `_resetUpdateCache`-style seam (`:32-34`) gets `_resetCurateCache` + `_resetCurateEmitCache` twins. |
| **module caches** | `silo-mcp/notices.js:26` | `let curateCache = { mtime: null, envelope: null }` (stores the L1/L2 envelope so a cache hit still carries `mtimeMs`) and `let curateEmitCache = { mtime: null, status: null }` added **alongside** `updateCache` — **NOT** a reuse of `updateCache` (#10). Reusing it would cross-pollute update-status and curate-status reads. |
| **opt-out predicate** | `silo-mcp/notices.js:42` ↔ `src/util/update-check.js:49` | New `SILO_DISABLE_CURATE_LIVENESS` pair, duplicated across the package boundary (§5.6). Cross-package duplication is the established convention — keep `OPT_OUT_VALUES` byte-identical. |
| **MCP server wiring** | `silo-mcp/server.js:55,212-219` | Add `CURATE_STATUS_PATH = join(SILO_DIR, 'curate-status.json')` and `CURATE_EMIT_PATH = join(SILO_DIR, 'curate-emit.json')`; `siloNoticesForRead` loads both and threads `curateStatus` + `curateEmit` + `curateLivenessDisabled` into `buildSiloNotices`. The `_silo_notices` schema is already `z.array(z.object({}).passthrough())` (`:311`) so new `kind`s need no schema change. |
| **operation log / projection** | — | **Untouched.** No new event type, no new projected field. We only *read* existing `system`/`silo-curate` events and write sidecar caches. (NG2.) |

Updated `siloNoticesForRead` (`silo-mcp/server.js:212-219`):
```js
async function siloNoticesForRead() {
  const updateStatus = await loadUpdateStatus(UPDATE_STATUS_PATH);
  const curateStatus = await loadCurateStatus(CURATE_STATUS_PATH); // envelope: {kind:'ok'|'absent'|'corrupt', …} (L1/L2)
  const curateEmit   = await loadCurateEmit(CURATE_EMIT_PATH);
  return buildSiloNotices({
    pendingPath: PENDING_SUGGESTIONS_PATH,
    updateStatus,
    updateCheckDisabled: isUpdateOptOut(),
    curateStatus,
    curateEmit,
    curateLivenessDisabled: isCurateLivenessOptOut(),
  });
}
```

---

## 7. Failure modes & edge cases

| # | Scenario | Detection signal | Behavior | Notes / residual risk |
|---|---|---|---|---|
| **F1** | **Curate genuinely down** (the target). Exec-bit lost, cron path wrong, or `silo curate` crashing nightly. | `last_success_at` ages past STALE_DAYS while **detect** keeps writing the cache nightly. | `is_stale → true`; `curate_liveness_stale` surfaces (cooldown-throttled). Message branches: silent-death vs failed-run vs in-progress. | The bug we're fixing. Detect's out-of-band call is what catches it (curate can't write its own status when dead). On the *next* successful curate, curate's in-band tail call clears it at 05:00. |
| **F2** | **Detect ALSO down** (both crons dead → nobody writes `curate-status.json`). | The status file's own `mtime`/`computed_at` ages past `MONITOR_STALE_DAYS`. | **`curate_monitor_stale` fires from the read path** (§5.8) — computed from `stat().mtimeMs`, no fold, so it works though the writer is dead. `silo doctor` remains the live backstop. | **Resolved (§9c): built.** Closes the draft's "honest hole." Distinct `kind` so the operator knows to check *both* crons, not just curate. External global-down (whole VPS) is out of scope (Gemini's Healthchecks.io complement). |
| **F3** | **Curate in-progress** (`started`, no `complete`/`failed` — mid-run or wedged), **including after a prior failure** (`success → failure → started`). | `deriveCuratorStatus` sets `last_run_at` past `last_success_at` and reports `last_event_kind = 'started'`; `foldLiveness` sets `in_progress = true` from that. | Liveness keys off `last_success_at`, not `last_run_at` — a healthy in-progress run does **not** clear staleness, a single wedged run does **not** falsely clear it. After STALE_DAYS the light trips with the **"started but not completed"** message. | **Resolved (§9a in-progress): stale + dedicated message** (panel unanimous). **R2-Live-3 (ChatGPT):** `in_progress` is now derived from `last_event_kind === 'started'`, **not** `last_failure_msg == null`. The v2 spec masked a post-failure in-progress run (`deriveCuratorStatus` preserves `last_failure_msg` across a later `run started`, `silo.js:1250`) → it wrongly picked the *failed* branch. Event-ordering fixes it; the failure *counter* is still preserved. See T15a/T27. |
| **F4** | **First-run / never-succeeded.** Brand-new silo, or curate has never completed once (incl. a fresh silo whose *very first* curate silently dies). | `last_success_at == null`; `first_observed_at` ages past `NEVER_SUCCEEDED_GRACE_DAYS`. | During the grace window: **dark** (no false light on day 0–2). After the grace window with still no success: **`curate_never_succeeded`** fires (cooldown-shared), with a sub-message for "ran but never completed" vs "never ran at all." | **Resolved (#4, ChatGPT MAJOR):** closes the draft's "fresh silo whose first curate silently dies stays dark forever" hole. The brand-new-silo case still stays dark *during* the grace window — intentional (the operator is present on a fresh deploy, and we don't want a day-0 false alarm). |
| **F5** | **Clock skew.** Writer clock vs reader clock drift; or a backdated `last_success_at`. | `days_since_success` could go slightly negative or inflated. | All comparisons are `>` against day-scale thresholds; sub-hour skew is absorbed by the 1-to-3-day dead band. Negative `days` (success "in the future") → treated as fresh (`is_stale=false`) — fail-safe toward silence. | Same machine writes and reads on the VPS, so skew ≈ 0 in production. The dead band makes the design skew-tolerant regardless. No NTP dependency introduced. |
| **F6** | **Opt-out set.** `SILO_DISABLE_CURATE_LIVENESS` truthy. | `isCurateLivenessOptOut()` returns true. | All four curate `kind`s suppressed in `buildSiloNotices` regardless of state. The crons still *compute and write* the cache (so `silo doctor` and re-enabling are instant). | **Resolved (#5): separate var** — silencing update-fatigue (`SILO_DISABLE_UPDATE_CHECK`) does **not** also blind curate-death. The cron writing the cache even when notices are off means no warm-up lag on re-enable. |
| **F7** | **Malformed / unreadable `curate-status.json`** (partial write, manual edit, disk full mid-write). | `JSON.parse` throws in `loadCurateStatus` → returns `{ kind:'corrupt', mtimeMs? }` (L2 — replaces the v2 `undefined` sentinel that collided with "arg omitted"), distinct from `{ kind:'absent' }` (ENOENT). | **`curate_monitor_unreadable`** fires after the shared cooldown (§5.8) — *not* silently absent (the draft's silent-null was the ChatGPT MINOR). One stderr warning too. Next cron atomically rewrites the file, self-healing. | **Resolved (#8 + L1/L2):** reconciled with the freshness guard into one "monitor is broken" signal; the read path branches on `envelope.kind`, never on `=== undefined`. Atomic unique-tmp+rename (`update-check.js:112-114`) makes torn writes nearly impossible in the first place; this is the belt to that suspenders. |
| **F8** | **Notice-spam within a stable outage** (the fatigue case). | Any curate `kind` would otherwise attach to every read in a session. | Shared cooldown (`curate-emit.json` `last_emitted_at` + `EMIT_COOLDOWN_MS=6h`, §5.5) collapses a read-burst to ~one mention/session across *all four* kinds. | The explicit anti-fatigue guard. 6h is the adjudicated value; 24h is the conservative knob. NaN/missing stamp → due (never permanently silent, #8). |
| **F9** | **Dual-writer race on the cooldown stamp** (the draft's BLOCKER). | — | **Cannot occur.** Cron writes `curate-status.json`; read path writes `curate-emit.json`. No shared file, no cross-writer-class RMW. Within the read path, concurrent stampers are benign last-writer-wins on a one-field file (lost stamp = at most one extra emit). | **Resolved (#1, Gemini BLOCKER + ChatGPT/Claude MAJOR — unanimous fix):** the race class is *structurally absent*, the central reason this spec is now ratifiable. |

---

## 8. Test plan

Mirrors `test/update-check.test.js` style (node:test, `assert/strict`, tmpdir silos, injected `now`, spawnSync for CLI smoke) and `test/status-events.test.js` (LogWriter + `emitSystemEvent` helper, end-to-end CLI for the parser).

**`foldLiveness` (pure, unit) — new `test/curate-liveness.test.js`:**
- T1. Fresh success (`days < 1`) → `is_stale=false`.
- T2. 2 missed nights (`days≈2`, prior dark) → stays `is_stale=false` (under STALE_DAYS=3 — single-blip tolerance).
- T3. 4 days silent (`days≈4`, prior dark) → flips `is_stale=true`.
- T4. **Hysteresis hold:** prior `is_stale=true`, `days` drops to 2 → **stays true** (above CLEAR_DAYS=1, below STALE_DAYS=3 — dead band).
- T5. **Hysteresis clear:** prior `is_stale=true`, fresh success drops `days` to 0.5 → flips `is_stale=false`.
- T6. **No flap:** oscillating sequence 1.5→2.5→1.5→2.5 days with carried prior verdict → `is_stale` never toggles.
- T7. `last_success_at == null` (never succeeded) → `is_stale=false` regardless of `last_run_at` age (F4 — the *light* stays off; the never-succeeded notice is a read-path concern).
- T8. Negative `days` (success timestamped in the future, clock skew) → `is_stale=false` (F5 fail-safe).
- T9. **`first_observed_at` carry-forward:** prior has `first_observed_at=T0`; new fold at T0+5d preserves `T0` (never overwritten). Absent prior → stamped to `now`.
- T10. **`in_progress` detection (R2-Live-3 — keyed off `last_event_kind`, not `last_failure_msg`):** `raw.last_event_kind==='started'` → `in_progress=true` **even when `last_failure_msg` is set** (the masking case the v2 spec got wrong). `raw.last_event_kind==='complete'` or `'failed'` → `in_progress=false`. `raw==null` → `in_progress=false`.
- T11. **`raw == null` (no curate events):** all facts null, `is_stale=false`, `in_progress=false`, `first_observed_at` still stamped (valid never-succeeded-grace record).
- T12. **Full output shape:** the returned object has exactly the §5.4 keys (incl. `last_event_kind`; no `last_emitted_at`, no `schema_version` — those are stamped elsewhere / live in the other file).

**`deriveCuratorStatus` integration (now exported):**
- T13. started+complete pair → `last_success_at` set, `consecutive_failures=0`, `last_event_kind='complete'`. (Reuse the log fixture from `test/status-events.test.js`.)
- T14. started+failed → `last_failure_msg` set, `consecutive_failures` increments, `last_event_kind='failed'`; `last_success_at` preserved from prior success.
- T15. started with no terminal event → `last_run_at` set, `last_success_at` untouched, `last_event_kind='started'` (feeds F3 `in_progress`).
- T15a. **R2-Live-3 fixture (the masking case):** `success → failure → started`(no terminal) → `last_event_kind='started'`, **`last_failure_msg` still non-null** (preserved across the `started`, `silo.js:1250`), `consecutive_failures=1`. Asserts the parser exposes the ordering (`last_event_kind`) that `foldLiveness` needs to override the stale failure message.
- T16. no curate events at all → returns `null` (the `:1259` guard; `last_event_kind` is moot — the whole object is null; `foldLiveness` must tolerate this — see T11).

**Cache I/O (clone of update-check.js:96-115 cases):**
- T17. `readCurateStatus`: missing file → null.
- T18. `readCurateStatus`: malformed → null (cron side treats malformed-prior as absent and self-heals).
- T19. `writeCurateStatus`: round-trips through read; writes `curate-status.json` and **does not create `curate-emit.json`**.
- T20. `writeCurateStatus`: no `.tmp` residue after success (atomic rename).

**`loadCurateStatus` / `loadCurateEmit` + `buildSiloNotices` (silo-mcp):**
- T21. `is_stale=true`, no `curate-emit.json` (cooldown due) → `curate_liveness_stale` present.
- T22. `is_stale=true`, `curate-emit.json` `last_emitted_at` within cooldown → notice **absent** (cooldown suppression, F8).
- T23. `is_stale=true`, `last_emitted_at` older than cooldown → notice present again, and `curate-emit.json` is RMW-stamped to `now`.
- T24. `is_stale=true`, `last_emitted_at` = `"not-a-date"` (NaN) → treated as **due**, notice present (#8 — never permanently silent).
- T25. `is_stale=false`, has a recent success → no curate notice.
- T26. opt-out env (`SILO_DISABLE_CURATE_LIVENESS=1`) set → no curate notice even when `is_stale=true` (F6). And `SILO_DISABLE_UPDATE_CHECK=1` alone does **not** suppress the curate notice (proves the vars are independent, #5).
- T27. **Message branches** (§5.7): `last_failure_msg` set + `last_event_kind='failed'` → failed-run text; `last_failure_msg=null` + not in-progress → silent-death text; `in_progress=true` (`last_event_kind='started'`) → "started but not completed" text. **R2-Live-3 regression assert:** a stale `curateStatus` with `in_progress=true` **AND** `last_failure_msg` non-null (the `success→failure→started` shape from T15a) must yield the **"started but not completed"** text, NOT the failed-run text (proves the branch-order/`last_event_kind` fix; would have failed under the v2 `last_failure_msg`-keyed `in_progress`).
- T28. **Never-succeeded (F4):** `last_success_at=null`, `first_observed_at` older than grace → `curate_never_succeeded` present; `first_observed_at` *within* grace → absent (fresh-silo darkness). Sub-message switches on `last_run_at` null vs set.
- T29. **Monitor-stale (F2/§5.8):** `loadCurateStatus` returns `{kind:'ok', status, mtimeMs}` where `mtimeMs`/`status.computed_at` are backdated > MONITOR_STALE_DAYS → `curate_monitor_stale` present, computed **from the envelope's `mtimeMs`** (no second `stat()`, no log fold — L1), distinct `kind`.
- T29a. **L1 envelope contract:** `loadCurateStatus` on a present, parseable file returns `{kind:'ok', status, mtimeMs}` with `mtimeMs === stat().mtimeMs`; a cache hit (unchanged mtime) still returns an envelope carrying `mtimeMs` (proves the freshness anchor survives caching).
- T30. **Monitor-unreadable (F7/§5.8 — L2):** `curate-status.json` exists but is corrupt → `loadCurateStatus` returns `{kind:'corrupt', mtimeMs?}` (not `undefined`) → `curate_monitor_unreadable` present after cooldown (not silent). Assert the read path branches on `kind`, so passing no `curateStatus` arg at all does **not** masquerade as corrupt.
- T31. **ENOENT is not a monitor issue (L2):** `curate-status.json` absent (fresh deploy) → `loadCurateStatus` returns `{kind:'absent'}` → no curate notice of any kind; existing update/pending notices still build (additive, no regression).
- T32. **`curateCache` isolation (#10):** loading `curate-status.json` does not perturb `updateCache` and vice-versa (assert update notices unaffected after a curate load; mirror `_resetUpdateCache`/`_resetCurateCache` seams).
- T33. **Shared cooldown across kinds (F8):** a read that trips both `is_stale` and `curate_monitor_stale` emits at most one curate notice per cooldown window (whichever branch fires first stamps `curate-emit.json`).

**`cmdCurateStatus` end-to-end (spawnSync, like status-events.test.js):**
- T34. Stale curate history (last success backdated >3d via `emitSystemEvent`) → `silo curate-status` writes `curate-status.json` with `is_stale=true`, and **no** `curate-emit.json`.
- T35. Fresh silo (no curate events) → writes a cache with `is_stale=false`, `last_success_at=null`, a stamped `first_observed_at` (F4) — and exits 0 (must never fail a cron).
- T36. Running `silo curate-status` does not spawn an update-check worker (verify it's in the exclusion gate, §5.2 — assert no `update-status.json` appears).
- T37. **Both-crons semantics:** a successful `curate` cron tail call refreshes `computed_at` to "now" even though a prior detect-written cache was older (proves the in-band recovery path; §5.3).

**Trap behavior (bash, smoke — optional but recommended):**
- T38. A `silo-detect.sh` invocation that exits early (simulated early `exit` after the trap is registered) still runs `curate-status` (proves trap > trailing-`|| true`, #6). Assert `curate-status.json` `computed_at` advanced.

---

## 9. Resolved questions (was "open for reviewers")

All §9 items from the draft are now **RESOLVED** by the panel. Recorded for traceability.

**(a) Threshold pair + in-progress semantics — RESOLVED.**
Keep **STALE_DAYS=3 / CLEAR_DAYS=1** (panel unanimous — 3 tolerates ~2 missed nights, the dead band prevents flap). In-progress (started, no terminal) is **treated as stale** once past STALE_DAYS, **with a dedicated "started but not completed" message branch** (panel unanimous, ChatGPT nuance) — the `in_progress` flag (§5.4) adds the wedged-vs-dead distinction at the message level without a separate verdict state. See F3, §5.7.

**(b) Dedicated subcommand vs piggyback detect's regen — RESOLVED: dedicated subcommand.**
`silo curate-status` keeps its **own** `interpret()` fold rather than computing the verdict inside detect's projection regen (which holds `state` in memory). Panel unanimous: isolation from the `deriveDetectorStatus` docstring/code divergence (§10) and from the projection module's "one light" boundary (NG1) beats saving one nightly fold. Cost (a second fold this hour) is amortized cron budget, accepted.

**(c) Cache-freshness guard / `curate_monitor_stale` (F2) — RESOLVED: BUILD it.**
Build the **minimal** read-path `mtime`/`computed_at` staleness check (§5.8) — one extra condition, no fold, distinct `kind`. Claude + ChatGPT said build; Gemini's finding #2 *also* requires the mechanism ("MCP must derive staleness if the monitor file mtime > STALE_DAYS") and only objected to over-framing it as a monitored-job framework — so it is kept to one helper, not a registry. Gemini's external watchdog (Healthchecks.io) is noted as a **valid out-of-scope external complement, not a substitute** (it catches whole-VPS-down, which no Silo-internal signal can).

**(d) Dismissability + cooldown + dual-writer — RESOLVED.**
Cooldown stays **time-based** (`last_emitted_at` + `EMIT_COOLDOWN_MS`), **6h** (panel majority; 24h documented as the conservative knob). The **dual-writer-on-one-file question is DECIDED: split** — the emit stamp moves to its own `curate-emit.json` (§5.5), so it is no longer "last-writer-wins on a shared file" but "single-writer per file." A persistent user-dismiss op (like topic suggestions) was considered and **not adopted** — it needs a dismiss op + a re-arm-on-recovery rule and is heavier than the cooldown warrants for a deliberately-rare notice. The old "split-file vs last-writer-wins" sub-question is therefore closed.

**(e) Should `silo doctor` also fire this notice — RESOLVED: no, passive-rail-only.**
`silo doctor` stays **live-fold-only** (panel unanimous). It must not depend on `curate-status.json` — that cache could be stale exactly when you're running doctor to debug why. Doctor remains the independent live backstop for the both-down case (F2). The cache is MCP-rail-only.

---

## 10. Out of scope

- **A general health-monitoring framework / liveness-rule engine.** One light, one subsystem, plus a minimal self-freshness check on its own writer (§5.8 — one helper, not a registry). (NG1.)
- **External cron observability** (Healthchecks.io or similar). A valid *complement* for whole-VPS-down detection, but external infra and out of scope for Silo. (§9c, NG3.)
- **Chain-break notices on the passive rail.** Hash-chain integrity is surfaced by `silo doctor` and enforced by `regenerate --strict` (`src/cli/silo.js:1280-1296`). Not part of this light.
- **Fixing the `deriveCuratorStatus` / `deriveDetectorStatus` near-duplication.** They are two copies of the same status-event parser (`src/cli/silo.js:1230` vs `src/projection/regenerate-pending-suggestions.js`) with **subtly divergent failure models**: `deriveDetectorStatus`'s docstring describes a "two consecutive runs" consecutive-failure logic, but its **code** implements a plain running counter identical in spirit to curate's — the docstring describes behavior the code does not have. Latent shared-helper opportunity (extract one `deriveCronStatus(state, {source, prefix})`), but refactoring now would widen this diff and risk regressing two callers. **Flagged for the audit; explicitly not fixed here.** (NG4.)
- **Active push alerting** (Telegram/email). The notice rail is the channel. (NG3.)

---

## 11. Supporting files reviewers should read

Reference pattern (clone targets):
- `src/util/update-check.js` — the cache model this mirrors. Anchors: atomic write `:107-115`; failure fold preserving last-success `:203-219`; opt-out predicate + `OPT_OUT_VALUES` `:45-53`; `THROTTLE_MS`/`SCHEMA_VERSION`/`HEALTHY_FAILURE_THRESHOLD` constants `:40-42`; `Number.isFinite` stamp guard (the #8 NaN pattern) `:269-271`; `maybeFireUpdateCheck` throttle gate `:265-280`.
- `src/util/update-check-worker.js` — the "compute then atomic-write cache" worker `cmdCurateStatus` is the cron-hosted analogue of.
- `silo-mcp/notices.js` — `loadUpdateStatus` mtime-cache **mechanism** clone target `:62-77` (verified: returns only the parsed `status`/`null`, **never** `st.mtimeMs` — `loadCurateStatus` must diverge to a `{kind,…,mtimeMs}` envelope per L1/L2); `updateCache` module var (the #10 "own var" precedent) `:26`; `buildSiloNotices` insertion point `:111-161`; `update_check_unhealthy` branch this parallels `:143-157`; cross-package opt-out duplication note + `isUpdateOptOut` `:36-46`; `_resetUpdateCache` test seam `:32-34`.
- `silo-mcp/server.js` — notice wiring: `UPDATE_STATUS_PATH` pinned to `SILO_DIR` `:55`; `siloNoticesForRead` `:212-219`; `_silo_notices` passthrough schema `:311`.

Reused logic:
- `src/cli/silo.js` — `deriveCuratorStatus` (reuse + must-export + **add `last_event_kind` to the return**, R2-Live-3; returns `null` on no events `:1259`; fold loop to instrument `:1244-1257`; return object `:1260-1265`) `:1230-1266`; `cmdDoctor` curate readout (the pull-only status this makes passive; **unchanged** — does not consume `last_event_kind`) ~`:1142-1204`; dispatcher switch (add `curate-status` case) `:1394-1432`; auto-fire exclusion gate (add `curate-status`) `:1385-1391`; `printHelp`; `openWriter` `:82`; `interpret` import `:34`.
- `src/projection/regenerate-pending-suggestions.js` — `deriveDetectorStatus` near-duplicate (the §10 dedup flag, and the *rejected* §9b piggyback host).

Host & sources of the heartbeat:
- `scripts/silo-curate.sh` — the monitored job AND the in-band recovery host. Trap insertion after `:39` (post `source "$ENV_FILE"`); heartbeat writes `:51-58` (started) / `:84-91` (complete|failed), `source=silo-curate`, `principal=curator`; final `exit "$CURATE_STATUS"` `:97`; the script whose lost exec bit caused the 10-day silence (now `100755`).
- `scripts/silo-detect.sh` — the out-of-band death-detection host. Trap insertion after `:44`; bash flock isolation `:32-36`; final `exit "$DETECT_STATUS"` `:106`; detect status-event format (`source=silo-topic-detector`, **not** `silo-detect`) `:57-92`.

Tests to mirror:
- `test/update-check.test.js` — cache I/O + fold + throttle + worker-smoke style.
- `test/status-events.test.js` — `LogWriter`/`emitSystemEvent` fixtures + end-to-end CLI parser assertions; confirms `deriveCuratorStatus` is currently private `:8-10`.
