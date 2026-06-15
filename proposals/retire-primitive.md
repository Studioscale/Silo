# SPEC — `silo retire`: a first-class curated-bullet retirement primitive

**Status: RATIFIED — Gemini-Pro third seat folded; integrity-guard resolved as Option B (tail-safety gate). Independently re-verified against source by the succeeding Silo lead before ratification. — 2026-06-14**
**Round-2 → v3 → v4 note:** round 2 ran three seats — fresh Claude (READY-WITH-CHANGES), fresh ChatGPT (NOT-READY on ONE real trivial MAJOR), and Gemini (DISCARDED — ran on Flash, category-errored by treating this design spec as already-implemented; verified invalid, treat as an empty seat). Because retire picked up one real MAJOR **and** the Gemini seat was empty, v3 folded the fixes (see the "Round-2 → v3 changelog" below) and got ONE more targeted review by a real Gemini-Pro. **That third seat ruled on the one OPEN item (changelog #4): re-scope the integrity guard (option b), NOT drop it (option a) — because `LogWriter._scanTailUnlocked` is hash-chain-blind, dropping the guard lets a new append chain onto a broken/malformed physical tail and be silently orphaned.** v4 folds that ruling as a **tail-safety gate** (`refuse iff freshState.last_seq !== freshTail.seq`), plus a CLI usage NIT (friendly required-flag errors). The succeeding Silo lead independently re-derived the guard from `src/log/append.js` + `src/interpret/index.js` before ratifying and concurred (also catching that v3's *sketched* option (b) was itself buggy — it read a nonexistent `freshState.tail` field; the `last_seq` form fixes it). Round-2 adjudication: `silo-design-history/11-retire-and-liveness-audit-archive/ROUND2-FOLD-SYNTHESIS.md` (the "Retire" section is authoritative). Round-1 change→finding map: `silo-design-history/11-retire-and-liveness-audit-archive/ROUND2-CHANGELOG.md`.
**Supersedes:** the v1 draft at `silo-design-history/11-retire-and-liveness-audit-archive/SPEC-retire-primitive.md` (DRAFT, pre-audit), and the v2 round-1-fold draft.
**Folds:** the 3-reviewer round-1 adversarial panel (fresh Claude, ChatGPT, Gemini) and the adjudication record `silo-design-history/11-retire-and-liveness-audit-archive/FOLD-SYNTHESIS.md`, PLUS the round-2 fold (`ROUND2-FOLD-SYNTHESIS.md`). All §9 open questions are RESOLVED (see §9 "Resolved questions"). The one open decision (B1 — harden `cmdCurate`) was resolved as **(A) Patch cmdCurate**.
**Author:** desktop-claude (round-1 fold pass; round-2 fold pass; Gemini-Pro third-seat fold + independent source re-verification → RATIFIED)
**Target version:** v0.2.2.

> **✅ RESOLVED (was the one open item).** Changelog item #4 (the `LOG_INTEGRITY_UNSAFE` integrity-guard correction) is **closed**. The v2 guard ("refuse on ANY `hash_chain_break`") was HARMFUL — it bricks retire against the production log's 17 historical hash-chain breaks. v3 floated two replacements: (a) drop the guard, or (b) re-scope it to a genuine *tail*-break. v3 recommended (a). **The Gemini-Pro third seat ruled (b), and the succeeding Silo lead independently re-verified and concurred:** (a) is unsafe because `LogWriter._scanTailUnlocked` (`src/log/append.js:109-156`) is hash-chain-*blind* — it returns the last syntactically-valid line as the chain anchor without verifying `hash_prev`, so a new append chains onto a broken/malformed physical tail and `interpret()` then silently *orphans* it (the CLI reports `{retired:true}` but the bullet is not retired). v4 folds (b) as a **tail-safety gate: `refuse iff freshState.last_seq !== freshTail.seq`** (§4.5) — which trips only when the *physical tail* (`freshTail.seq`, the entry the append chains onto) is not the *last folded* entry (`freshState.last_seq`). It does NOT trip on historical *middle* breaks (those re-sync; the tail stays folded — which is why nightly `cmdCurate` retires across them). It is a strict superset of a `hash_chain_break`-only check (also catches a shape-malformed tail). Every other changelog item (#1 `--seq` parser, #2 all-four-principals, #3 curate summary) is a folded fix.

> **Scope-of-change note (read first).** This feature is additive — one new CLI verb (`silo retire`), one new MCP tool (`retire_bullet`), one new ops module (`src/topic-proposal/retire-ops.js`) — **plus exactly one hardening edit to already-shipped code: the retire emission inside `cmdCurate` (the curate COMMAND), §B1.** That edit does **not** touch the sealed core (the operation log `src/log/*`, canonicalization `src/log/canonical.js`, `interpret()` `src/interpret/*`, or the admission matrix `src/matrix/*`). It touches only the curate command's emit path, which is fair game under "don't touch what's finished." Everything else *rides* the existing `TOPIC_BULLETS_RETIRED` event type with no new event type, no log-format change, no canonicalization change, no projection-model change.

---

## Round-2 → v3 → v4 changelog (deltas folded; integrity guard RESOLVED)

Five changes, each tagged with the finding it answers (`ROUND2-FOLD-SYNTHESIS.md`, "Retire" section, + the Gemini-Pro third seat). #1–#3 are mechanical round-2 folds; **#4 was the one OPEN design item — now RESOLVED as a tail-safety gate (option b)** by the Gemini-Pro third seat + independent source re-verification; #5 is a usage-ergonomics NIT folded alongside. Nothing in §§1–11 outside these anchors changed.

| # | Change | Answers | Type | Spec anchors touched |
|---|---|---|---|---|
| **1** | **`--seq` parser made safe.** v2 parsed tokens with `Number.parseInt(s.trim(),10)`, which silently coerces `"12abc"→12`, `"1.5"→1`, `"2x"→2` — a fat-fingered seq could retire the **wrong** bullet (projection-destructive). v3 tokenizes the comma-list, requires each token to match `^[1-9]\d*$` **before** conversion, then `Number(token)` + `Number.isSafeInteger`. Any non-conforming token → usage error (exit 2), nothing appended. | **R2-Retire-1 [MAJOR, ChatGPT]** | §4.2 (`--seq` parsing), §8 #24/#25 (CLI smoke tests: `1.5`, `12abc`, empty comma token, `0`, negative, unsafe-int >2^53) | FOLDED |
| **2** | **`SILO_MCP_PRINCIPAL` applied to ALL FOUR MCP write tools**, not just `retire_bullet`. v2 added the server-configured principal to `retire_bullet` only; `write_event`/`accept_suggestion`/`dismiss_suggestion` kept the `desktop-claude` literal → the same caller logs under two principals. v3 routes one `MCP_PRINCIPAL = process.env.SILO_MCP_PRINCIPAL \|\| 'desktop-claude'` constant through all four spawn sites (verified to exist: `silo-mcp/server.js:705` write, `:832` accept, `:884` dismiss, + the new retire tool). Documented as the **"server-deployment principal,"** not "caller identity." | **R1 [MINOR, Claude]** | §4.3, §9d | FOLDED |
| **3** | **`cmdCurate` summary now reports the actually-retired set.** v2's §B1 patch set `retired = stillValid.length` (the count) but the existing summary path still reports `retired_seqs: supersededSeqs` (the **pre-filter** seqs, `src/cli/silo.js:868`). If a manual retire wins the race and B1 filters a seq out, the log is correct but the summary falsely claims curate retired it. v3 carries `actuallyRetiredSeqs = stillValid` out of the `withAppendLock` block and reports **that** in the summary. | **R2-Retire-2 [MINOR, ChatGPT]** | §4.6 (§B1 patch + summary), §6 (nightly-emitter row) | FOLDED |
| **4** | **✅ RESOLVED — `LOG_INTEGRITY_UNSAFE` re-scoped to a TAIL-safety gate (option b).** The v2 guard (folded from a round-1 ChatGPT MINOR) made `retireBullet` refuse to append if `freshState.skipped` contained **any** `hash_chain_break`. That bricks retire in production, which permanently carries **17 historical "accept-as-history" hash-chain breaks** (April, seq ~599–615): nightly `cmdCurate` appends `TOPIC_BULLETS_RETIRED` fine across them because a new append chains to the **valid tail** (`interpret` skips broken *middle* entries and re-syncs). So an "any skipped break" guard is a guaranteed false-positive. v3 floated (a) drop it, or (b) re-scope to a *tail-unsafe* condition. **The Gemini-Pro third seat + independent source re-verification chose (b):** dropping the guard is unsafe because `_scanTailUnlocked` (`src/log/append.js:109-156`) is hash-chain-*blind* — it returns the last syntactically-valid line as the anchor without checking `hash_prev`, so if the *physical tail* is broken/malformed, a new append chains onto it and `interpret()` silently *orphans* it (skips it as a chain break) while the CLI reports success. v4 implements (b) as **`refuse iff freshState.last_seq !== freshTail.seq`** (the last *folded* seq ≠ the *physical tail* seq → the tail the append would chain onto was not accepted → refuse). This trips ONLY on a genuinely unsafe tail, never on historical middle breaks, and is a strict superset of a `hash_chain_break`-only check (also catches a shape-malformed tail). The gate is **manual-op-only**; `cmdCurate` stays ungated (§4.6) — the reviewer-blessed scoping from v3. | **CRITICAL CORRECTION** (re-scopes a v2 fold) + resolves **R2 [MINOR, Claude]** | §4.2 (`LOG_INTEGRITY_UNSAFE` row), §4.5, §4.6, §7 #17, §8 #15, §9 (additional-folded-fixes note) | **RESOLVED — option (b), tail-safety gate** |
| **5** | **✅ NIT — friendly required-flag usage errors.** A missing `--seq` previously fell through the token parser and produced the confusing `--seq value "undefined" is not a positive integer`. v4 adds explicit `if (!values.seq)` / `if (!values.slug)` guards at the top of `cmdRetire` that emit a clear "`--seq is required`" / "`--slug is required`" usage error (exit 2, nothing appended) before any token parsing. | **NIT** (folded with the Gemini-Pro pass) | §4.2 (`--seq`/`--slug` parsing) | FOLDED |

**Provenance note:** items #1–#3 were mechanical round-2 folds. Item #4 was the one design judgment call; it is now RESOLVED as option (b) — see §4.5 for the tail-safety gate and §4.6 for why the same gate is deliberately NOT mirrored onto `cmdCurate`. Item #5 is a trivial usage-ergonomics NIT folded alongside.

---

## 0. Verification ledger (claims checked against source before ratifying)

Two claims gate this entire design; both were verified against the actual files in this pass:

1. **Import-origin tag — VERIFIED YES (the feature is NOT blocked).** `src/import-jarvis/index.js:266-286` — `importTopicFile` parses each Layer-2 `## Heading` section (`parseCuratedSections`, `src/import-jarvis/index.js:159-181`) and emits it as `writer.append({ type: 'write_event', … payload: { slug, tag: 'CURATED', content: '## heading\n\n<body>', imported: { …, field: 'curated', heading } } })`. The tag is literally `'CURATED'`. Corroborated by the admission validator's own comment (`src/admission/payload-validators.js:518-522`): "import-jarvis emits whole Layer-2 sections (`## heading\n\nbody...`) as a single event so the section stays a coherent unit." **Therefore `silo retire` CAN retire imported blobs** — the de-bundle target (§1a) and the misfiled-bullet target (§1b) are both reachable. This also establishes the **granularity gotcha** loudly (§1, §7 #15, §10): one imported section = one `write_event` = one retire unit. Retiring it removes the *entire* `## Heading` block, not a single rendered line.

2. **`cmdCurate` lacks lock-scoped retire revalidation — VERIFIED TRUE (B1 is real).** `src/cli/silo.js:559` (`cmdCurate`) computes `state = await interpret(writer)` at `:569` — **before any lock**. Its active-CURATED list `curatedEventList` is built at `:651-653` from that pre-lock `state.retired_curated_seqs`. The LLM's `RETIRE:` indices resolve to `supersededSeqs` at `:784-786`, and the retire event is appended at `:808-814` via `writer.append(...)` (which takes the lock *only for the append*, with **no re-read of `retired_curated_seqs` under that lock**). So a seq retired by a concurrent manual `silo retire` between `cmdCurate`'s interpret and its append would still be emitted — a no-op `TOPIC_BULLETS_RETIRED` that pollutes the append-only log. The draft's §5.4 claim that "curate dedups its own retire set / the loser doesn't re-emit" was **not implemented**. B1 (§4.6) closes it.

---

## 1. Problem & motivation

Silo's only mechanisms today for removing a curated bullet are:

1. **The nightly LLM curate loop** (`silo curate`, `cmdCurate` in `src/cli/silo.js:559`). It emits `RETIRE: <n>` lines parsed at `src/cli/silo.js:768`, resolves them to seqs (`src/cli/silo.js:784-786`), and appends a `TOPIC_BULLETS_RETIRED` event (`src/cli/silo.js:808-814`). This is *judgment-driven and batched* — you cannot ask it to retire a specific bullet *now*, and it only fires on cron.
2. **Hand-editing the operation log.** This breaks the hash chain by construction and is exactly the line the project forbids crossing.

This session produced two concrete tasks that both *needed bullet removal* and both got **deferred for lack of a safe tool**:

- **(a) De-bundle a monolithic CURATED blob** — one CURATED `write_event` had multiple distinct facts crammed into one bullet. Splitting it means retiring the old bundle and writing N new bullets. The "write N new bullets" half is already trivial (`silo write --tag CURATED`); the "retire the old bundle" half had no primitive. **NOTE (granularity):** for import-origin blobs this is exactly the realistic case — an imported `## Heading` section is ONE `write_event`, so retiring it drops the whole section. That is the intended unit (§0 #1, §7 #15).
- **(b) Move misfiled silo-architecture bullets out of `jarvis-claw`** — several bullets describing Silo's *own* architecture were curated onto the wrong topic. Relocating them means retiring them from `jarvis-claw` and re-curating onto the correct topic. Again: the re-curate half is trivial; the retire half was missing.

More generally: **correcting a known-wrong curated fact today requires either the nightly LLM's judgment or a forbidden hand-edit.** A human who *knows* a specific bullet is wrong should be able to retire it deliberately, with an audit trail, riding the exact same event type the curate loop already emits.

This spec proposes `silo retire` (CLI) + `retire_bullet` (MCP) as a thin, audited wrapper over the **already-existing** `TOPIC_BULLETS_RETIRED` event type, plus the §B1 hardening of `cmdCurate` so the "never append a no-op retire event" invariant holds for **both** emitters.

> **GRANULARITY GOTCHA (stated loudly — appears in CLI `--help`, the MCP tool description, §7 #15, §10).** Retire operates on a *seq*, and a seq is one whole `write_event` payload. For native cron-curated bullets, that payload is a single `- bullet` line — fine, one line out. **But for import-origin writes, that payload is an entire `## Heading` section** (`import-jarvis/index.js:269-271`, content = `## heading\n\n<all bullets under it>`). Retiring such a seq removes the **entire section** from Layer 2, not a single rendered line. There is no sub-section retire. The caller must understand: *you are retiring the write, which may render as a whole block.*

---

## 2. Goals / Non-goals

### Goals
- A `silo retire --slug <s> --seq <n>[,<n>...] [--reason <txt>]` CLI verb that retires one **or more** currently-active CURATED bullets **on a single topic**, all-or-nothing.
- A `retire_bullet` MCP tool mirroring the CLI 1:1 (the established CLI-is-the-engine pattern, `silo-mcp/server.js:816-866`).
- **Pre-flight rejection under the append lock** of any `seq` that is not a currently-active CURATED bullet on the named slug — so a bad request *never appends a no-op event to the log* (§5.1, the central risk). **Hard error**, never `{retired:false}`-success, never append-then-noop.
- Shared business logic in one module (`src/topic-proposal/retire-ops.js`) so both surfaces inherit correctness, mirroring `suggestion-ops.js`.
- Emit a `TOPIC_BULLETS_RETIRED` payload **byte-identical in shape** to what `cmdCurate` emits (same field set, sorted+deduped ascending `superseded_seqs`), so the canonical hash contract is preserved across emitters.
- **(§B1) Harden `cmdCurate`'s retire emission** with the same lock-scoped revalidation, so the no-op-retire invariant is true for the nightly emitter too — not just the manual one.

### Non-goals
- No `UNRETIRE` primitive (recovery is re-curation — §5.6).
- No multi-**topic** / cross-topic restructuring in one call (multi-*seq* on **one** topic is in scope; cross-topic is firmly out — §10).
- No content editing — retire removes; it does not rewrite. Rewriting = retire + new `write CURATED`.
- No change to the admission matrix, `interpret()`, `buildLayer2`, the payload validator's contract, the canonical hash, or the log format. The only shipped-code change is the §B1 emit-path hardening inside the curate command.

---

## 3. Design overview

```
  silo retire --slug S --seq N[,N...] [--reason R]
        │
        ▼
  cmdRetire (src/cli/silo.js)               retire_bullet MCP tool
        │  parse/validate argv                   │  zod-validate input (incl. reason admission match)
        │  reason admission-check (pre-lock)      │  spawnSync → silo retire ...
        └──────────────┬──────────────────────────┘  (CLI is the engine; principal = configured/caller)
                       ▼
        retireBullet(writer, {slug, seqs, reason, principal})   ← src/topic-proposal/retire-ops.js
                       │   ── pre-lock, cheap: validate seqs/slug/reason shape ──
                       │
                       │  writer.withAppendLock(async ({writer, freshTail, freshState}) => {
                       │     0. TAIL-SAFETY gate: refuse iff last_seq !== freshTail.seq             ← changelog #4 (option b);
                       │        (broken/malformed tail ⇒ append would be orphaned; §4.5)               never trips on historical mid-breaks
                       │     1. reconstruct ACTIVE-CURATED set for `slug` from freshState           ← TOCTOU-safe
                       │     2. all-or-nothing pre-flight: every seq ∈ active-curated, else throw    ← PRE-FLIGHT REJECT
                       │     3. _appendBatchUnlocked([ ONE TOPIC_BULLETS_RETIRED ])                  ← one event, sorted seqs
                       │  })
                       ▼
        TOPIC_BULLETS_RETIRED  { topic, superseded_seqs:[...sorted], source:'silo-retire', reason? }
                       │
                       ▼  (admission gate: standard:Y — matrix.yaml:148; payload validator — payload-validators.js:393)
                       ▼  (interpret fold: each seq → state.retired_curated_seqs.add(seq) — interpret/index.js:290)
                       ▼  (buildLayer2 skips retired seqs — regenerate-topic-file.js:153)
        regenerate → topic file no longer shows the bullet(s)
```

The op is a **belt-and-suspenders** design: `interpret()` already silently skips a bad seq (§6), so even without pre-flight the *projection* would be correct. The pre-flight exists solely to stop a **valid-but-no-op `TOPIC_BULLETS_RETIRED` event from polluting the append-only log forever** (§5.1). The §B1 change extends that same protection to the nightly `cmdCurate` emitter.

---

## 4. Detailed design

### 4.1 Emitted `TOPIC_BULLETS_RETIRED` payload

Exactly one event per successful `retire` (even for multi-seq — the seqs go in one array, mirroring how `dismissSuggestions` batches `suggestion_seqs` into one event, `suggestion-ops.js:198-212`). Payload (matching the curate emitter's field set, `src/cli/silo.js:802-807`, and the validator's allowed set, `payload-validators.js:412`):

```json
{
  "topic": "<slug>",
  "superseded_seqs": [<seq>, <seq>, ...],   // sorted ascending, deduped, length 1..256
  "source": "silo-retire",
  "reason": "<reason>"                       // OMITTED entirely when --reason absent
}
```

Entry envelope (matching `cmdCurate`'s `writer.append` call, `src/cli/silo.js:808-814`, but committed via `_appendBatchUnlocked` under the existing lock):

```js
{
  type: 'TOPIC_BULLETS_RETIRED',
  isStateBearing: true,
  intentId: `intent:${uuidv7()}`,          // standardized — see note
  principal: <principal>,                   // CLI default 'operator'; MCP passes configured/caller principal (§4.3, §9d)
  payload: <above>,
}
```

Notes:
- **`intentId` shape is standardized on `intent:${uuidv7()}`** (the draft contradicted itself — §4.1 said `intent:${uuidv7()}`, §4.5 said `intent:retire:${uuidv7()}`). Resolution: use the bare `intent:${uuidv7()}` form, matching every other emitter in `cmdCurate` (`src/cli/silo.js:748,811,833,851`) and `acceptSuggestion`/`dismissSuggestions`'s non-prefixed default. The `intentId` is **not** relied on for idempotency (the freshState pre-flight is — §5.5), so no discriminating prefix is needed.
- `superseded_seqs` is sorted+deduped via `[...new Set(seqs)].sort((a, b) => a - b)` **exactly as `cmdCurate` does at `src/cli/silo.js:784-786`** and `dismissSuggestions` does at `suggestion-ops.js:176`. The admission validator hard-rejects non-ascending arrays (`payload-validators.js:452-457`, `must_be_strictly_ascending`) and arrays outside `1..256` (`:430-436`, `MAX_SUPERSEDED_SEQS = 256` at `:39`). Single-seq is the trivial 1-element case of the same path.
- `reason` is constrained by the validator to a non-blank single-line string ≤120 chars (`payload-validators.js:462-471`). The op layer (`retireBullet`/`cmdRetire`) MUST reject longer/multiline/blank `--reason` **before** the lock with `INVALID_REASON` (§4.2, §4.5) so the error is friendly and no lock is taken for a doomed request; the validator is the backstop.
- `source: 'silo-retire'` is the discriminator distinguishing manual retires from `'silo-curate'` retires in the log. (`source` is validator-optional and type-checked only — `payload-validators.js:474`.)

### 4.2 CLI surface — `silo retire`

**Flags** (added to the `options` block at `src/cli/silo.js:1331-1377`):

| Flag | Required | Notes |
|---|---|---|
| `--slug <s>` | yes | topic slug owning the bullet(s) |
| `--seq <n>[,<n>...]` | yes | seq(s) of the active CURATED `write_event`(s) to retire. **Repeatable** (`--seq 5 --seq 9`) **and/or comma-list** (`--seq 5,9`). All must be on `--slug`. |
| `--reason <txt>` | no | ≤120 chars, single line, non-blank; surfaced into payload. Rejected pre-lock if invalid (`INVALID_REASON`). |
| `--principal <name>` | no | global flag (`GLOBAL_OPTIONS`, `src/cli/silo.js:77-80`); default `process.env.SILO_PRINCIPAL || 'operator'` (§9d). |
| `--silo-dir <path>` | no | global flag. |
| `--to <path>` | no | if present, regenerate projections after commit (mirrors `cmdSuggest` accept/dismiss, `src/cli/silo.js:977-980`). See §9e. |

> **`--seq` parsing (R2-Retire-1 — STRICT; round-2 MAJOR).** `node:util.parseArgs` supports repeatable string options as arrays via `multiple: true`. Declare `seq: { type: 'string', multiple: true }`. **First, friendly required-flag guards (changelog #5 NIT)** — a missing `--seq`/`--slug` must produce a clear usage error, NOT fall through the token parser (which would render `undefined` and emit the confusing `--seq value "undefined" is not a positive integer`). Then flatten the repeats + comma-lists into raw string tokens and **validate each token against `^[1-9]\d*$` BEFORE any numeric conversion** — do **not** use `Number.parseInt`, which silently coerces `"12abc"→12`, `"1.5"→1`, `"2x"→2` and could retire the **wrong** (projection-destructive) bullet. Reference:
> ```js
> // changelog #5 NIT — required-flag guards FIRST, before any token parsing.
> // `values.seq` is undefined when the flag is absent (multiple:true → array or undefined),
> // so `!values.seq` cleanly catches the omitted case without rendering "undefined".
> if (!values.slug) {
>   console.error('silo retire: --slug is required');
>   process.exit(2);                  // usage error — append NOTHING
> }
> if (!values.seq) {
>   console.error('silo retire: --seq is required (one or more positive integers, e.g. --seq 5 or --seq 5,9)');
>   process.exit(2);                  // usage error — append NOTHING
> }
> const SEQ_TOKEN_RE = /^[1-9]\d*$/;   // positive integer, no leading zero, no sign/decimal/suffix
> const rawTokens = (Array.isArray(values.seq) ? values.seq : [values.seq])
>   .flatMap((s) => String(s).split(','))   // accept "5,9" and repeated --seq
>   .map((t) => t.trim());
> const seqs = [];
> for (const tok of rawTokens) {
>   if (!SEQ_TOKEN_RE.test(tok)) {
>     console.error(`silo retire: --seq value "${tok}" is not a positive integer`);
>     process.exit(2);                  // usage error — append NOTHING (mirrors dismiss :991-999)
>   }
>   const n = Number(tok);
>   if (!Number.isSafeInteger(n)) {      // rejects >2^53 unsafe ints even when all-digits
>     console.error(`silo retire: --seq value "${tok}" exceeds the safe-integer range`);
>     process.exit(2);
>   }
>   seqs.push(n);
> }
> ```
> This accepts `--seq 5 --seq 9`, `--seq 5,9`, and the mix; rejects `1.5`, `12abc`, `2x`, an empty comma token (`5,,9`), `0`, `-1`, and an unsafe integer (>2^53) as a **usage error (exit 2)** with nothing appended. The regex (not `parseInt`) is what enforces the spec's long-standing "CLI rejects non-integers" claim that v2's code did not actually deliver. The op layer (`retireBullet`) still dedups+sorts and independently re-checks `Number.isSafeInteger(s) && s >= 1` as a backstop (`INVALID_RETIRE_SEQ`, §4.5); the CLI guard above is the friendly first line.

**Dispatch:** add `case 'retire': await cmdRetire(values); break;` to the switch at `src/cli/silo.js:1394-1432` (between `curate` and `regenerate`), and a help block in `printHelp()` (`src/cli/silo.js:1453-1489`) — see §10-help below for the **granularity-gotcha** help text (load-bearing per panel).

**stdout (success):** JSON, mirroring accept/dismiss (`src/cli/silo.js:976`, `:1009`):
```json
{ "retired": true, "slug": "<slug>", "seqs": [<seq>,...], "count": <n>, "retired_seq": <new event seq> }
```

**Exit / error codes.** `cmdRetire` wraps the `retireBullet` call in the same try/catch shape as `cmdSuggest` accept (`src/cli/silo.js:981-988`):
- Arg/shape errors (missing `--slug`/`--seq`, non-integer seq) → `console.error('silo retire: <msg>')`, `process.exit(2)` (usage error, matching `process.exit(2)` at `:962`, `:998`).
- `RetireOpError` (the referential pre-flight failures, plus `INVALID_REASON`; `LOG_INTEGRITY_UNSAFE` only if option (b) of changelog #4 is adopted) → `console.error('silo retire: <CODE> — <message>')`, then `if (err.detail) console.error(JSON.stringify(err.detail, null, 2))`, `process.exit(1)`. **The stderr token format `silo retire: <CODE> —` is load-bearing**: the MCP layer regex-extracts `<CODE>` from it (§4.3), exactly as it does for `silo suggest --accept: ([A-Z_]+) —` at `silo-mcp/server.js:844`.
- Admission-gate refusal (unreachable for a well-formed payload, but possible if e.g. socket misconfig) → the top-level dispatch catch at `src/cli/silo.js:1438-1444` prints `silo retire: ADMISSION_REFUSED:<code> —<details>` and exits 1. MCP extracts via `extractAdmissionCode` (`silo-mcp/server.js:194-199`).

`RetireOpError` codes (ratified — hard errors, append nothing; §9b RESOLVED = hard-error throw):

| Code | Meaning | Checked |
|---|---|---|
| `INVALID_RETIRE_SEQ` | a seq is not a safe positive integer | pre-lock |
| `INVALID_SLUG` | slug fails regex/length (`isValidSlug`, `src/admission/slug.js`) | pre-lock |
| `INVALID_REASON` | `--reason` is blank, multiline, or >120 chars | pre-lock (NEW — folded from Claude MAJOR #3 + ChatGPT MINOR) |
| `EMPTY_SEQ_SET` | no seqs supplied after parse/dedup | pre-lock |
| `LOG_INTEGRITY_UNSAFE` | **v4: ADOPTED as a TAIL-safety gate (changelog #4, option b RESOLVED).** Refuse iff `freshState.last_seq !== freshTail.seq` — i.e. the physical tail the append would chain onto is not the last *folded* entry (broken/malformed tail → the new append would be silently orphaned, §4.5). The v2 "any `hash_chain_break`" form was harmful (false-positives on the 17 historical *middle* breaks); the tail-gate never trips on those. Detail carries `{ last_seq, tail_seq }`. **Manual op only** — not mirrored onto `cmdCurate` (§4.6). | under lock |
| `SEQ_NOT_FOUND` | no CURATED **write_event** at that seq (may be a non-write event) | under lock (reworded — see §9/#9) |
| `SEQ_NOT_ON_TOPIC` | seq exists but its `write_event` slug ≠ `--slug` (detail names the real slug) | under lock |
| `SEQ_NOT_CURATED` | seq exists on topic but its tag ≠ `CURATED` | under lock |
| `SEQ_ALREADY_RETIRED` | seq is already in `freshState.retired_curated_seqs` | under lock |

All-or-nothing: for multi-seq, if **any** seq fails a referential check, the **whole call rejects** with the offending seq(s) in `detail.invalid` (mirroring `dismissSuggestions`'s `DISMISS_INVALID_SEQS`, `suggestion-ops.js:192-196`) and **no event is appended**.

### 4.3 MCP `retire_bullet` tool

Registered in `silo-mcp/server.js` alongside `accept_suggestion` (`:816`) / `dismiss_suggestion` (`:870`), inside `registerTools`.

**Description string (WRITE — states the granularity gotcha + no-un-retire, per panel ruling):**
> "Retire one or more active curated (Layer-2) bullets by seq, on a single topic. WRITE — only use after the user clearly intends to remove those specific facts. **Retires the ENTIRE `write_event` payload at each seq: for import-origin writes that is a whole `## Heading` section, not a single line.** Emits one TOPIC_BULLETS_RETIRED event under the operation-log lock after re-validating that every seq is a currently-active CURATED bullet on the named topic, then regenerates projections. All-or-nothing: any invalid seq aborts the whole call. **There is no un-retire; to restore, re-curate the bullet (write a new CURATED bullet).**"

**Annotation:** `WRITE_SIDE_EFFECT` BUT with **`destructiveHint: true`** (panel ruling, overriding the draft's `false`). The shared `WRITE_SIDE_EFFECT` object (`silo-mcp/server.js:31-36`) has `destructiveHint:false`; `retire_bullet` must pass a tool-local annotation override `{ ...WRITE_SIDE_EFFECT, destructiveHint: true }` (or define a `WRITE_DESTRUCTIVE` constant). **Rationale (ratified):** although the log is append-only and the bullet is recoverable by re-curation (so it is not a true destructive *delete*), the **granularity gotcha means one seq can remove an entire section** — so a generic client should treat it as destructive and confirm. Agent-safety wins over the append-only technicality. (Claude argued `false`; ChatGPT argued `true`; Gemini said document it. → `true` + the explicit "no un-retire; restore by re-curation" in the description.)

**Input schema (zod) — `reason` admission must MATCH the validator, not just `.max(120)`:**
```js
{
  slug: z.string().describe('Topic slug owning the bullet(s)'),
  seqs: z.array(z.number().int().positive()).min(1).max(256)
        .describe('Seq(s) of active CURATED write_events to retire (one topic, all-or-nothing). Retires the WHOLE payload at each seq.'),
  reason: z.string()
        .min(1)
        .max(120)
        .refine((s) => !/[\r\n]/.test(s), { message: 'reason must be a single line' })
        .optional()
        .describe('Why it is being retired (non-blank, single line, ≤120 chars)'),
}
```
(The `.min(1)` + `.refine(no \r\n)` mirror the admission validator's `must_be_nonblank_one_line_string_lte_120_chars`, `payload-validators.js:462-471` — the draft's bare `.max(120)` was looser than the backstop and is corrected per panel.)

**Principal — one server-configured constant for ALL FOUR write tools, NOT a hard-coded literal (panel ruling §9d + R1, round-2 MINOR):** the draft passed `--principal=desktop-claude` literally. The MCP server today hard-codes that literal in **four** write-tool spawn sites — `write_event` (`silo-mcp/server.js:705`), `accept_suggestion` (`:832`), `dismiss_suggestion` (`:884`), and (new) `retire_bullet` — plus the handoff path (`:782`, a `chown`, not a principal). v2 only routed the new constant through `retire_bullet`, which means **the same caller would log retires under one principal and accepts/dismisses/writes under `desktop-claude`** — a split identity (R1). v3 routes **one** constant through all four:
- Introduce `const MCP_PRINCIPAL = process.env.SILO_MCP_PRINCIPAL || 'desktop-claude';` near the constants block (`silo-mcp/server.js:43-57`, alongside `SILO_BASE`/`SILO_DIR`). The default preserves today's behavior exactly; deployments that front Jarvis/Telegram/ChatGPT can override per-instance.
- **Replace the literal `'--principal=desktop-claude'` at ALL FOUR verified sites** — `write_event` (`:705`), `accept_suggestion` (`:832`), `dismiss_suggestion` (`:884`), and the new `retire_bullet` body below — with `` `--principal=${MCP_PRINCIPAL}` ``. (Verified this pass: lines 705/832/884 each currently read `'--principal=desktop-claude'` as a literal string in the spawned-args array; the fourth site is created by this spec.) After this change the constant is the single source of truth and a caller never logs under two principals.
- **Framing — this is the "server-deployment principal," not "caller identity" (round-2 soft-spot ruling, all three seats incl. Gemini).** True per-*caller* derivation is not available from the transport: auth is a single shared bearer token (`SILO_MCP_TOKEN`, `silo-mcp/server.js:921-925`), so there is no per-request identity to derive from. `SILO_MCP_PRINCIPAL` records *which deployment* wrote the event, not *who* did. Per-client tokens → per-client principal is a future enhancement (out of scope here). `source` stays fixed at `'silo-retire'`.

**Body (mirrors accept_suggestion, `silo-mcp/server.js:827-865`):**
```js
const args = [
  SILO_CLI, 'retire',
  `--slug=${slug}`,
  ...seqs.map((s) => `--seq=${String(s)}`),     // repeatable; CLI also accepts comma form
  `--silo-dir=${SILO_DIR}`,
  `--principal=${MCP_PRINCIPAL}`,                // NOT a hard-coded literal (§9d)
];
if (reason) args.push(`--reason=${reason}`);
const r = spawnSync('node', args, { encoding: 'utf-8' });
if (r.status !== 0) {
  const admissionCode = extractAdmissionCode(r.stderr);                 // server.js:195
  const m = (r.stderr || '').match(/silo retire: ([A-Z_]+) —/);         // mirror :844
  const code = admissionCode || (m ? m[1] : 'RETIRE_FAILED');
  // Surface the structured `invalid` detail JSON if present (mirror dismiss, :895-908).
  let detail = null;
  const dm = (r.stderr || '').match(/(\{[\s\S]*\})/);
  if (dm) { try { detail = JSON.parse(dm[1]); } catch { /* ignore */ } }
  const err = errorResult(code, r.stderr || r.stdout || 'retire failed');
  if (detail) { /* attach detail, identical to dismiss_suggestion :902-908 */ }
  return err;
}
const out = JSON.parse(r.stdout);
const regenerated = regenerateAfterWrite();                            // server.js:222
return successResult({ ...out, regenerated });
```

The MCP layer does **not** pass `--to`; it calls `regenerateAfterWrite()` itself after the lock releases, identical to accept/dismiss (`silo-mcp/server.js:849`, `:912`). This avoids holding the append lock across a regen.

### 4.4 Module layout

New file `src/topic-proposal/retire-ops.js` (sibling of `suggestion-ops.js`), exporting:
- `class RetireOpError extends Error` — `{ code, message, detail }`, identical shape to `SuggestionOpError` (`suggestion-ops.js:31-38`).
- `async function retireBullet(writer, { slug, seqs, reason, principal })` → resolves `{ retired:true, slug, seqs, count, retired_seq }` or throws `RetireOpError`.
- `export { DEFAULT_PRINCIPAL, RETIRE_SOURCE };` — **exported for tests** (panel cleanup; mirrors `suggestion-ops.js:224`).

> Naming note: the module lives under `src/topic-proposal/` only because that is where the precedent `suggestion-ops.js` lives and where the `*-ops.js` + `withAppendLock` pattern is established. Retire is not conceptually a "topic proposal," but the directory is cosmetic and does not affect the design. The panel did not require relocating it; left as-is for pattern-consistency.

### 4.5 `retireBullet` reference implementation (the load-bearing logic)

```js
import { v7 as uuidv7 } from 'uuid';
import { isValidSlug } from '../admission/slug.js';

export class RetireOpError extends Error {
  constructor(code, message, detail = null) {
    super(message); this.name = 'RetireOpError'; this.code = code; this.detail = detail;
  }
}
const DEFAULT_PRINCIPAL = 'operator';        // matches suggestion-ops.js:22 + GLOBAL_OPTIONS default
const RETIRE_SOURCE = 'silo-retire';

// Mirror the admission validator's reason rule (payload-validators.js:462-471)
// so we reject pre-lock with a friendly code instead of letting the backstop fire.
function validateReason(reason) {
  if (reason === undefined) return;
  if (typeof reason !== 'string' || reason.trim().length < 1
      || reason.length > 120 || /[\r\n]/.test(reason)) {
    throw new RetireOpError('INVALID_REASON',
      'reason must be a non-blank single-line string ≤120 chars');
  }
}

export async function retireBullet(writer, input) {
  const { slug, reason } = input;

  // ── Cheap, pre-lock shape validation (no lock taken for a doomed request) ──
  const rawSeqs = Array.isArray(input.seqs) ? input.seqs : [input.seqs];
  for (const s of rawSeqs) {
    if (!Number.isSafeInteger(s) || s < 1) {
      throw new RetireOpError('INVALID_RETIRE_SEQ',
        'every seq must be a safe positive integer', { value: s });
    }
  }
  // Dedup + sort ascending — same as cmdCurate (silo.js:784-786) and
  // dismissSuggestions (suggestion-ops.js:176). The admission validator
  // hard-rejects non-ascending / duplicate-violating arrays.
  const seqs = [...new Set(rawSeqs)].sort((a, b) => a - b);
  if (seqs.length === 0) {
    throw new RetireOpError('EMPTY_SEQ_SET', 'no seqs supplied');
  }
  if (!isValidSlug(slug)) {
    throw new RetireOpError('INVALID_SLUG', `slug "${slug}" fails regex/length validation`);
  }
  validateReason(reason);
  const principal = input.principal ?? DEFAULT_PRINCIPAL;

  let result;
  await writer.withAppendLock(async ({ writer: w, freshTail, freshState }) => {
    // ── (v4, changelog #4 RESOLVED — option b) TAIL-SAFETY GATE. ──
    // _scanTailUnlocked (src/log/append.js:109-156) is hash-chain-BLIND: it
    // returns the last syntactically-valid line as the tail (seq + canonicalHash)
    // WITHOUT verifying its hash_prev. _appendBatchUnlocked then chains our new
    // event onto THAT physical tail (append.js:307, hashPrev = tail.hash). So if
    // the physical tail is itself broken/malformed — its hash_prev ≠ the last
    // ACCEPTED entry's hash, OR its shape fails validateEntryShape — interpret()
    // SKIPS it (interpret/index.js:48-71; does NOT advance prevHash) and will
    // ALSO skip our new append (which chains onto the skipped tail): the retire is
    // silently ORPHANED while the CLI returns {retired:true}. Refuse in that case.
    //
    // The predicate: freshState.last_seq is the seq of the last FOLDED (accepted)
    // entry (interpret/index.js:86; default 0, state.js:50). freshTail.seq is the
    // seq of the physical tail _scanTailUnlocked found (append.js:144-148; surfaced
    // by withAppendLock at append.js:221/:226). They are EQUAL iff the physical tail
    // was accepted by interpret — i.e. the entry our append will chain onto is sound.
    // They DIFFER iff the tail is broken/malformed (the orphaning condition).
    //
    // This is a STRICT SUPERSET of a hash_chain_break-only check: it also catches a
    // shape-malformed tail (malformed_entry_shape, interpret/index.js:48-58). And it
    // does NOT trip on the production log's 17 HISTORICAL middle breaks — those are
    // skipped + re-synced, the physical tail is a normally-folded entry, so
    // last_seq === freshTail.seq (exactly why nightly cmdCurate retires across them).
    // On an empty/genesis log both are 0 → allowed (the referential pre-flight then
    // cleanly rejects "nothing to retire").
    //
    // WHY seq-compare, not hash-compare: the logically-equivalent
    // `freshState.tail_hash !== freshTail.hash` form is a TRAP — state.tail_hash inits
    // to null (state.js:51) while freshTail.hash is GENESIS_HASH on an empty log
    // (append.js:116), so the hash form would FALSE-POSITIVE (brick retire) on a genesis
    // log; the integer form degrades cleanly to 0 === 0. (It is also more fragile:
    // interpret reassigns entry.is_state_bearing in place before hashing the tail —
    // index.js:80 then :87 — benign today but a latent footgun for any hash-equality
    // gate.) Do NOT "tidy" this predicate into a hash comparison.
    //
    // NOTE this replaces v3's *sketched* option (b), which was buggy: it read
    // `freshState.tail?.seq` (interpret state has NO `.tail` field) and fell back to
    // `last_seq`, then scanned `skipped` for a hash_chain_break AT that seq — but the
    // broken tail has a DIFFERENT (higher) seq, so the check never fired. The
    // last_seq-vs-freshTail.seq form is correct and needs no `skipped` scan.
    //
    // Manual-op ONLY. cmdCurate's §B1 emitter stays UNGATED (§4.6) — the reviewer-
    // blessed scoping (the v3 spec Gemini-Pro adopted option b on stated exactly this).
    if (freshState.last_seq !== freshTail.seq) {
      throw new RetireOpError('LOG_INTEGRITY_UNSAFE',
        `operation-log TAIL is unsafe (last folded seq ${freshState.last_seq} `
        + `!= physical tail seq ${freshTail.seq}); a new append would chain onto a `
        + 'broken/unfolded tail and be silently orphaned — recover the log first',
        { last_seq: freshState.last_seq, tail_seq: freshTail.seq });
    }

    // ── 1. Reconstruct the ACTIVE-CURATED set EXACTLY as interpret()'s
    //       TOPIC_BULLETS_RETIRED handler does (interpret/index.js:264-267):
    //       curated seqs in topic_content MINUS already-retired seqs. ──
    const history = freshState.topic_content.get(slug) || [];
    const bySeq = new Map(history.map((h) => [h.seq, h]));

    // ── 2. All-or-nothing referential pre-flight (collect every offender) ──
    const invalid = [];
    for (const seq of seqs) {
      const rec = bySeq.get(seq);
      if (!rec) {
        // seq absent from this topic's write_event history. Could be a wrong
        // slug or a non-write/non-existent seq. Disambiguate via seq_to_event,
        // which ONLY indexes write_events (interpret/index.js:416-423).
        const ev = freshState.seq_to_event.get(seq);
        if (!ev) {
          invalid.push({ seq, code: 'SEQ_NOT_FOUND',
            reason: `no CURATED write_event at seq ${seq} (may be a non-write event)` });
        } else {
          invalid.push({ seq, code: 'SEQ_NOT_ON_TOPIC',
            reason: `seq ${seq} belongs to slug "${ev.slug}", not "${slug}"`,
            found_slug: ev.slug });
        }
        continue;
      }
      if (rec.tag !== 'CURATED') {
        invalid.push({ seq, code: 'SEQ_NOT_CURATED',
          reason: `seq ${seq} on "${slug}" is tag=${rec.tag ?? 'null'}, not CURATED`,
          tag: rec.tag ?? null });
        continue;
      }
      if (freshState.retired_curated_seqs.has(seq)) {
        invalid.push({ seq, code: 'SEQ_ALREADY_RETIRED',
          reason: `seq ${seq} is already retired` });
      }
    }
    if (invalid.length > 0) {
      // For a single-seq call, surface that seq's specific code (ergonomic +
      // back-compatible with the per-code tests). For multi-seq, use a batch
      // code with the offenders in detail (mirrors dismiss, suggestion-ops.js:192-196).
      if (seqs.length === 1) {
        const only = invalid[0];
        throw new RetireOpError(only.code, only.reason, only);
      }
      throw new RetireOpError('RETIRE_INVALID_SEQS',
        `${invalid.length} of ${seqs.length} seqs are not active CURATED bullets on "${slug}"`,
        { invalid });
    }

    // ── 3. Commit ONE event under the same lock (no re-entrancy) ──
    const payload = { topic: slug, superseded_seqs: seqs, source: RETIRE_SOURCE };
    if (reason) payload.reason = reason;
    const [appended] = await w._appendBatchUnlocked([{
      type: 'TOPIC_BULLETS_RETIRED',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,            // standardized bare form (§4.1)
      principal,
      payload,
    }]);
    result = { retired: true, slug, seqs, count: seqs.length, retired_seq: appended.seq };
  });
  return result;
}

export { DEFAULT_PRINCIPAL, RETIRE_SOURCE };
```

**Why `topic_content` is the correct source.** `interpret()` populates `topic_content` only inside the `write_event` case (`interpret/index.js:402-410`), storing `{ seq, tag, content, principal, ts }` per write. The retire fold (`interpret/index.js:264-267`) builds its `validSeqs` set from *exactly* `topic_content.get(topic).filter(h => h.tag === 'CURATED')`. By reading the same structure, the pre-flight's notion of "active CURATED" is **identical to** what `interpret` will use when it folds our emitted event — eliminating any pre-flight-vs-fold disagreement. The `seq_to_event` index (`interpret/index.js:416-423`) — which is populated **only** in the `write_event` apply path, hence only ever holds write_events — is used solely to produce a *better error message* (which wrong slug the seq belongs to, or that it's not a write at all). This is why `SEQ_NOT_FOUND`'s wording is "no CURATED **write_event** at seq N (may be a non-write event)" rather than "no event at seq N" (§9/#9): a seq pointing at, e.g., a `TOPIC_METADATA_SET` is genuinely absent from `seq_to_event`.

### 4.6 §B1 — harden `cmdCurate`'s retire emission (the ratified resolution of the one open decision)

**This is the single change to already-shipped code.** It lives in the curate COMMAND (`cmdCurate`, `src/cli/silo.js:559`), NOT the sealed log/canonical/interpret/matrix core.

**The hole (verified, §0 #2).** `cmdCurate` computes `state = await interpret(writer)` at `src/cli/silo.js:569` — pre-lock. Its active list `curatedEventList` (`:651-653`) and the resolved `supersededSeqs` (`:784-786`) are therefore computed from a **pre-lock** snapshot. It then appends the retire event at `:808-814` via `writer.append(...)`, which takes the lock **only around the append** and does **no re-read of `retired_curated_seqs` under that lock**. Adding manual `silo retire` creates the race partner: a manual retire of S1 landing between curate's interpret and curate's append makes curate emit `TOPIC_BULLETS_RETIRED(S1)` anyway — a no-op that pollutes the log. Today this is untriggerable (no manual retire exists; two curates can't run concurrently). Retire activates it.

**The fix.** Replace `cmdCurate`'s direct `writer.append` of the retire event (`src/cli/silo.js:808-814`) with a `withAppendLock` block that **re-filters `supersededSeqs` against a LOCK-SCOPED fresh active-CURATED set** and drops any seq already in `freshState.retired_curated_seqs` (and any seq no longer an active CURATED write on the topic — defensive, same predicate as the manual op). If the filtered set is empty, **append nothing**. Reference patch:

```js
// ── BEFORE (src/cli/silo.js:801-816) ──
let retired = 0;
if (supersededSeqs.length > 0) {
  const retirePayload = { topic: targetSlug, superseded_seqs: supersededSeqs, source: 'silo-curate' };
  if (retireReason) retirePayload.reason = retireReason;
  await writer.append({ type: 'TOPIC_BULLETS_RETIRED', isStateBearing: true,
    intentId: `intent:${uuidv7()}`, principal: principal || 'curator', payload: retirePayload });
  retired = supersededSeqs.length;
}

// ── AFTER (B1 — lock-scoped revalidation; mirrors retireBullet §4.5) ──
let retired = 0;
let actuallyRetiredSeqs = [];                 // R2-Retire-2: carried OUT of the lock for the summary
if (supersededSeqs.length > 0) {
  await writer.withAppendLock(async ({ writer: w, freshState }) => {
    // Re-derive the active-CURATED set for THIS topic under the lock — the
    // pre-lock `state` may be stale if a manual `silo retire` raced us.
    const hist = freshState.topic_content.get(targetSlug) || [];
    const activeCurated = new Set(
      hist.filter((h) => h.tag === 'CURATED' && !freshState.retired_curated_seqs.has(h.seq))
          .map((h) => h.seq),
    );
    // Keep only seqs still active-CURATED now; drop already-retired / vanished.
    const stillValid = supersededSeqs.filter((s) => activeCurated.has(s));
    if (stillValid.length === 0) return; // nothing left to retire — append NOTHING
    const retirePayload = { topic: targetSlug, superseded_seqs: stillValid, source: 'silo-curate' };
    if (retireReason) retirePayload.reason = retireReason;
    await w._appendBatchUnlocked([{
      type: 'TOPIC_BULLETS_RETIRED', isStateBearing: true,
      intentId: `intent:${uuidv7()}`, principal: principal || 'curator', payload: retirePayload,
    }]);
    retired = stillValid.length;
    actuallyRetiredSeqs = stillValid;        // what was REALLY written, post-filter
  });
}
```

**R2-Retire-2 (round-2 MINOR) — the summary must report the post-filter set, not `supersededSeqs`.** The existing summary path reports the **pre-filter** seqs: `src/cli/silo.js:868` reads `retired_seqs: supersededSeqs`. If a manual `silo retire` wins the race and B1 filters a seq out, the log is now correct (it appends only `stillValid`) but the summary would still claim curate retired the pre-filter set — a false report. v2 fixed `retired` (the count) but left `retired_seqs` stale. Fix: change the summary line to report `actuallyRetiredSeqs`:

```js
// ── src/cli/silo.js:862-872 summary.curated.push — change ONE field ──
summary.curated.push({
  slug: targetSlug,
  recent_events: recentEvents.length,
  bullets_proposed: bullets.length,
  bullets_written: written,
  bullets_retired: retired,                 // already post-filter (= stillValid.length)
  retired_seqs: actuallyRetiredSeqs,        // R2-Retire-2: was `supersededSeqs` (pre-filter) — now the seqs actually written
  retire_reason: retireReason,
  verified,
  tokens_used: response?.usage?.total_tokens ?? null,
});
```
On the common (no-race) path `actuallyRetiredSeqs === supersededSeqs` byte-for-byte, so this is a no-op there; it only diverges in the exact race B1 was added to handle, where it makes the summary match the log. (If `supersededSeqs.length > 0` but the filter dropped everything, `actuallyRetiredSeqs` is `[]` and `retired` is `0` — summary and log agree that curate retired nothing.)

**Properties.**
- `supersededSeqs` is already sorted+deduped (`:784-786`); `.filter` preserves ascending order, so the validator's `must_be_strictly_ascending` still holds.
- Uses `_appendBatchUnlocked` **inside** the lock (NOT `writer.append`, which would re-enter `_locked()` and deadlock — `src/log/append.js:210-212`).
- Now the invariant **"never append a no-op `TOPIC_BULLETS_RETIRED`"** holds for **both** emitters (manual `retireBullet` §4.5 AND nightly `cmdCurate`). This makes §5.4's concurrency claim **actually TRUE** (it was aspirational in the draft).
- **NO integrity gate is added here (changelog #4, manual-op-only resolution).** B1 does **not** add the tail-safety gate to `cmdCurate`. The v2 "any `hash_chain_break`" gate was harmful (it would brick the nightly curate against the production log's 17 historical middle breaks — the very path that runs nightly and *proves* the broad gate wrong), so it is gone from both emitters. v4 then adds a **narrow tail-safety gate** (`freshState.last_seq !== freshTail.seq`, §4.5) to the **manual op only**; `cmdCurate` stays ungated — the reviewer-blessed scoping (the v3 spec Gemini-Pro adopted option (b) on stated the gate would be manual-op-only). **Rationale for the asymmetry:** the tail-gate exists to stop an **interactive** caller being told `{retired:true}` when the append was silently orphaned onto a broken tail; the nightly `cmdCurate` is an idempotent, self-healing batch (it re-judges and re-emits every night, so an orphaned retire re-resolves on its own once the tail is repaired) whose role is to keep running. **NB — unlike the old broad guard, the tail-gate would NOT brick `cmdCurate` against historical breaks** (it never trips on those, only on a genuinely unsafe *tail*). So mirroring it onto `cmdCurate` is a *sound optional follow-up* (it would make the nightly batch fail loudly on a broken tail instead of silently orphaning a retire) — deliberately left out of this ratified scope rather than ruled out; see §12 / the maintainer note. Round-2 R2 (the asymmetry finding) is thereby resolved: the asymmetry is intentional and rationalized, not an oversight.
- Cost: ~12 lines, one extra `interpret()` under the lock per curate run that retires anything. The bullet-writes loop (`:818-844`) and the `TOPIC_CURATED` marker (`:847-859`) keep their existing `writer.append` calls — they are not part of the no-op-retire invariant and are out of scope for B1. (A future pass could batch all of curate's emits under one lock; not required here.)
- **`written`/`bullets_added`/`retired_seqs` accounting:** `retired` now reflects `stillValid.length` (post-filter), which correctly feeds `summary.curated[].bullets_retired` (`:867`) and the `TOPIC_CURATED` payload's `bullets_retired` (`:857`). **R2-Retire-2:** `summary.curated[].retired_seqs` (`:868`) is changed from the pre-filter `supersededSeqs` to the post-filter `actuallyRetiredSeqs`, so the summary's *seq list* matches the log (not just its count). If the filter drops everything AND no bullets were written, the `TOPIC_CURATED` marker (`:847` guard `written > 0 || retired > 0`) correctly does not fire.

**Test:** dedicated B1 test (§8 #16) — seed a CURATED bullet, simulate the race by retiring it via `retireBullet` first, then drive `cmdCurate`'s retire path with that seq in `supersededSeqs`, and assert **no second `TOPIC_BULLETS_RETIRED(seq)` is appended** (tail unchanged by the retire branch). Because `cmdCurate` is LLM-driven, the test exercises the extracted filter predicate directly (or a thin seam) rather than a live LLM call.

---

## 5. Concurrency, ordering, idempotency, recoverability

### 5.1 The central risk — a no-op event that pollutes the log forever
`interpret()`'s TOPIC_BULLETS_RETIRED handler **does not reject** a bad seq; it pushes a `state.skipped` record and continues (`interpret/index.js:280-289`). So if an emitter appended *without* lock-scoped revalidation, a request for a non-existent / non-CURATED / wrong-slug / already-retired seq would still produce a **structurally valid `TOPIC_BULLETS_RETIRED` event** that passes admission (`matrix.yaml:148`) and payload validation (`payload-validators.js:393` — which checks shape + `maxKnownSeq`, **not** "is this an active CURATED bullet"; confirmed by the module docstring at `payload-validators.js:21-23`). That event is then **permanent** in the append-only log, folds to a no-op, and is pure noise forever. **The pre-flight reject (§4.5) prevents this for the manual op, and the §B1 patch (§4.6) prevents it for the nightly emitter.** This is the single most important property of the design, and it is now true for **both** emitters.

### 5.2 TOCTOU — the active-CURATED set MUST come from lock-scoped freshState
The pre-flight check and the append MUST be atomic with respect to other writers. `withAppendLock` (`src/log/append.js:217-232`) acquires the in-process mutex + flock, **re-scans the tail** (`:221`), and **recomputes `freshState = await interpret(this)`** (`:222`) *inside* the lock before invoking the callback with `{ writer, freshTail, freshState }`. `retireBullet` reads `freshState.topic_content` / `.retired_curated_seqs` / `.seq_to_event` / `.skipped` from *that* snapshot and appends via `_appendBatchUnlocked` *within the same callback* — so no concurrent curate/retire can change the active-CURATED set between the check and the commit.

**Anti-pattern explicitly forbidden:** computing the active-CURATED set from a pre-lock `await interpret(writer)` and then entering the lock to append. That reintroduces the TOCTOU window — and was exactly the latent bug in the *shipped* `cmdCurate` that §B1 fixes. The reference impl reads state **only** from the `freshState` handed to the lock callback. Do not call `writer.append()` inside the callback either — that re-enters `_locked()` and deadlocks (`src/log/append.js:210-212` docstring); use `_appendBatchUnlocked`.

### 5.3 maxKnownSeq under the lock
`_appendBatchUnlocked` freezes `maxKnownSeq = tail.seq` for the batch (`src/log/append.js:297-305`). Every `seq` references an *already-committed* prior entry (each is an existing CURATED write), so `seq <= tail.seq` always holds; the `future_or_unknown_seq` check (`payload-validators.js:443-451`) can never trip for a well-formed retire. Good.

### 5.4 Ordering vs the nightly curate loop — NOW ACTUALLY TRUE (post-§B1)
Both `cmdCurate` (post-§B1) and `retireBullet` serialize on the same flock/mutex **and both revalidate `retired_curated_seqs` under that lock**. If a manual retire and a nightly curate race on the same seq, whoever takes the lock first wins; the loser's freshState shows the seq already in `retired_curated_seqs` and the loser either rejects with `SEQ_ALREADY_RETIRED` (manual) **or filters it out and appends nothing for it** (curate, §4.6). **No double-retire / no-op-retire event is produced by either path.** (Pre-ratification, the draft *claimed* this but `cmdCurate` did not implement it — see §0 #2. §B1 makes the claim real.) Belt-and-suspenders: even if a duplicate retire *did* land, re-adding to `state.retired_curated_seqs` is a `Set.add` — naturally idempotent at fold time (`interpret/index.js:290`).

### 5.5 Idempotency
- **Re-running the exact same `retire` after it succeeded** → the second call's freshState shows the seq already retired → `SEQ_ALREADY_RETIRED`, **no second event**. (Contrast: without pre-flight, you'd append a redundant-but-valid second retire event each time. Pre-flight makes the *operation* idempotent, not just the projection.)
- A duplicate `intentId` is **not** relied upon for idempotency (we mint a fresh `uuidv7` per call — hence the bare `intent:${uuidv7()}` form, §4.1); the freshState check is the idempotency guarantee.

### 5.6 Recoverability — no UNRETIRE, by design
There is deliberately **no** un-retire primitive. Recovery from an erroneous retire is **re-curation**: append a *new* CURATED `write_event` with the same (or corrected) content. This works because:
- `buildLayer2` includes any CURATED write whose seq is **not** in `retired_curated_seqs` (`regenerate-topic-file.js:149-160`). A *new* write gets a *new* seq, which was never retired, so it appears.
- `cmdCurate`'s own dedup is explicitly written to **allow** reintroducing a bullet retired by a prior run (`src/cli/silo.js:820-829`, comment "(c) ALLOWS reintroducing a bullet retired by a prior curate run, so retire is recoverable without an UNRETIRE primitive"). The manual path inherits the same recoverability story.

The audit trail shows: `TOPIC_BULLETS_RETIRED(seq=N)` … later … `write_event(CURATED, seq=M, content=...)` — i.e. "we removed it, then we put it back," which is more honest than a mutating un-retire. The MCP `destructiveHint:true` (§4.3) signals to clients that a confirm is warranted *and* that recovery is by re-curation, not undo.

---

## 6. Interaction with existing subsystems (each claim cited, re-verified this pass)

| Subsystem | File:line | Behavior the design relies on |
|---|---|---|
| **Event type exists** | `src/cli/silo.js:808-814` | `TOPIC_BULLETS_RETIRED` is already emitted by `cmdCurate`; we emit the same type with `source:'silo-retire'`. |
| **Curate sorts ascending** | `src/cli/silo.js:783-786` | `[...new Set(...)].sort((a,b)=>a-b)` "for canonical hash stability." Retire replicates exactly (single- and multi-seq). |
| **Import emits CURATED sections** | `src/import-jarvis/index.js:266-286` | Layer-2 `## Heading` sections → `write_event{ tag:'CURATED', content:'## heading\n\n…', imported.field:'curated' }`. **Confirms retire can touch imported blobs; one section = one event (granularity gotcha).** |
| **Validator allows multi-line CURATED** | `src/admission/payload-validators.js:518-523` | CURATED is exempt from the single-line rule precisely because import emits whole sections — corroborates the granularity model. |
| **Admission matrix** | `src/matrix/matrix.yaml:144-152` | `TOPIC_BULLETS_RETIRED` is `standard: Y` — admissible on the default socket; **no admin socket needed**. `is_state_bearing: true`, `family: topic`. |
| **Matrix gate runs first** | `src/log/append.js:280-295` | `_appendBatchUnlocked` calls `MATRIX.isAdmissible(type,'standard','normal')` (`:291`) before payload validation (`:302`). Default socket passes. |
| **Payload validator** | `src/admission/payload-validators.js:393-477` | Enforces: object shape, allowed-field set `{topic,superseded_seqs,reason,source}` (`:412`), non-blank `topic` (`:420`), array len 1..256 (`:430`, `MAX_SUPERSEDED_SEQS=256` at `:39`), strictly-ascending safe-positive-ints (`:438-459`), each `<= maxKnownSeq` (`:443`), `reason` non-blank/one-line/≤120 (`:462-471`), `source` is-string (`:474`). **Does NOT check active/CURATED** (docstring `:21-23`). |
| **interpret fold** | `src/interpret/index.js:235-293` | Adds each seq to `state.retired_curated_seqs` **only if** it references a CURATED write_event on THAT topic (`:264-290`); otherwise pushes `state.skipped` and continues (silent, observable, **not** rejecting). This is *why* pre-flight is mandatory (§5.1). `Set.add` at `:290` → fold-idempotent. |
| **interpret state shape** | `src/interpret/index.js:264-267, 402-410, 416-423` | `topic_content.get(slug)` → `[{seq,tag,content,principal,ts}]` (write_events only, pushed at `:402-410`); `retired_curated_seqs` is a `Set`; `seq_to_event` (set at `:416-423`, **write_events only**) is the cross-slug index. The pre-flight reads exactly these. |
| **interpret records chain breaks + advances `last_seq` only on accept** | `src/interpret/index.js:48-71, 86` | A `hash_prev` mismatch (`:60-71`) **or** a shape failure (`:48-58`) lands `{seq, reason:'hash_chain_break'|'malformed_entry_shape', …}` in `state.skipped`, the entry is NOT folded, and `prevHash`/`last_seq` are NOT advanced; interpret re-syncs to the last valid entry. **v4 tail-gate (changelog #4):** because `last_seq` (`:86`) advances *only* on an accepted entry, `last_seq === freshTail.seq` **iff** the physical tail was folded — so the manual-op gate (§4.5) needs no `skipped` scan and is blind to historical *middle* breaks (the tail stays folded across them, which is why nightly `cmdCurate` retires across the 17 April breaks). |
| **chain-break filter precedent** | `src/cli/silo.js:1155, 1281-1283` | `state.skipped.filter(s => s.reason === 'hash_chain_break')` is the established pattern (`silo doctor`, `silo regenerate --strict`) — diagnostics/strict-mode, not a write-time append gate. v4 does **not** reuse it as a retire pre-condition; the tail-gate compares `freshState.last_seq` to `freshTail.seq` (§4.5) instead, which also catches a shape-malformed tail a `hash_chain_break`-only filter would miss. |
| **buildLayer2** | `src/projection/regenerate-topic-file.js:138-163` | Includes a write only if `type==='write_event'` AND `tag==='CURATED'` AND `!retiredSeqs.has(seq)` AND not an event-log-origin import (`imp && imp.field !== 'curated'` excluded, `:154-158`). `retiredSeqs` is a **required** Set arg (throws otherwise, `:144-148`). Imported topic-file sections (`field==='curated'`) ARE included → retirable. Honors our retire automatically. |
| **Nightly emitter (now hardened)** | `src/cli/silo.js:559, 801-816, 868` | `cmdCurate` keeps `source:'silo-curate'`; §B1 wraps its retire emit in `withAppendLock` + lock-scoped filter. **R2-Retire-2 (v3):** its `summary.curated[].retired_seqs` (`:868`) is changed from the pre-filter `supersededSeqs` to the post-filter `actuallyRetiredSeqs` so the summary's seq list matches the log under a race. |
| **withAppendLock** | `src/log/append.js:217-232` | Provides flock + mutex + fresh-tail (`:221`) + `freshState=interpret()` (`:222`) inside the lock, callback gets `{writer,freshTail,freshState}`. The atomicity substrate (§5.2). |
| **\_appendBatchUnlocked / re-entrancy** | `src/log/append.js:210-212, 257-321` | `withAppendLock` callbacks MUST use `_appendBatchUnlocked` (not `writer.append`, which re-enters `_locked()` and deadlocks). Matrix gate `:280-295`, frozen `maxKnownSeq=tail.seq` `:297-305`. |
| **CLI error→token convention** | `src/cli/silo.js:1438-1444, 981-988` | Top-level catch prints `ADMISSION_REFUSED:<code>` for `AdmissionError`; `RetireOpError` follows the `suggest`-style `<CODE> — <message>` convention (`:983`). MCP parses both (`silo-mcp/server.js:194-199, :844`). |
| **GLOBAL_OPTIONS principal default** | `src/cli/silo.js:77-80` | `principal` default is `process.env.SILO_PRINCIPAL || 'operator'` — so the CLI default for `--principal` is already `'operator'` (§9d). (Note: `printHelp` text at `:1476` says "default: helder" — stale doc string, flagged §12.) |
| **MCP CLI-shell pattern** | `silo-mcp/server.js:816-915` (`accept`/`dismiss`), `:222-233` (`regenerateAfterWrite`) | Tool spawns `node silo …`, parses stdout JSON, regenerates after lock release, extracts error codes off stderr. `retire_bullet` copies this verbatim. |
| **MCP hard-codes principal today (all 4 sites)** | `silo-mcp/server.js:705, 832, 884` (+ new retire) | `--principal=desktop-claude` is a literal in `write_event` (`:705`), `accept_suggestion` (`:832`), `dismiss_suggestion` (`:884`) — **verified this pass**. **R1 (v3):** §4.3 introduces one `SILO_MCP_PRINCIPAL` constant (default `desktop-claude`) and routes it through **all four** write tools (not just `retire_bullet`, as v2 did), so a single caller never logs under two principals. |
| **MCP auth = single bearer token** | `silo-mcp/server.js:921-925` | `SILO_MCP_TOKEN` is one shared secret — no per-caller identity, so server-configured (not client-derived) principal is the realistic mechanism (§4.3). |

---

## 7. Failure modes & edge cases

| # | Scenario | Pre-flight result | Event appended? | Projection effect |
|---|---|---|---|---|
| 1 | seq is a number with no CURATED **write_event** (e.g. points at a `TOPIC_METADATA_SET`, or nonexistent) | `SEQ_NOT_FOUND` ("no CURATED write_event at seq N (may be a non-write event)") | No | none |
| 2 | seq is valid & active CURATED on the slug | success | **Yes** (1 event) | bullet (or whole import section) disappears from Layer 2 |
| 3 | seq already retired (re-run) | `SEQ_ALREADY_RETIRED` | No | unchanged (idempotent op, §5.5) |
| 4 | seq is a write_event but tag≠CURATED (e.g. FACT/SOURCE) | `SEQ_NOT_CURATED` | No | none (the pre-flight rejects so the log stays clean — see §5.1; do NOT rely on interpret's silent-skip, which is the backstop, not the guard) |
| 5 | seq exists but on a **different** slug than `--slug` | `SEQ_NOT_ON_TOPIC` (detail names the real slug) | No | none |
| 6 | `--slug` valid, `--seq` valid CURATED, but on slug X while user typed slug Y | same as #5 | No | none |
| 7 | Retiring the **last** active bullet on a topic | success | Yes | Layer 2 becomes empty; `buildLayer2` returns `''` (`regenerate-topic-file.js:161-162`), mechanical curated_lines → 0 (`:188`). Allowed — empty curated section is a valid state. |
| 8 | DECISION/event-log seq that `buildLayer2` ignores entirely | `SEQ_NOT_CURATED` (tag≠CURATED) | No | none — DECISION lives in the event log, not Layer 2; retire is the wrong tool (§9c: out of scope). |
| 9 | Concurrent manual retire + nightly curate on same seq | loser: manual→`SEQ_ALREADY_RETIRED`; curate→filtered out (§B1) | winner: Yes; loser: No | single retire (§5.4, now actually enforced) |
| 10 | `--reason` blank / >120 chars / multiline | `INVALID_REASON` pre-lock → exit 1; validator backstop (`payload-validators.js:462-471`) | No | none |
| 11 | `--slug` fails regex/length | `INVALID_SLUG` → exit 1 | No | none |
| 12 | `--seq` not a positive integer / missing | usage error → exit 2 | No | none |
| 13 | seq references the very entry being written | impossible — every seq is pre-existing; `maxKnownSeq` guard (`payload-validators.js:443`) is backstop | No | n/a |
| 14 | Multi-seq array (parsed) — op sorts+dedups before emit | n/a (handled in op, §4.5) | Yes if all valid | else validator `must_be_strictly_ascending` (`:452`) would be the backstop, but op guarantees sorted |
| 15 | Retiring a CURATED bullet that is an **import-origin `## Heading` block** (one event = one section, `import-jarvis/index.js:269-271`; `payload-validators.js:518-522`) | success retires the **whole `write_event`** | Yes | the **entire section** authored by that write disappears — **caller beware: granularity is the write, not the rendered line.** Stated in CLI `--help` + MCP description (§4.3, §10-help). |
| 16 | Multi-seq where some seqs valid, some not | `RETIRE_INVALID_SEQS` (all-or-nothing), offenders in `detail.invalid` | No (nothing for any seq) | none — atomic batch, like `dismissSuggestions` (`suggestion-ops.js:192-196`) |
| 17 | Operation log has **historical** `hash_chain_break`(s) in the *middle* (e.g. production's 17 April breaks); the physical tail is a normally-folded entry | **NOT an error — append proceeds** (changelog #4, option b). The tail-gate passes because `freshState.last_seq === freshTail.seq` (the tail is folded; middle breaks are skipped + re-synced). `cmdCurate` proves this nightly. | Yes (if seqs valid) | bullet(s) retired normally; historical breaks unaffected |
| 17b | The **physical tail itself** is broken/malformed (a `hash_chain_break` or shape failure at the last syntactically-valid line `_scanTailUnlocked` returns) | `LOG_INTEGRITY_UNSAFE` — the tail-gate trips (`freshState.last_seq !== freshTail.seq`, §4.5); detail carries `{last_seq, tail_seq}` | No | none — refuses **loudly** instead of silently orphaning the append onto a broken tail; operator must recover the log first. (Manual op only; `cmdCurate` stays ungated, §4.6.) |
| 18 | **Flock degraded** (e.g. Windows dev box, `fs-ext` flock unavailable) | pre-flight still runs against in-process freshState | Yes (if valid) | correct **single-process**; cross-process atomicity weakens to single-process. **Production single-VPS is fork-based → one flock domain → safe** (§5.2, panel ruling). Documented caveat, not a code change. |
| 19 | `--to` passed → auto-regenerate (CLI path); MCP always regenerates after via `regenerateAfterWrite` | n/a | Yes (if valid) | topic file rewritten (§9e) |

**Flock-degraded caveat (expanded, panel-required).** Cross-process atomicity of the pre-flight↔append window depends on a working `flock` (via `fs-ext`, acquired in `withAppendLock` at `src/log/append.js:219`). On platforms where `flock` is a no-op or `fs-ext` is absent (typically Windows dev machines), the in-process mutex still serializes same-process writers, but two **separate** `node` processes could interleave. In that degraded mode the no-op-retire invariant holds only **within a single process**. **This does not affect production:** the VPS runs one Silo install on Linux where `flock` works, and the MCP server spawns the CLI as child processes that all contend on the same advisory lock file — one flock domain. Concurrency safety is a production property; the dev-box weakening is expected and acceptable for local testing.

---

## 8. Test plan (`test/retire-ops.test.js`, mirroring `test/suggestion-ops.test.js`)

Use the same harness shape (`test/suggestion-ops.test.js:23-58`): `freshSilo()` (`fs.mkdtemp` + `LogWriter.init`), a `seedCurated(writer, {slug, bullets})` helper that appends N `write_event{tag:'CURATED', content:'- '+b}` and returns their seqs, then assert via `interpret(writer)` and/or `buildLayer2`. Import `{ retireBullet, RetireOpError, DEFAULT_PRINCIPAL, RETIRE_SOURCE }` from `../src/topic-proposal/retire-ops.js`.

1. **happy path (single)** — seed 2 CURATED bullets on `pets`; `retireBullet(writer,{slug:'pets',seqs:[S1]})` → `{retired:true, count:1, retired_seq>S2}`; `interpret().retired_curated_seqs.has(S1)`; `buildLayer2` no longer contains bullet 1, still contains bullet 2.
2. **emits exactly one event** — tail seq increases by exactly 1; the new entry `.type==='TOPIC_BULLETS_RETIRED'`, `.payload.superseded_seqs` deep-equals `[S1]`, `.payload.source==='silo-retire'`, `.payload.source===RETIRE_SOURCE`.
3. **reason carried + omitted** — with `reason:'wrong fact'` → emitted payload has `reason:'wrong fact'`; omitted reason → payload has **no** `reason` key (`assert('reason' in payload === false)`).
4. **multi-seq happy path** — seed 3 CURATED bullets; `retireBullet({slug:'pets',seqs:[S3,S1]})` → one event, `superseded_seqs` deep-equals `[S1,S3]` (**sorted+deduped**), `count:2`; both gone from `buildLayer2`, S2 remains.
5. **multi-seq dedup** — `seqs:[S1,S1,S2]` → `superseded_seqs` deep-equals `[S1,S2]`; one event; `count:2`.
6. **SEQ_NOT_FOUND** — `retireBullet({slug:'pets',seqs:[99999]})` rejects `RetireOpError` code `SEQ_NOT_FOUND`, message contains "write_event"; tail seq unchanged.
7. **SEQ_NOT_FOUND vs non-write seq** — retire the seq of a `TOPIC_METADATA_SET` (seed via accept or a metadata write) with a CURATED slug → `SEQ_NOT_FOUND` (it's absent from `seq_to_event`), proving the reworded wording is accurate.
8. **SEQ_NOT_ON_TOPIC** — seed CURATED on `pets` and on `work`; retire a `work` seq with `--slug pets` → `SEQ_NOT_ON_TOPIC`, detail `found_slug:'work'`; no event.
9. **SEQ_NOT_CURATED** — seed a `FACT` write on `pets`; retire its seq → `SEQ_NOT_CURATED`; no event.
10. **SEQ_ALREADY_RETIRED (op idempotency)** — retire S1 (succeeds), retire S1 again → `SEQ_ALREADY_RETIRED`; **assert tail advanced by 1 total**, not 2.
11. **all-or-nothing multi-seq** — `seqs:[S1, 99999]` (one valid, one bogus) → `RETIRE_INVALID_SEQS`, `detail.invalid` lists seq 99999 with code `SEQ_NOT_FOUND`; **no event appended**, S1 NOT retired (atomic).
12. **INVALID_RETIRE_SEQ** — `seqs:[0]`, `seqs:[-1]`, `seqs:[1.5]` each reject `INVALID_RETIRE_SEQ`; no event.
13. **INVALID_SLUG** — `slug:'Bad Slug'` rejects `INVALID_SLUG`; no event.
14. **INVALID_REASON** — `reason:''` (blank), `reason:'a'.repeat(121)` (too long), `reason:'a\nb'` (multiline) each reject `INVALID_REASON` **pre-lock**; assert no event appended (tail unchanged).
15. **tail-safety gate (v4, changelog #4 — option b) — TWO cases, both gating.** **(a) historical/middle break is NOT fatal:** construct a silo whose `interpret().skipped` contains a **middle** `hash_chain_break` (append a tampered/forced entry mid-log, then append a valid CURATED tail that interpret re-syncs onto, so `last_seq === freshTail.seq`); `retireBullet({slug, seqs:[validTailSeq]})` **succeeds** and appends exactly one event — proving retire does NOT false-positive on historical breaks (mirrors how `cmdCurate` retires across production's 17 April breaks). **(b) broken/malformed TAIL is fatal:** construct a silo whose **physical tail** is itself unsound — hand-append a final line whose `hash_prev` is wrong (a `hash_chain_break` at the tail), OR a shape-malformed final line that `_scanTailUnlocked` still accepts (parses, `seq ≥ 1`) but `validateEntryShape` rejects (e.g. missing `principal`/`intent_id`) — so `freshState.last_seq !== freshTail.seq`; `retireBullet(...)` **rejects `LOG_INTEGRITY_UNSAFE`** with `detail.{last_seq,tail_seq}` and **appends nothing** (tail seq unchanged). Together they prove the gate trips on a genuinely unsafe tail and ONLY on that. (Exercise via the op layer; both branches are constructible with `LogWriter` + a raw final-line append.)
16. **§B1 — cmdCurate no-op-retire suppression** — seed a CURATED bullet S1 on `pets`; retire S1 via `retireBullet` (now retired); drive `cmdCurate`'s retire-emit path (or the extracted lock-scoped filter predicate) with `supersededSeqs=[S1]`; assert **no** `TOPIC_BULLETS_RETIRED(S1)` event is appended (the filter drops it; the retire branch appends nothing). Proves §5.4 is now real for the nightly emitter.
17. **retire last bullet** — single CURATED bullet, retire it → success; `buildLayer2` returns `''`; topic still valid.
18. **import-shaped CURATED retire (GATING — folded from panel)** — seed an **import-shaped** CURATED write: `write_event{ tag:'CURATED', content:'## Architecture\n\n- bullet a\n- bullet b', imported:{ source_file:'x.md', field:'curated', heading:'Architecture' } }`; `retireBullet({slug, seqs:[S]})` → success; `buildLayer2` no longer contains the `## Architecture` block (the **whole section** is gone), proving retire handles import-origin blobs (the de-bundle target, §1a) and demonstrating the granularity gotcha in a test.
19. **recovery via re-curate (no UNRETIRE)** — retire S1; append a new CURATED write with the same content (seq M); `buildLayer2` contains it again; `retired_curated_seqs` still has S1 but not M.
20. **TOCTOU / lock atomicity** — (best-effort) fire two `retireBullet` promises on the same seq concurrently (`Promise.allSettled`); assert exactly one fulfilled, one rejected `SEQ_ALREADY_RETIRED`, and exactly one event appended.
21. **payload passes admission end-to-end** — assert the emitted event survives a full `interpret()` fold with every seq landing in `retired_curated_seqs` (not in `state.skipped`) — proves pre-flight and fold agree.
22. **DECISION-tag rejected** — seed a `DECISION` write; retire its seq → `SEQ_NOT_CURATED`; no event. (Locks in §9c = unsupported.)
23. **default principal exported + applied** — `assert.equal(DEFAULT_PRINCIPAL, 'operator')`; a retire with no `principal` emits an entry whose `.principal === 'operator'`.
24. **CLI smoke** (optional, if CLI-level harness exists) — `silo retire --slug pets --seq S1 --silo-dir <tmp>` exits 0, stdout parses to `{retired:true,seqs:[S1],...}`; `--seq S1,S2` multi form works; a referentially-bad-but-well-formed seq (e.g. `99999`) exits 1 with stderr matching `/silo retire: SEQ_NOT_FOUND —/` (proves the MCP-facing token format).
25. **CLI `--seq` strict-parse (R2-Retire-1 — round-2 MAJOR)** — each of these exits **2** (usage error) with stderr naming the offending token and **nothing appended** (assert tail seq unchanged): `--seq 1.5`, `--seq 12abc`, `--seq 2x`, `--seq 5,,9` (empty comma token), `--seq 0`, `--seq -1`, and `--seq 9007199254740993` (an all-digit integer >2^53 that fails `Number.isSafeInteger`). Conversely `--seq 5,9` and `--seq 5 --seq 9` parse to `[5,9]`. Proves `Number.parseInt` is no longer in the path and the `^[1-9]\d*$` + safe-integer guard rejects every fat-finger before any append.

---

## 9. Resolved questions (all §9 draft open-questions now DECIDED)

Every question the draft left "Undecided" is RESOLVED below, recording the ruling and its source.

| # | Question | RESOLUTION | Source |
|---|---|---|---|
| **9a** | Single-seq vs multi-seq now? | **DECIDED: multi-seq from day one.** `--seq` repeatable / comma-list; same-topic; all-or-nothing pre-flight; sorted+deduped (`[...new Set(seqs)].sort((a,b)=>a-b)`); ≤256. Single-seq is the trivial 1-element case. (Single-seq is a false economy and *less* safe — N separate locks widen the curate-race window.) | Unanimous panel; FOLD "Consensus accepts" |
| **9b** | Hard-error vs advisory no-op on invalid/already-retired seq? | **DECIDED: hard-error throw, append nothing, never `{retired:false}`-success.** The invariant "never append a no-op event" is non-negotiable; the response surface is a thrown `RetireOpError`. | Unanimous panel |
| **9c** | DECISION-tag (event-log) retire support? | **DECIDED: out of scope.** `buildLayer2` honors only CURATED; event-log bullets render in the event log, not Layer 2, and there is no retire fold for them. Retire rejects DECISION seqs as `SEQ_NOT_CURATED`. A separate primitive would be needed; not this feature. | Claude + ChatGPT; FOLD |
| **9d** | Default `principal` / `source`? | **DECIDED: CLI default `principal='operator'`** (already the `GLOBAL_OPTIONS` default, `src/cli/silo.js:77-80`); **MCP uses a server-configured `SILO_MCP_PRINCIPAL`** (default `desktop-claude` for back-compat), NOT a hard-coded literal — applied to **all four** MCP write tools (`write_event`/`accept`/`dismiss`/`retire`), not just retire (R1, round-2 MINOR), so one caller never logs under two principals. Framed as the **"server-deployment principal," not "caller identity"** (round-2 soft-spot ruling). `source` fixed at `'silo-retire'`. `DEFAULT_PRINCIPAL`/`RETIRE_SOURCE` exported for tests. | ChatGPT (principal); FOLD cleanups; R1 (all-four scope, round-2) |
| **9e** | Auto-regenerate when `--to` passed? | **DECIDED: yes.** `cmdRetire` regenerates iff `--to` is given (mirrors accept/dismiss, `src/cli/silo.js:977-980`); MCP always regenerates out-of-band via `regenerateAfterWrite()`. Write and projection stay separable when `--to` is omitted. | FOLD cleanups |
| **destructiveHint** | (draft left it `false`, flagged) | **DECIDED: `destructiveHint: true`** + description states "no un-retire; restore by re-curation." The granularity gotcha (one seq can remove a whole section) tips agent-safety over the append-only technicality. | FOLD "Ruling on contested" |
| **B1** | The one open decision: harden `cmdCurate` or narrow the invariant? | **DECIDED: (A) Patch `cmdCurate`** (§4.6). Lock-scoped revalidation of its retire emission; the only change to shipped code, in the curate COMMAND (not the sealed core). Makes the no-op-retire invariant true for both emitters. | Owner ruling; FOLD "THE ONE OPEN DECISION" |

**Additional folded fixes (single-reviewer, accepted — recorded for traceability):**
- **`INVALID_REASON` at the op layer** — `retireBullet`/`cmdRetire` rejects blank/multiline/>120 `reason` *before* the lock; MCP zod matches the admission validator (non-blank, single-line, ≤120), not bare `.max(120)`. (Claude MAJOR #3 + ChatGPT MINOR; §4.2, §4.3, §4.5.)
- **`LOG_INTEGRITY_UNSAFE` guard — re-scoped to a TAIL-safety gate in v4 (changelog #4, option b RESOLVED).** The round-1 fold added "refuse retire if `freshState.skipped` contains any `hash_chain_break`" (ChatGPT MINOR #6). Round-2 review + source check showed it is HARMFUL: it would brick retire against the production log's 17 historical April breaks, even though nightly `cmdCurate` appends fine across them. v3 floated dropping it (option a) vs. a tail-unsafe re-scope (option b). The Gemini-Pro third seat **+ the succeeding lead's independent source re-verification** chose **(b)** — dropping it is unsafe because `_scanTailUnlocked` is hash-chain-blind (`src/log/append.js:109-156`), so a new append onto a broken physical tail is silently orphaned by `interpret()`. v4 implements (b) as `refuse iff freshState.last_seq !== freshTail.seq` on the **manual op only**; `cmdCurate` stays ungated (asymmetry rationalized — §4.6). This also fixed a bug in v3's *sketched* option (b) (it read a nonexistent `freshState.tail` field). (§4.5, §4.6, §7 #17/#17b, §8 #15.)
- **`SEQ_NOT_FOUND` reworded** — `seq_to_event` only indexes write_events, so the message is "no CURATED write_event at seq N (may be a non-write event)." (Claude #2; §4.2, §4.5, §7 #1.)
- **Import-origin tag VERIFIED** — confirmed `tag:'CURATED'` at `src/import-jarvis/index.js:272-285`; added the import-shaped retire test (§8 #18). (Claude MAJOR #1; §0 #1.)
- **Granularity gotcha stated loudly** — CLI `--help` + MCP description say retire removes the entire payload at the seq (a whole section for import-origin writes). (All 3; §1, §4.3, §10-help.)
- **Flock-degraded caveat** — documented; production single-VPS is one flock domain. (Claude MFM-1 + ChatGPT MAJOR; §7 #18.)

---

## 10. Out of scope

- **UNRETIRE / un-retract.** Recovery is re-curation (§5.6). No mutating reverse primitive.
- **Batch cross-topic restructuring** ("move these 4 bullets from A to B" as one atomic op). Retire is per-topic (multi-*seq*, one *slug*); relocation is `retire on A` + `write CURATED on B`, two audited steps.
- **Content editing / in-place rewrite.** Retire removes; it never mutates a bullet's text. Rewrite = retire + new CURATED write (new seq).
- **Sub-section retire.** There is no way to retire one line *within* an import-origin `## Heading` block — the unit is the `write_event` (§1 granularity gotcha). De-bundling such a block = retire the section + write N new CURATED bullets.
- **Event-log (FACT/DECISION/TODO/…) retraction.** No fold exists for it; would be a separate feature (§9c).
- **Changing the admission gate, matrix, canonicalization, projection model, `interpret()`, or log format.** The *only* shipped-code change is the §B1 hardening of `cmdCurate`'s emit path. Everything else is additive: one new CLI verb, one new MCP tool, one new ops module.
- **GC / compaction of retired writes.** Retired CURATED `write_event`s remain in the log forever (append-only); only the projection hides them. Physical removal is not contemplated.
- **Per-caller MCP principal derivation.** Auth is a single shared bearer token (`silo-mcp/server.js:921-925`); server-configured `SILO_MCP_PRINCIPAL` is the mechanism. Per-client tokens → per-client principal is future work.

### §10-help — CLI `--help` text (load-bearing; states the granularity gotcha)

Add to `printHelp()` (`src/cli/silo.js:1453-1489`), in `commands:`:
```
  retire      retire active Layer-2 (CURATED) bullet(s) by seq, one topic.
              --slug=<s> --seq=<n>[,<n>...] [--reason=<txt>] [--to=<path>]
              WARNING: retires the ENTIRE write_event at each seq. For
              import-origin writes that is a whole "## Heading" section,
              not a single line. No un-retire — restore by re-curating.
```

---

## 11. Supporting files (manifest with re-verified anchors)

| File | Anchor lines | Why |
|---|---|---|
| `src/cli/silo.js` | `559` (`cmdCurate`), `569` (pre-lock interpret), `651-653` (active list), `768`, `783-786` (sort), `798-816` (retire emit — **§B1 patch site**) | The existing `TOPIC_BULLETS_RETIRED` emitter, the ascending-sort to mirror, and the exact lines B1 rewrites. |
| `src/cli/silo.js` | `77-80` (`GLOBAL_OPTIONS`, principal default `operator`), `880-1047` (`cmdSuggest` accept/dismiss), `977-980`/`1010-1013` (`--to` regen), `991-999` (dismiss multi-seq parse), `1331-1377` (options), `1394-1432` (dispatch), `1438-1450` (error→token catch), `1453-1489` (help) | CLI precedent for an ops-backed verb, exit codes, the `ADMISSION_REFUSED:` token, multi-seq parsing, and where to register `retire` + help. |
| `src/topic-proposal/suggestion-ops.js` | whole file (esp. `22` `DEFAULT_PRINCIPAL='operator'`, `31-38` error class, `66`/`179` `withAppendLock`, `127`/`204` `_appendBatchUnlocked`, `168-222` `dismissSuggestions` multi-seq all-or-nothing, `176` sort+dedup, `192-196` invalid-detail, `224` exports) | The exact module pattern `retire-ops.js` copies — including multi-seq + exports for tests. |
| `src/topic-proposal/retire-ops.js` | (NEW) | The shared op. §4.4–§4.5. |
| `src/admission/payload-validators.js` | `21-23` (NOT-semantic-referential disclaimer), `39` (`MAX_SUPERSEDED_SEQS=256`), `393-477` (`validateTopicBulletsRetiredPayload`), `462-471` (reason rule the MCP zod must match), `518-523` (CURATED multi-line ⇐ import emits whole sections) | Proves admission validates shape only — the gap pre-flight fills — and the reason/granularity facts. |
| `src/interpret/index.js` | `48-71` (shape-fail + hash_chain_break → `skipped`, `prevHash` NOT advanced), `86` (`last_seq` advances ONLY on an accepted entry), `235-293` (retire fold + silent-skip), `264-267` (active-CURATED reconstruction), `290` (`Set.add` idempotent), `402-410`+`416-423` (state shape the pre-flight reads; `seq_to_event` write_events only) | The silent-skip behavior that makes pre-flight mandatory; the state the pre-flight mirrors. **v4 (changelog #4) tail-gate:** because `last_seq` (`:86`) advances only on accept, `last_seq === freshTail.seq` iff the physical tail was folded — the basis for the manual-op tail-safety gate (§4.5). Historical *middle* breaks stay skipped while the tail stays folded. |
| `src/projection/regenerate-topic-file.js` | `138-163` (`buildLayer2`), `144-148` (required `retiredSeqs`), `154-158` (import-origin `field==='curated'` included) | Confirms only CURATED-and-not-retired bullets render; imported sections are retirable; retire honored automatically. |
| `src/import-jarvis/index.js` | `159-181` (`parseCuratedSections`), `266-286` (Layer-2 section → `write_event{tag:'CURATED'}`) | **The gating verification: imported `## Heading` sections are tag CURATED; one section = one event (granularity gotcha).** |
| `src/log/append.js` | `109-156` (`_scanTailUnlocked` — **hash-chain-blind** tail scan: returns the last syntactically-valid line w/o any `hash_prev` check), `210-212` (no-reenter docstring), `217-232` (`withAppendLock` → `{writer,freshTail,freshState}`; `freshTail = _scanTailUnlocked()` at `:221`), `307` (new append chains `hashPrev = tail.hash`), `257-321` (`_appendBatchUnlocked`, matrix gate `280-295`, frozen `maxKnownSeq` `297-305`) | The atomicity + admission substrate; the TOCTOU argument hinges on `withAppendLock`. **The §4.5 tail-gate exists precisely because `_scanTailUnlocked` is hash-chain-blind** — without it a broken physical tail would orphan the append. |
| `src/matrix/matrix.yaml` | `127-152` (`TOPIC_BULLETS_RETIRED` block, `standard:Y` at `148`) | Confirms default-socket admissibility; no admin socket. |
| `silo-mcp/server.js` | `31-36` (`WRITE_SIDE_EFFECT` — override `destructiveHint:true` for retire), `43-57` (constants — add `SILO_MCP_PRINCIPAL`), `194-199` (`extractAdmissionCode`), `222-233` (`regenerateAfterWrite`), `705`/`832`/`884` (the **three** hard-coded `desktop-claude` literals to replace — **verified this pass** — plus the new retire site = **four total**, R1), `816-915` (accept/dismiss tools), `921-925` (single bearer token) | The MCP tool template `retire_bullet` copies; the all-four-sites principal change (R1) + destructiveHint change. |
| `test/suggestion-ops.test.js` | `23-58` (`freshSilo`/`seedSuggested` harness), whole file | The test harness shape `test/retire-ops.test.js` mirrors. |

---

## 12. Maintainer notes & deferred follow-ups (non-blocking)

These do **not** gate ratification; record them for the build phase.

- **Optional: mirror the tail-safety gate onto `cmdCurate` (§4.6).** v4 gates only the manual op. Unlike the old broad guard, the tail-gate (`freshState.last_seq !== freshTail.seq`) does **not** trip on historical middle breaks, so adding it to the nightly `cmdCurate` retire-emit would NOT brick it — it would make the batch fail loudly on a genuinely broken tail instead of silently orphaning a retire. Deliberately left out of this ratified scope (the prescribed fix was manual-op-only); a small future change worth one reviewer's eyes if Helder wants symmetry.
- **Stale shipped-code doc string (round-2 R3 NIT).** `printHelp` at `src/cli/silo.js:1476` documents `--principal (default: helder)`, but the real `GLOBAL_OPTIONS` default is `operator` (`:77-80`). Fix the help text when implementing `retire` (which touches `printHelp` anyway). Pre-existing; not introduced here.

---

*End of retire-primitive.md — **RATIFIED 2026-06-14.** Folds: the round-1 3-reviewer panel (`FOLD-SYNTHESIS.md`) + the round-2 fold (`ROUND2-FOLD-SYNTHESIS.md`) + the Gemini-Pro third seat on retire (the integrity guard) + the succeeding Silo lead's **independent source re-verification** of that guard against `src/log/append.js` and `src/interpret/index.js`. Changelog: #1 `--seq` strict parser, #2 `SILO_MCP_PRINCIPAL` across all four MCP write tools, #3 `cmdCurate` post-filter summary, #4 `LOG_INTEGRITY_UNSAFE` re-scoped to a manual-op **tail-safety gate** (`refuse iff last_seq !== freshTail.seq`), #5 friendly required-flag usage errors. Shipped-code changes: §B1 hardening of `cmdCurate`'s retire emission (+ its R2-Retire-2 summary fix) and the R1 `SILO_MCP_PRINCIPAL` routing across all four MCP write tools. Supersedes the v1 DRAFT at `silo-design-history/11-retire-and-liveness-audit-archive/SPEC-retire-primitive.md` and the v2/v3 fold drafts. Implementation order: retire → v0.2.2.*
