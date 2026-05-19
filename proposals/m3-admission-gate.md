# Silo M3 — Matrix Admission Gate Enforcement

**Author**: desktop-claude
**Date**: 2026-05-19 (revised same day after 1 pre-flight + 1 external audit round)
**Status**: **Implementation-ready.** All findings from 3 external reviewers (ChatGPT + Gemini + fresh-Claude sub-agent) folded inline. Unanimous "approve with minor changes" verdict. Strict-recovery posture ratified.
**Scope**: Wire `Matrix.isAdmissible()` into `LogWriter._appendBatchUnlocked()` so the existing event-capability matrix actually enforces admission at write time, not just describes it. ~150-200 LOC + tests + a separate fixture-migration commit, across the writer + ~14 call sites + ~7 test files. Implementation order: fixture-migration commit FIRST, admission gate SECOND (per §10).

---

## 0. Problem statement

`src/matrix/matrix.yaml` is the normative ground-truth for which event types are admissible on which (socket, mode) pair. The matrix loader (`src/matrix/load.js`) exposes `Matrix.isAdmissible(type, socket, mode)` as the admission oracle. The MATRIX is correct; the LOADER is correct; the ORACLE is exercised in unit tests.

**The gap**: nothing calls the oracle at append time. `LogWriter._appendBatchUnlocked` validates payload shape via `validatePayloadForAppend()` but never asks the matrix whether the event is admissible on the caller's (socket, mode). Today the only writer is a single trusted operator, so the gap isn't exploitable. Three reasons to close it anyway:

1. **The README's threat-model section** lists M3 as a roadmap item ("admission matrix exists but is not enforced"). The README promise is awkward to maintain in OSS publishing — readers will ask why the matrix exists if it's not wired up.
2. **Defense-in-depth.** Today identity events like `ACL_SEALED` and `PRINCIPAL_DECLARED` are admin-only per the matrix, but any caller with filesystem access to `/root/.silo` can emit them. Wiring the gate moves the boundary from "trust the caller" to "trust the writer."
3. **Multi-principal hosting becomes possible.** A hosted Silo (OAuth, per-user tokens) cannot grant every authenticated user the right to emit identity events. Without M3, that's the only outcome.

This is not a behavior change for any current single-user deployment — the existing call sites already obey the matrix by convention. M3 makes the convention enforced.

---

## 1. Architecture

Three changes:

1. **Writer API extension.** `LogWriter.append(args)` and `LogWriter.batchAppend(entries)` accept an additional `socket` parameter (`'standard'` | `'admin'`, default `'standard'`). The `mode` parameter is reserved-but-rejected in M3 (raises `INVALID_WRITER_MODE` when not `'normal'` or absent) — broker modes (`install_freeze`, `read_only`, `recovery`) ship in a later milestone when the broker actually transitions between modes. Today the broker is always in `normal`.
2. **Admission check inside `_appendBatchUnlocked`.** Before payload validation, for each staged entry: load the matrix oracle, call `isAdmissible(type, socket, 'normal')`. Reject the entire batch on first failure with a structured error.
3. **New module: `src/log/admission-error.js`** holding the `AdmissionError` class (see §3.3).

Matrix loader is already a process-singleton via top-level `import`; no new caching layer needed.

---

## 2. What the matrix already specifies

Matrix loader exposes `Matrix.isAdmissible(type, socket, mode = 'normal')`:

- `socket='standard'` → caller is the normal write path (CLI write, MCP write_event, cron, sub-process commands).
- `socket='admin'` → caller is bootstrap / identity / ACL / install / recovery / broker meta operations.
- `mode='normal'` → no broker-imposed write freeze.

Rows in the matrix that matter for M3:

| Family | Examples | standard | admin |
|---|---|---|---|
| topic | write_event, TOPIC_METADATA_SET, TOPIC_VERIFIED, TOPIC_CURATED, TOPIC_BULLETS_RETIRED, TOPIC_SUGGESTED, TOPIC_SUGGESTION_ACCEPTED, TOPIC_SUGGESTION_DISMISSED | Y | Y |
| memory | MEMORY_PROMOTED, MEMORY_RETIRED | Y | Y |
| procedure | PROCEDURE_PUBLISHED, PROCEDURE_RETIRED | Y | Y |
| observation | observation_read, observation_write | Y | Y |
| cohort | COHORT_SPLIT | Y | Y |
| acl | ACL_SEALED | **N** | Y |
| identity | PRINCIPAL_DECLARED, PRINCIPAL_UID_BOUND, PRINCIPAL_ACCESS_ENABLED, … | **N** | Y |
| install | INSTALL_STARTED, INSTALL_STEP_COMPLETED, … | **N** | Y |
| feature | FEATURE_PROPOSED, FEATURE_ACTIVE, … | **N** | Y |
| tag | TAG_SCHEMA_PROPOSED, TAG_SCHEMA_ACTIVE | **N** | Y |
| recovery (mode toggles) | RECOVERY_MODE_ENTERED, RECOVERY_MODE_EXITED | **N** | Y |
| recovery (in-recovery only) | RECOVERY_ACCEPTED, RECOVERY_REPUDIATED | **N** | **N**\* |
| broker | BROKER_KEY_ROTATED, REGISTER_EVENT_TYPE | **N** | Y |

\* Audit round 1 ratified **strict recovery**: RECOVERY_ACCEPTED / RECOVERY_REPUDIATED are admin-N in normal mode per the matrix (rows 510-525 of matrix.yaml). Once §3.2's oracle call ships, admin-socket attempts in normal mode are rejected automatically — no special case in M3 code. The matrix carries the rule; the writer faithfully executes it. When broker-mode wiring lands later, the recovery column will start admitting these inside actual recovery mode.

Unknown event types (not in matrix.yaml) MUST be rejected per v12.5 §19 spec invariant ("every admissible event type has a row here; unlisted event types are rejected"). Error code: `UNKNOWN_EVENT_TYPE_NOT_REGISTERED`.

---

## 3. Writer API change

### 3.1 New signature

```js
// Before:
await writer.append({
  type: 'write_event',
  isStateBearing: true,
  intentId,
  principal,
  payload,
  ts,
});

// After (socket defaults to 'standard'):
await writer.append({
  type: 'write_event',
  isStateBearing: true,
  intentId,
  principal,
  payload,
  ts,
  socket: 'standard',     // optional; default 'standard'
});
```

Batch shape is the same — `socket` rides per-entry. A single batch MAY mix sockets (e.g., import-jarvis emits some entries on standard and ACL_SEALED on admin). Each staged entry's admission is checked independently against its own `socket`.

`socket` and the reserved `mode` are **writer-control metadata, not persisted log entry fields.** The writer destructures them off `args` and consumes them at admission time; they do NOT pass into `buildEntry()` and never appear in the JSONL on disk. This is intentional — the JCS canonical hash should only cover the persisted entry, not transport-level control flags.

`mode` is reserved as a future per-entry field. M3 always treats mode as `'normal'`. To prevent callers from depending on a value the writer doesn't honor yet, M3 rejects any `mode` field other than `'normal'` (or absent) with `INVALID_WRITER_MODE`. When broker modes ship, the validator relaxes; until then, silent-accept would be a footgun.

**Direct `_appendBatchUnlocked` callers.** `src/topic-proposal/suggestion-ops.js` lines 127 and 204 call `_appendBatchUnlocked` directly inside `withAppendLock` (bypassing the `batchAppend` public wrapper to avoid re-entering the lock — see `src/log/append.js:210` comment). These call sites MUST pass `socket` per-entry just like the public-wrapper callers. Documented here so the implementation doesn't accidentally route socket only through the public path.

### 3.2 Admission check inside `_appendBatchUnlocked`

Insertion point: **immediately before** `validatePayloadForAppend` per-entry. Admission runs first so unauthorized callers don't get payload-shape feedback for events they were never allowed to emit. Pseudo-code:

```js
for (let i = 0; i < entriesInput.length; i++) {
  const input = entriesInput[i];
  const { type, isStateBearing, intentId, principal, payload, ts, socket } = input;
  const socketOrDefault = socket ?? 'standard';

  // 1. Matrix admission (M3 — NEW)
  if (!matrix.isKnown(type)) {
    throw new AdmissionError('UNKNOWN_EVENT_TYPE_NOT_REGISTERED', { type });
  }
  if (!matrix.isAdmissible(type, socketOrDefault, 'normal')) {
    throw new AdmissionError('EVENT_NOT_ADMISSIBLE', {
      type, socket: socketOrDefault, mode: 'normal',
    });
  }

  // 2. Payload validation (existing)
  validatePayloadForAppend({ type, payload }, { maxKnownSeq: tail.seq });

  // 3. Build entry + hash (existing)
  …
}
```

All-or-nothing: any entry's admission failure rejects the whole batch BEFORE any disk write. Consistent with existing `validatePayloadForAppend` semantics — the writer never persists partial batches.

### 3.3 Error class

```js
// src/log/admission-error.js
export class AdmissionError extends Error {
  constructor(code, details) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.code = code;
    this.details = details;
  }
}
```

Codes:
- `UNKNOWN_EVENT_TYPE_NOT_REGISTERED` — type not in matrix.yaml.
- `EVENT_NOT_ADMISSIBLE` — type known but `isAdmissible` returned false for given (socket, mode).
- `INVALID_WRITER_MODE` — caller passed `mode` ≠ `'normal'` (reserved-but-unimplemented; see §3.1).

Distinct from existing payload-validation errors. `validatePayloadForAppend` in `src/admission/payload-validators.js` throws structured `AdmissionValidationError` with `code: INVALID_EVENT_PAYLOAD` and a `field`/`reason` detail object. M3's admission errors carry a different semantic axis: **capability/type** (admission) vs. **shape/content** (payload). Callers can distinguish:

- `AdmissionError.code === 'EVENT_NOT_ADMISSIBLE'` — "you can't emit this type at all on this socket"
- `AdmissionValidationError.code === 'INVALID_EVENT_PAYLOAD'` — "the type is allowed, but the payload is malformed"

MCP server + CLI surface both error classes with structured `{code, details}` to callers; tests pattern-match on `.code`. **§5.1 and §5.2 below pin one consistent surfacing pattern** so CLI stderr and MCP regex don't drift.

---

## 4. Call-site impact

| Call site | File | Current type(s) | M3 socket |
|---|---|---|---|
| `silo init` — bootstrap | `src/cli/silo.js` cmdInit | PRINCIPAL_DECLARED, PRINCIPAL_UID_BOUND, PRINCIPAL_ACCESS_ENABLED | **admin** |
| `silo write` | `src/cli/silo.js` cmdWrite | write_event | standard |
| `silo extract` | `src/cli/silo.js` cmdExtract (line 423) | write_event (from session-extract LLM output) | standard |
| `silo curate` (bootstrap path) | `src/cli/silo.js` runBootstrapCurate (lines 516, 532) | write_event (CURATED tag), TOPIC_CURATED | standard |
| `silo curate` (regular path) | `src/cli/silo.js` other curate sites (lines 738, 801, 823, 841) | TOPIC_CURATED, TOPIC_BULLETS_RETIRED, MEMORY_PROMOTED, MEMORY_RETIRED | standard |
| `silo suggest --run-now` (detector) | `src/topic-proposal/detect.js` (lines 155, 422) | TOPIC_SUGGESTED + curation-status events | standard |
| `silo suggest --accept` | `src/topic-proposal/suggestion-ops.js:127` (direct `_appendBatchUnlocked` inside `withAppendLock`) | TOPIC_METADATA_SET + TOPIC_SUGGESTION_ACCEPTED | standard |
| `silo suggest --dismiss` | `src/topic-proposal/suggestion-ops.js:204` (direct `_appendBatchUnlocked`) | TOPIC_SUGGESTION_DISMISSED | standard |
| MCP `write_event` | `silo-mcp/server.js` (via `silo write` subprocess) | write_event | standard (inherits from CLI) |
| MCP `accept_suggestion` | `silo-mcp/server.js` (via `silo suggest --accept` subprocess) | (same batch as above) | standard (inherits from CLI) |
| MCP `dismiss_suggestion` | `silo-mcp/server.js` (via `silo suggest --dismiss` subprocess) | TOPIC_SUGGESTION_DISMISSED | standard (inherits from CLI) |
| `silo import-jarvis` (topic body) | `src/import-jarvis/index.js` (lines 197, 221, 235, 248, 272, 291) | TOPIC_METADATA_SET, write_event, TOPIC_VERIFIED, TOPIC_CURATED | standard |
| `silo import-jarvis` (sensitive topic seal) | `src/import-jarvis/index.js:310` | ACL_SEALED | **admin** |
| `silo import-jarvis` (event-log lines) | `src/import-jarvis/events.js:161` | write_event | standard |
| (test fixtures + bench) | `test/*` — see §8.2 fixture inventory | various | varies — set per test intent |

**Important caller pattern note**: silo-mcp routes through `silo write` / `silo suggest` subprocesses (see `silo-mcp/server.js` write_event impl). That means MCP callers do NOT pass `socket` directly to LogWriter — the CLI layer does. MCP server-side changes for M3 are zero LOC; CLI is the seam.

The only call site that mixes sockets in a single execution is `silo import-jarvis`. ACL_SEALED needs admin; everything else needs standard. The implementation should make this explicit per `writer.append` call rather than running the whole import in admin mode.

### 4.1 Dormant event families

The matrix lists event families that have **no current production call site**: INSTALL_*, FEATURE_*, TAG_SCHEMA_*, BROKER_KEY_ROTATED, REGISTER_EVENT_TYPE, observation_read, observation_write, PROCEDURE_PUBLISHED, PROCEDURE_RETIRED, COHORT_SPLIT. They're spec'd but unwired (broker, install transaction, and procedure-publication subsystems are M4+ work).

M3 doesn't add production call sites for these — that would be scope creep. But the §6.2 coverage meta-test still needs to exercise them, so the test suite emits synthetic positive cases per row (and explicit normal-mode-rejection cases for the recovery-only rows). See §6.2 below.

---

## 5. Error semantics

### 5.1 CLI surface — consistent error token

CLI commands that fail admission emit a parseable token on stderr in the form:

```
silo <subcommand>: ADMISSION_REFUSED:<code> — <human description>
```

…where `<code>` is one of `EVENT_NOT_ADMISSIBLE` / `UNKNOWN_EVENT_TYPE_NOT_REGISTERED` / `INVALID_WRITER_MODE`. Exit 1.

This format (a) is grep-friendly for the MCP regex (see §5.2), (b) carries the structured `code` for log analysis, and (c) keeps a human description for direct CLI users. Picked over the alternative (CLI prints a free-text message; MCP parses it) because parse-by-regex on free-text is brittle as messages evolve.

Per-command expectations:

- `silo init` — admin-bootstrap; no admission failure expected. If admission fails (e.g., re-init attempted), the existing "already has N entries; refusing to reinit" check covers it before admission runs.
- `silo write`, `silo extract`, `silo curate`, `silo suggest` — all use socket='standard'. Admission failure means the matrix says the event type isn't standard-admissible. Today no standard-write path emits an admin-only event, so an admission failure indicates a bug — surface with the format above.
- `silo import-jarvis` — admission failure on ACL_SEALED would mean the matrix changed without updating the import code. Same error format.

### 5.2 MCP surface — extend the existing regex

`silo-mcp/server.js` already parses CLI stderr via a regex on the `SuggestionOpError code` pattern (lines ~824, 870). Extend the existing regex to ALSO capture the §5.1 admission token:

```js
const ADMISSION_RE = /ADMISSION_REFUSED:([A-Z_]+) — /;
const SUGGEST_RE   = /silo suggest --\w+: ([A-Z_]+) —/;  // existing
```

When stderr matches `ADMISSION_RE`, surface the captured code as the MCP error envelope's `code` field. AI clients can then distinguish "permission denied at the matrix layer" (`EVENT_NOT_ADMISSIBLE`) from "malformed payload" (`INVALID_EVENT_PAYLOAD`, already surfaced from payload-validators.js) and react accordingly.

`AdmissionError` and `AdmissionValidationError` are both exposed distinctly through this surface. Zero MCP server-side LOC for M3 beyond the regex extension.

### 5.3 Direct writer use (tests + future internal callers)

`AdmissionError` thrown from `writer.append` / `writer.batchAppend`. Tests pattern-match on `.code` and `.details`. No process exit — the throw propagates to the test's `assert.rejects`.

---

## 6. Test plan

### 6.1 Unit tests (writer level)

`test/log-admission-gate.test.js` (new):

1. **Standard socket admits write_event.** Default-no-socket call succeeds; explicit `socket: 'standard'` succeeds.
2. **Standard socket rejects ACL_SEALED.** AdmissionError with `code: 'EVENT_NOT_ADMISSIBLE'`, `details: { type: 'ACL_SEALED', socket: 'standard', mode: 'normal' }`.
3. **Standard socket rejects PRINCIPAL_DECLARED.** Same shape.
4. **Admin socket admits ACL_SEALED.** With `socket: 'admin'`, the call succeeds; entry persisted with correct seq + hash.
5. **Admin socket admits write_event.** Admin can do everything standard can do.
6. **Unknown event type rejected on standard.** `code: 'UNKNOWN_EVENT_TYPE_NOT_REGISTERED'`.
7. **Unknown event type rejected on admin.** Same — unknown is always rejected, regardless of socket.
8. **Batch rejects when ANY entry fails admission.** A batch of `[write_event, ACL_SEALED]` on standard → entire batch rejected, no entries persisted; tail unchanged.
9. **Batch all-pass.** A batch of `[TOPIC_METADATA_SET, write_event]` on standard → all entries persisted; tail advances by 2.
10. **Mixed-socket batch.** A batch with `[write_event (standard), ACL_SEALED (admin)]` → both entries persisted (one's standard-Y, the other's admin-Y). Demonstrates per-entry socket.
11. **Admission runs BEFORE payload validation (spy test).** Stub `validatePayloadForAppend` with a spy that throws when called. Emit ACL_SEALED on standard socket. Assert: spy is **NOT** called; error is `EVENT_NOT_ADMISSIBLE`. (Previous wording "send malformed-payload ACL_SEALED" doesn't prove ordering — ACL_SEALED has no payload validator, so the test would pass either way. The spy version is the actual proof.)
12. **Concurrency: two writes serialized through the same gate.** Fire two `writer.append` calls in parallel — one admin-allowed, one admin-rejected on standard. The flock + `_locked` mutex already serialize, so this should be a no-op test, but listing it explicitly closes the "race between matrix load and writer init" question.
13. **Invalid socket value.** Pass `socket: 'banana'` to writer.append. Expected: rejection. (Likely `EVENT_NOT_ADMISSIBLE` since the matrix oracle throws on invalid socket per `src/matrix/load.js:117`; spec doesn't add a separate `INVALID_SOCKET` code unless audit feedback wants it.)
14. **Invalid mode value.** Pass `mode: 'recovery'` to writer.append. Expected: `INVALID_WRITER_MODE` (§3.1 silent-accept would be a footgun; M3 explicitly rejects non-normal modes until broker-mode wiring lands).

### 6.2 Spec invariant test (revised — strict-recovery + dormant-family aware)

`test/matrix-coverage.test.js` (new):

**Invariant**: every event type in `matrix.yaml` has explicit M3 admission coverage. The coverage shape depends on the row:

- **Type has at least one normal-mode-Y cell** (`standard: Y` or `admin: Y`): must have at least one positive admission test in the suite (writer accepts the type on a normal-mode-Y socket).
- **Type has normal-mode-N on every socket** (only RECOVERY_ACCEPTED + RECOVERY_REPUDIATED today): must have an explicit normal-mode rejection test on BOTH standard and admin sockets, asserting `code: 'EVENT_NOT_ADMISSIBLE'`.

Implementation: the matrix gate records every `(type, socket, result)` triple it sees across all tests. The final test in `matrix-coverage.test.js` runs after the rest and compares against `matrix.listTypes()`.

**Dormant event families**: most types in matrix.yaml have no production call site (INSTALL_*, FEATURE_*, TAG_SCHEMA_*, broker meta, observations, procedures, COHORT_SPLIT). The coverage meta-test relies on synthetic positive cases in `test/log-admission-gate.test.js` — one `writer.append` per dormant row, on the lowest-privilege admissible socket. These synthetic cases are cheap (each is a 5-line test) and they make the coverage meta-test pass without needing production code for those subsystems.

This is a meta-test that catches "added a new event type but forgot to test admission for it" regressions, and forces explicit rejection coverage for matrix-N-in-normal-mode types.

### 6.3 Integration tests

`test/cli-init.test.js` (extend existing): assert `silo init` events all carry socket='admin' internally — write a one-event-at-a-time call sequence with admission spy.

`test/cli-suggest.test.js` (extend existing): assert `silo suggest --accept` batch passes socket='standard' for both TOPIC_METADATA_SET + TOPIC_SUGGESTION_ACCEPTED.

`test/import-jarvis.test.js` (extend): import a topic with `sensitivity: 'private'`, assert the ACL_SEALED entry was emitted on admin and the rest on standard.

### 6.4 Backwards-compat sanity

Run the existing full suite **after the fixture-migration commit lands** (see §10 step 1). Tests that currently emit admin-only events (PRINCIPAL_DECLARED / UID_BOUND / ACCESS_ENABLED / ACL_SEALED) on the default `socket: 'standard'` will start failing the moment the gate is wired — they need an explicit `socket: 'admin'` argument. The fixture-migration commit makes that change for all affected helpers BEFORE the admission gate ships, so the gate-landing commit sees a clean suite.

Post-M3 target: 476 baseline + new admission-gate tests + new matrix-coverage test, all green. The exact post-M3 number depends on how many synthetic dormant-family cases land in §6.2.

---

## 7. Acceptance criteria

Implementation considered complete when:

- Fixture-migration commit landed first (per §10 step 1); pre-gate suite remains 476/476 green.
- `LogWriter.append` and `batchAppend` accept optional per-entry `socket` (defaulting to `'standard'`).
- `_appendBatchUnlocked` calls `Matrix.isAdmissible(type, socket, 'normal')` for every entry BEFORE payload validation; rejects the batch on first failure.
- Unknown types throw `AdmissionError('UNKNOWN_EVENT_TYPE_NOT_REGISTERED')`.
- `mode != 'normal'` (or absent) is rejected with `AdmissionError('INVALID_WRITER_MODE')`.
- Direct `_appendBatchUnlocked` callers in `suggestion-ops.js` pass `socket` per-entry (§3.1).
- `silo init` passes `socket: 'admin'` for all three identity events.
- `silo import-jarvis` passes `socket: 'admin'` only for the ACL_SEALED line; everything else stays standard.
- All other call sites stay implicit (default to `'standard'`).
- New `test/log-admission-gate.test.js` covers the 14 scenarios in §6.1 (including the spy-based ordering proof and the dormant-family synthetic positives).
- `test/matrix-coverage.test.js` enforces §6.2's revised invariant (positive case OR explicit normal-mode rejection per row).
- MCP regex in `silo-mcp/server.js` extended to capture `ADMISSION_REFUSED:<code>` (§5.2).
- CLI emits `silo <subcommand>: ADMISSION_REFUSED:<code> — <description>` on stderr (§5.1).
- Full suite green post-gate: 476 baseline + 14 admission tests + matrix-coverage test + any synthetic dormant-family additions.
- README threat-model section updated: M3 moves from "roadmap" to "enforced" with §8.4 layering note (write-path authorization vs. read-path integrity).
- Memory event under `jarvis-claw` slug when M3 ships.

---

## 8. Risks

### 8.1 RECOVERY_ACCEPTED / RECOVERY_REPUDIATED gating — RATIFIED STRICT

Matrix says these are admin-N in normal mode (admissible only in recovery mode). M3 implements only `mode='normal'`, so the writer rejects them on admin socket too. Audit round 1 unanimously ratified **strict**: the matrix is the ground truth; the writer faithfully executes it; no special-case code in M3. The §2 table reflects this (admin-N rows, no asterisk-with-allowance).

When broker modes ship, RECOVERY_ACCEPTED / RECOVERY_REPUDIATED become admissible on the recovery column — no M3 code changes needed; the matrix oracle picks them up automatically.

### 8.2 Test fixture migration — discrete commit BEFORE the gate

**Inventory** (from audit round 1 grep across `test/**`): ~20 admin-event emissions across 7 test files on default-socket-standard writer calls. The biggest is `test/interpret.test.js`'s `seedBasicLog` helper (lines ~18-42), which seeds the three identity events (PRINCIPAL_DECLARED, PRINCIPAL_UID_BOUND, PRINCIPAL_ACCESS_ENABLED) — every test using that helper inherits an admin emission. Other affected files: `admission.test.js`, `distill.test.js`, `import-events.test.js`, `import.test.js`, `projection.test.js`, `retrieval.test.js`.

Every one will throw `EVENT_NOT_ADMISSIBLE` the moment the gate is wired.

**Migration approach**: a single fixture-migration commit precedes the admission-gate commit. It:
1. Updates `seedBasicLog` (and any analogous helpers) to pass `socket: 'admin'` for identity events.
2. Updates inline test code that emits admin events to pass `socket: 'admin'` per call.
3. Lands BEFORE the gate so the suite stays green commit-by-commit.

Because `socket` defaults to `'standard'` and the gate isn't yet enforcing, the fixture-migration commit is a behavior-equivalent no-op at runtime — the explicit `socket: 'admin'` doesn't change anything pre-gate. The commit's value is that it makes the gate-landing commit a clean diff: implementation + tests, no fixture churn intermingled.

**Verification step**: between commits 1 and 2 (§10), run the full suite. Expect 476/476 still passing. Then land the gate commit and expect 476 → 476 + new admission-gate tests + new matrix-coverage test, all green.

### 8.3 Performance

Matrix lookup is a map access (`O(1)`) — no measurable overhead. The existing payload validation is already heavier (regex, length checks). M3 adds zero noticeable cost.

### 8.4 Threat-model wording

M3 protects callers that go through `LogWriter`. It does NOT stop a process with raw filesystem write access from appending directly to `/root/.silo/operation-log/*.jsonl`. The hash-chain verification (audit-response commit on `interpret()` replay) catches such tampering at read time. README's threat-model section should be updated to reflect this layering: M3 = write-path authorization gate; hash-chain = read-path integrity.

### 8.5 Future broker-mode wiring

Mode is reserved-but-rejected in M3 (§3.1 raises `INVALID_WRITER_MODE` on `mode != 'normal'`). When broker modes land:

- `install_freeze` — set during install transaction.
- `read_only` — set when broker enters degraded mode (e.g., disk full).
- `recovery` — set when broker enters recovery mode.

Each of these requires (a) a mechanism to transition into the mode, (b) a way to surface "current mode" to the writer, and (c) tests for the mode transitions. M3 keeps the `mode` parameter docs explicit about its reserved status; the `INVALID_WRITER_MODE` rejection is the seam to be relaxed.

---

## 9. Out of scope

- **Broker mode transitions** (install_freeze, read_only, recovery). Documented as reserved; implementation is a separate milestone.
- **Per-principal authorization** (OAuth, per-user tokens). Multi-principal admission needs a `principal_class` dimension that the matrix doesn't currently have. Separate from M3.
- **REGISTER_EVENT_TYPE flow.** v12.5 spec allows dynamic event-type registration via this meta event. M3 keeps unknown types rejected; the registration path is M4+ work.
- **Matrix-yaml-driven payload schema generation.** Today payload validators are hand-coded in `src/admission/payload-validators.js`. Generating them from matrix.yaml metadata is a refactor, not an admission-gate concern.
- **Per-socket flock / process-level isolation.** Different sockets sharing the same writer process is fine; M3 doesn't fork the writer.

---

## 10. Implementation order

After audit ratification (now complete):

1. **Fixture migration.** Update test helpers + inline tests to pass explicit `socket: 'admin'` for the ~20 admin-event emissions across 7 files inventoried in §8.2. Pre-gate this is a no-op at runtime (default is standard, gate doesn't enforce yet), so the full suite stays 476/476 green at this commit. The point is to land the diff in isolation so commit 2 has a clean surface.
2. **AdmissionError class + matrix integration.** Add `src/log/admission-error.js`. Edit `_appendBatchUnlocked` to call the oracle + throw `AdmissionError`. Pass `mode != 'normal'` rejection (§3.1). Add `test/log-admission-gate.test.js` with the 14 scenarios from §6.1. Suite goes 476/476 → 476 + 14 admission tests + matrix-coverage = 491+ green.
3. **Production call-site updates.** `silo init` passes `socket: 'admin'` for the three identity events; `silo import-jarvis` passes `socket: 'admin'` only on the ACL_SEALED line at `src/import-jarvis/index.js:310`. No other call site needs admin (confirmed against the §4 table). Each adjustment its own commit per anti-bundling.
4. **Matrix coverage test.** Add `test/matrix-coverage.test.js` enforcing §6.2's revised invariant. Include synthetic positive cases for the dormant event families and explicit normal-mode rejection cases for RECOVERY_ACCEPTED / RECOVERY_REPUDIATED.
5. **MCP regex extension.** Single one-line change in `silo-mcp/server.js` per §5.2 — extend the SuggestionOpError regex to also capture `ADMISSION_REFUSED:<code>`. Test via existing mcp-test fixtures.
6. **README threat-model update.** Move M3 from "roadmap" to "enforced" in the threat-model section. Note the §8.4 layering (write-path authorization vs. read-path integrity). One doc commit.
7. **Deploy.** `cd /root/silo && git pull` on the VPS. (After unrelated VPS `git pull` drift is resolved — see [jarvis-claw memory note 2026-05-19](#).) Optionally run `/root/deploy-silo-mcp.sh` if the MCP regex extension lands; otherwise the CLI changes propagate via the silo-source path only.
8. **Memory event.** `[CHANGED] jarvis-claw: M3 admission gate enforced...` per the per-ship pattern.

Per Helder's anti-bundling: implementation is ~6-7 commits — fixture migration, gate + tests, two call-site commits (init / import-jarvis), coverage test, MCP regex, README. Don't bundle.

---

## 11. Audit trail

### Round 1 — 2026-05-19

Three independent reviewers given identical charter + bundle (spec + matrix.yaml + append.js + payload-validators.js).

| Reviewer | Verdict | Required-changes count | Notable findings |
|---|---|---|---|
| ChatGPT | approve-with-minor-changes | 6 | Recovery contradiction (§2); coverage invariant under strict (§6.2); test #11 doesn't prove ordering; §3.2 wording; §3.3 payload-error description; CLI/MCP error-surfacing alignment |
| Gemini | approve-with-minor-changes | 2 | Coverage invariant under strict (§6.2); dormant event families need synthetic positive cases |
| Fresh-Claude sub-agent | approve-with-minor-changes | 5 | Recovery contradiction (§2); fixture migration severely underestimated (§8.2 — found ~20 admin emissions across 7 test files); §4 missing call sites + direct `_appendBatchUnlocked` callers; error-code naming inconsistency |

**Convergent findings** (caught by 2+ reviewers): §2 recovery contradiction, §6.2 coverage invariant, §4 completeness.

**Critical single-reviewer find**: the fresh-Claude agent's §8.2 fixture grep — ChatGPT and Gemini couldn't perform this check because they only had the attached files. The agent ran on the live workspace and found the actual count. Fixture migration is now §10 step 1 because of this.

**Strict-recovery posture**: unanimously ratified across all three verdicts. §8.1 closed.

All required-change findings folded inline in this same file. Suggestions and open-question items folded where actionable; speculative ones left for implementation discretion. No round 2 needed.

---

*Audit trail closed. Implementation may proceed per §10.*
