# SPEC — Write-Event Slug-Existence Guard

**Status: RATIFIED (2026-06-16)** — design-complete; ships as **v0.2.5**. Promoted to `silo/proposals/slug-existence-guard.md`.
**Repo:** `C:\Users\studi\OneDrive\Desktop\Claude Code\silo` (paths repo-relative).

**Ratification basis (honest convergence note).** Four review rounds (fresh Claude clean-seat + ChatGPT + Gemini-Pro each). The core design converged: the **write-admissible set** (the round-2 bypass fix) was **triple-validated** in round 3; round 4 raised **no design objection** — only three append-mechanism *build-precision* MAJORs, each with a known repo pattern. This is **not** a strict "no-new-MAJOR" convergence round; it is an **owner decision** that those three are implementation details best verified by the build's test suite (the retire / curate-liveness precedent: ratified design → built through tests), not by further spec rounds. They are folded as **RESOLVED build-decisions:**

- **R4-MAJOR-1 → RESOLVED.** The admissible set is **threaded into `_appendBatchUnlocked` as an `admissionContext` parameter**, built **once per locked session** — by `withAppendLock` from its existing `freshState`, and by the bare `append`/`batchAppend` entrypoints from their own post-rescan `interpret()`. `_appendBatchUnlocked` must NOT fold per call (that is the O(N²) trap). Gate: a "context fresh per session / no double-fold" test.
- **R4-MAJOR-2 → RESOLVED.** Topic-file import **forces `type='reference'`** when source frontmatter omits `type` (mirrors `acceptSuggestion`'s `?? 'reference'`), so a type-less `TOPIC_METADATA_SET` can't leave the following summary `write_event` non-admissible. Gate: a typeless-topic-file import test.
- **R4-MAJOR-3 → RESOLVED.** `curate` (and any LLM-in-loop writer) takes its lock **per-slug, after `llm.complete` returns** — the pattern `silo retire` already uses (`silo.js:822`) — never holding the flock across an LLM call. "Once per locked session" = once per slug-batch; still O(total writes).
- **Minors folded:** reactive `extract` wraps each append (state-file advance unconditional; fail-loud on a mid-loop gate trip); the MCP `write_event` error contract changes `SLUG_NOT_FOUND` → `SLUG_NOT_ADMITTED` (the `AdmissionError` hint carries a "create the topic / use `general`" pointer); `silo topic create` reuses `acceptSuggestion`'s collision/cooldown logic (shared, not duplicated).

Full audit trail in this archive (`SPEC-…-v1..v4.md`, `response-*` × 4 rounds, `FOLD-SYNTHESIS.md`). The body below is the v4 design; the resolutions above refine §4.2 / §4.6 / §4.8.

---

## 0. One-paragraph summary

A `write_event` whose `payload.slug` is neither a **reserved sink** (`general`, `system`) nor in the **write-admissible set** — `{slugs with ≥1 prior write_event} ∪ {slugs with a TOPIC_METADATA_SET that set topic_type}` — is **rejected** in `_appendBatchUnlocked`'s admission section (beside the matrix gate), throwing `AdmissionError('SLUG_NOT_ADMITTED')`. The admissible set + intra-batch staging live in an **ephemeral, lock-scoped admission context** derived from `interpret()` under the append flock (log-truth, fresh, computed once per locked session, never a long-lived `LogWriter` cache). Under the same lock the write also passes a **tail-safety gate** (refuse if `freshState.last_seq !== freshTail.seq` — the gate `silo retire` already uses — so a write never chains onto a broken physical tail and silently orphans). So no writer — CLI, import, `extract`, cron, MCP, or any future non-MCP writer, **on any socket including `admin`** — can self-create a junk topic or scatter onto a novel slug. New topics are born only via a `TOPIC_METADATA_SET` (`accept_suggestion`, import, or a new `silo topic create`). Loud, structured, never silent. The guard is **content-integrity, orthogonal to access-control**.

---

## 1. Motivation
*(unchanged from v2/v3)* A `write_event` to a novel slug self-creates the topic (`interpret/index.js:381`); the only existence gate is on the MCP bridge (`server.js:704`, projected index, exempts only `general`); CLI/`extract`/import are ungated; the admission core is slug-agnostic. A 30-day census found zero junk slugs — this is **preventive insurance** for a future non-MCP writer the owner won't be watching for, and for the multi-user future (§4.7). Airtight against a future writer requires the shared `LogWriter` boundary and guarding `admin` (caller-declared metadata, not an auth boundary).

---

## 2. Goals / Non-goals

### Goals
- **G1.** Admit a `write_event` only if `slug ∈ {general, system}` OR `slug` is write-admissible (§4.3); else reject with `AdmissionError('SLUG_NOT_ADMITTED')`.
- **G2. Airtight across all writers and all sockets** — the admission context is required for `write_event`; no caller bypasses by omission or by claiming `admin`.
- **G3. Loud structured reject, never silent** — `AdmissionError`, surfaced via `extractAdmissionCode`. No payload mutation.
- **G4. Log-truth existence, narrowed** — the write-admissible set (§4.3) from `interpret()`, not the projection and not raw `topic_index`. Remove the MCP projected-index pre-gate.
- **G5. Creation stays possible + deliberate** — `TOPIC_METADATA_SET` (with `type`) + a new deterministic `silo topic create`.
- **G6. Content-integrity ⊥ access-control** — principal-agnostic; composes with the ACL/matrix/tier layer.
- **G7. O(N), thin `LogWriter`** — the admissible set lives in an **ephemeral lock-scoped context**, computed once per locked session, never a long-lived instance cache; loop writers append under one batched session.
- **G8. Append integrity** — a `write_event` never chains onto a broken physical tail (tail-safety gate, §4.2).

### Non-goals
- **NG1.** NOT M-route/misfiling. **NG2.** NOT a who-can-write auth lockdown — and the guard is `write_event`-only, so **`TOPIC_METADATA_SET` topic-creation is NOT gated** (any writer can mint a topic slot; that is the access-control axis, deferred to the multi-user ACL/tier layer — §4.9). **NG3.** No silent coercion (visible, warned `extract`→`general` is allowed). **NG4.** No log/event-schema, detector, or projection change. **NG5.** Does not retroactively seal pre-guard orphans (grandfathered — they have write_events).

---

## 3. Current state (code-grounded)

| Fact | Location |
|---|---|
| `write_event` self-creates; only `applyWriteEvent` pushes `topic_content` | `interpret/index.js:374-411` (`:381`, `:402-410`) |
| `TOPIC_VERIFIED`/`TOPIC_CURATED` create `topic_index` slots via `ensureTopicMetaSlot` WITHOUT a write/metadata or payload validation (the round-2 bypass) | `interpret/index.js:215-233`, `:359` |
| `TOPIC_METADATA_SET` sets `meta.topic_type` **only if `type` is present** (`type` is optional) | `interpret/index.js:309-324` (`:315`) |
| `accept_suggestion` defaults `type:'reference'`; import sets type before writing | `suggestion-ops.js:115`; `import-jarvis/index.js:197-248` |
| Matrix gate throws `AdmissionError` (`:280-295`); `validatePayloadForAppend` (`:302`) throws `AdmissionValidationError` and gets only `{type,payload}` | `log/append.js:257-343` |
| `withAppendLock` computes `interpret(this)` as `freshState` under the flock; `append.js` imports `interpret` | `log/append.js:38, 217-232` |
| **`silo retire` already gates on `freshState.last_seq !== freshTail.seq`** (refuse to append onto a broken physical tail) — the pattern G8 adopts | `topic-proposal/retire-ops.js` (tail-safety gate); prod log has 17 mid-log breaks, tail healthy |
| Loop writers append one entry at a time (bare `append`): `cmdExtract` (`silo.js:440`), import (`events.js:161`, `index.js:248`), `runBootstrapCurate` (`silo.js:534`), curate bullets (`silo.js:856`) | — |
| Restore-from-backup is `tar -xzf` (file copy — no re-append) | `silo-backup.sh:28` |
| `{general, system}` sinks complete (curate/detect/backup `--slug=system`) | `silo-{curate,detect,backup}.sh`; `detect.js:428` |

---

## 4. Design

### 4.1 The rule
Admit a `write_event` iff `slug ∈ {general, system}` OR `slug ∈ context.writeAdmissible ∪ context.stagedAdmissible` (§4.2/§4.3). Else reject (before build/serialize/hash) with `AdmissionError('SLUG_NOT_ADMITTED', {slug, hint})`.

### 4.2 The lock-scoped admission context + tail-safety gate (R3-D1, R3-D2)
The guard runs **in `_appendBatchUnlocked`'s admission section** (beside the matrix gate, so it throws `AdmissionError`). Within a locked write session, after the flock is held and the tail rescanned:

```
freshState = interpret(this)                       // withAppendLock callers REUSE their existing freshState (no double-fold)
if (freshState.last_seq !== freshTail.seq) throw AdmissionError('LOG_TAIL_NOT_INTERPRETABLE')   // G8 — retire's gate
context = {                                         // EPHEMERAL — lives only for this locked session
  stateSeq: freshState.last_seq,
  writeAdmissible: deriveWriteAdmissible(freshState),   // §4.3
  stagedAdmissible: new Set(),                      // intra-batch creations
}
// per entry: if write_event, require context; admit iff slug ∈ sinks ∪ writeAdmissible ∪ stagedAdmissible
// when a TOPIC_METADATA_SET(type) or write_event for slug X is staged earlier in the batch, add X to stagedAdmissible
// the context is discarded when the lock releases (never stored on the LogWriter instance)
```

- **Lock-scoped, ephemeral (R3-D2):** the context is **not** a long-lived `LogWriter` property (Gemini: a mid-session failure without a `finally` clear would leak a stale set into the next session) and **not** caller-passed (ChatGPT: omission breaks G2). It is built once per locked session and dies with it.
- **O(N), thin writer (G7):** computed once per locked session; **loop writers (import / `extract` / `curate` / bootstrap) must append under one batched/locked session** so the fold happens once, not per entry. `withAppendLock` callers reuse `freshState` (no second fold).
- **Tail-safety gate (R3-D1/G8):** `freshState.last_seq !== freshTail.seq` means the physical tail is broken (a torn/corrupt suffix `interpret()` skipped); appending would chain past it and be silently orphaned. Refuse loudly — exactly as `silo retire` does. Free (we already have both seqs); inert in normal operation (healthy tail). Replaces v3's incorrect "writes still work across breaks" claim.

### 4.3 The write-admissible set (the bypass fix — R2-D1, clarified R3-D5)
```
deriveWriteAdmissible(state) =
      { slug : state.topic_content.get(slug) has ≥1 entry }       // ≥1 real write_event (incl. CURATED bullets) — grandfathers pre-guard orphans
    ∪ { slug : state.topic_index.get(slug)?.topic_type is set }   // a TOPIC_METADATA_SET WITH type — accepted/created topics
                                                                   // reserved sinks {general, system} handled in §4.1
```
**Creation marker = `topic_type` PRESENT** (R3-D5): `TOPIC_METADATA_SET.type` is optional, so a `{topic, summary}`-only metadata event creates a `topic_index` slot but is **not** write-admissible — correct/secure (no legit flow does this: accept + import always set `type`). Excludes `TOPIC_VERIFIED`/`TOPIC_CURATED`-only slots (the bypass — they set neither field). **Note:** write-admissible ⊋ projection-visible — a slug with `topic_content` but no `topic_type` is event-log-only (like `general`) and renders no topic file (`regenerate-topic-file.js:359`); admitting it is correct (grandfathering / event-log writes), not a bug.

### 4.4 Reserved sinks `{ general, system }`
Both exempt (§4.1); `system` is the cron/backup status sink, created-on-first-write, no metadata. Verified complete. Forward rule: any new cron sink must use `system`/`general` or `silo topic create` first.

### 4.5 Source of truth + MCP pre-gate removal
Derive from `interpret()` (log-truth); **delete the MCP `write_event` projected-index check** (`server.js:704`) — the core is the single authority; the MCP write path routes through the CLI (`spawnSync … silo write …`), so it inherits the guard transitively. Update the tool description.

### 4.6 `silo topic create` (R3-D4, R3-D5, R3-D7) — deterministic + safely locked
Emits `TOPIC_METADATA_SET` **with `type`** so the slug becomes write-admissible. Uses the **locked public** write path (NOT the unlocked `_appendBatchUnlocked` from a standalone CLI invocation — that would write without the flock; the unlocked primitive is only for internal callers already holding the lock, which pass the session context). Behaviour: reject if `slug` has `topic_type` (`SLUG_COLLISION`); default `type='reference'` (overridable `--type`) + `status='active'`; if a pending suggestion with the same **normalized** slug exists → **fail `PENDING_SUGGESTION_EXISTS`** (listing all matching seqs) unless `--dismiss-pending` (dismiss **all** matches with `cooldown_days=1` in the same locked batch before the `TOPIC_METADATA_SET`); active cooldown → require `--override-cooldown`. No ACL seeding (T1 ACL attaches on first write). Defer `--adopt`. Error codes routed as `AdmissionError`/op-error so MCP surfaces them structurally.

### 4.7 Admin socket — guard both; multi-user rationale *(unchanged from v2/v3)*
Guard `write_event` on `standard` AND `admin`. `socket` is caller-declared, not an auth boundary, so exempting `admin` plants a cargo-cultable bypass. Multi-user: content-integrity (does the topic exist) ⊥ access-control (who may write); `admin` is meant to become a real privilege boundary; welding "skip slug guard" onto it would give the privileged a scatter exemption at scale. Keep the axes separate.

### 4.8 The other writers (R3-D3)
- **Import.** Topic-file import is metadata-first (each `append` its own locked batch, so the slug is admissible before the same-topic writes). Event-log import's only NEW failure surface is **existence** (non-canonical slugs already fail `assertSlugString`); preflight is existence-only (pre-seed `TOPIC_METADATA_SET` or fail with a report) — appended under one batched session (G7).
- **`silo extract` — reactive (R3-D3).** No out-of-lock pre-validate (that would fold the log without the lock = race / violates G4). The distill **prompt** routes unknown→`general` (strengthen "if unsure" → "if the slug is not in the index"). `cmdExtract` appends each entry to its target; **on `AdmissionError('SLUG_NOT_ADMITTED')`, catch and re-append to `general`** with a per-entry warning in the summary (visible, NG3-compliant). Core stays the single authority; race-free.
- **Tests.** A `seedTopic(writer, slug)` helper (create-then-write); no disable-flag; no admin-for-tests.

### 4.9 No recovery escape; the `TOPIC_METADATA_SET` limitation (R3-D6)
**No `write_event` bypass** — restore is a file copy (`silo-backup.sh:28`); creation (`TOPIC_METADATA_SET`/`silo topic create`) is always available, so a rejected write is answerable by "create the topic" — no brick. **Known limitation (document honestly):** because the guard is `write_event`-only, `TOPIC_METADATA_SET` is **not** gated — any writer can mint a topic slot via `TOPIC_METADATA_SET{junk}` (which then becomes write-admissible). So `write_event` is airtight; topic *creation* is open. That's the **access-control** axis (who may create topics), deliberately deferred to the multi-user ACL/tier layer (NG2/§4.7). For a single disciplined user it's a non-issue; the multi-user layer will gate `TOPIC_METADATA_SET` by principal/tier.

### 4.10 Error behaviour
`AdmissionError('SLUG_NOT_ADMITTED' | 'LOG_TAIL_NOT_INTERPRETABLE', {…})` thrown in the admission section → CLI dispatcher emits `ADMISSION_REFUSED:<code>` → MCP `extractAdmissionCode` surfaces it structurally.

---

## 5. Resolved (round 4 → ratified)
All round-4 questions are resolved — see the **Ratification basis** block at the top. R4-Q1 (context + tail gate): correct, leak-free, and O(N) under the threaded-`admissionContext` resolution (R4-MAJOR-1); the tail gate is retire's verified pattern, inert on a healthy tail, no race (the flock spans rescan → interpret → callback). R4-Q2: the LLM-in-loop concern is resolved by per-slug locking (R4-MAJOR-3); reactive `extract` is benign. R4-Q3: **ratifiable** — the three MAJORs are RESOLVED build-decisions.

---

## 6. Failure modes

| # | Scenario | Mitigation |
|---|---|---|
| **F1** | Cron `system` write rejected | Exempt `{general, system}` (§4.4) |
| **F2** | `TOPIC_CURATED{junk}` + `write_event(junk)` bypass | Write-admissible excludes verify/curate-only slots (§4.3) |
| **F3** | Batch `TOPIC_METADATA_SET(foo)`+`write_event(foo)` false-reject | `stagedAdmissible` batch-local staging (§4.2) |
| **F4** | Guard reject unstructured | `AdmissionError` in the admission section (§4.2/§4.10) |
| **F5** | Write chains onto a broken physical tail → silently orphaned | Tail-safety gate `last_seq !== freshTail.seq` → refuse (§4.2/G8) |
| **F6** | O(N²) on loop writers | Once per locked session + batched loop writers (§4.2/G7) |
| **F7** | Stale admissible set leaks across sessions | Ephemeral lock-scoped context, dies with the lock (§4.2/G7) |
| **F8** | `extract` LLM emits novel slug | distill→`general` + reactive catch-and-coerce (§4.8) |
| **F9** | Projection-lag false-reject (bug today) | Log-truth + MCP pre-gate removal (§4.5) |
| **F10** | Future writer claims `socket:'admin'` | Guard on `admin` too (§4.7) |
| **F11** | Junk topic minted via `TOPIC_METADATA_SET` | Documented access-control limitation; future ACL/tier gate (§4.9) |

---

## 7. Test plan (sketch)
- **Guard core:** reject unknown slug (`SLUG_NOT_ADMITTED` via `ADMISSION_REFUSED:`); admit write-admissible / `general` / `system`; admit on `admin` only if write-admissible (F10).
- **Bypass closed (F2):** `TOPIC_CURATED{junk}` then `write_event(junk)` → rejected.
- **Creation marker (R3-D5):** `TOPIC_METADATA_SET{topic, summary}` (no type) then `write_event` → rejected; with `type` → admitted.
- **Intra-batch (F3):** `[TOPIC_METADATA_SET(foo, type), write_event(foo)]` in one batch → admitted.
- **Grandfathering:** pre-existing slug with a prior write_event, no metadata → admitted.
- **Tail-safety (F5):** with a broken physical tail (`last_seq < freshTail.seq`), a `write_event` → `LOG_TAIL_NOT_INTERPRETABLE`; healthy tail → admitted.
- **Context lifecycle (F7):** a failed session does not leak the admissible set into the next (assert fresh context per session).
- **Cron (F1):** `system` writes succeed.
- **Import / `extract` (F8):** event-log import preflights; `extract` with a novel slug routes that entry to `general` (warned), others land normally, no whole-session loss, no silent rewrite.
- **`silo topic create`:** creates a typed topic that then accepts writes; `SLUG_COLLISION` / `PENDING_SUGGESTION_EXISTS` / cooldown.
- **Regression:** full 560-test suite green after the `seedTopic` migration.

---

## 8. Supporting files
`src/log/append.js` · `src/admission/payload-validators.js` · `src/interpret/index.js` (`:215-233`, `:309-324`, `:381`, `:402-410`) · `src/topic-proposal/retire-ops.js` (the tail-safety gate to mirror) · `silo-mcp/server.js` (`:704`, `:214`) · `src/cli/silo.js` (`cmdWrite`/`cmdExtract`/dispatcher `:1526`) · `src/distill/distill.js` · `src/topic-proposal/suggestion-ops.js` (`:115` type default) · `src/import-jarvis/events.js` + `index.js` · `src/topic-proposal/detect.js` · `src/projection/regenerate-topic-file.js` (`:359`) · `src/matrix/matrix.yaml`.

---

## 9. Out of scope / follow-ups
M-route (NG1) / future `move`. · Who-can-write auth lockdown + gating `TOPIC_METADATA_SET` (NG2 / the multi-user ACL/tier layer). · Detector-liveness alarm — deferred. · `silo topic create --adopt` — deferred. · Pre-existing seams: looser import slug regex; MCP `write_event` zod tag-enum stricter than core.

---

## 10. v3 → v4 deltas (round-3 fold)
- **R3-D1 — tail-safety gate (§4.2/G8/F5):** refuse `write_event` if `last_seq !== freshTail.seq` (retire's pattern); dropped v3's wrong "writes work across breaks."
- **R3-D2 — lock-scoped ephemeral admission context (§4.2/G7):** not an instance cache, not caller-passed; loop writers batch.
- **R3-D3 — `extract` reactive (§4.8):** catch `SLUG_NOT_ADMITTED` → `general`, no out-of-lock pre-validate.
- **R3-D4 — `silo topic create` uses the locked public path (§4.6).**
- **R3-D5 — creation marker = `topic_type` present (§4.3/§4.6);** default `type='reference'`.
- **R3-D6 — documented `TOPIC_METADATA_SET` access-control limitation (§4.9/NG2).**
- **R3-D7 — pending-suggestion normalized matching + dismiss-all (§4.6).**
