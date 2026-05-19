# Silo M3 — Matrix Admission Gate Enforcement (DRAFT)

**Author**: desktop-claude
**Date**: 2026-05-19
**Status**: **DRAFT — pending audit round 1** (ChatGPT + Gemini). Implementation paused until audit findings folded inline; same file renamed (status line edited in place) once ratified.
**Scope**: Wire `Matrix.isAdmissible()` into `LogWriter._appendBatchUnlocked()` so the existing event-capability matrix actually enforces admission at write time, not just describes it. ~150-200 LOC + tests across the writer + the ~12 call sites. Single implementation session after audit ratification.

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

Two changes, no new modules:

1. **Writer API extension.** `LogWriter.append(args)` and `LogWriter.batchAppend(entries)` accept an additional `socket` parameter (`'standard'` | `'admin'`, default `'standard'`). The `mode` parameter is reserved but defaults to `'normal'` in M3 — broker modes (`install_freeze`, `read_only`, `recovery`) ship in a later milestone when the broker actually transitions between modes. Today the broker is always in `normal`.
2. **Admission check inside `_appendBatchUnlocked`.** Before payload validation, for each staged entry: load the matrix oracle, call `isAdmissible(type, socket, 'normal')`. Reject the entire batch on first failure with a structured error.

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
| recovery | RECOVERY_MODE_ENTERED, RECOVERY_MODE_EXITED, RECOVERY_ACCEPTED, RECOVERY_REPUDIATED | **N** | Y* |
| broker | BROKER_KEY_ROTATED, REGISTER_EVENT_TYPE | **N** | Y |

\* RECOVERY_ACCEPTED / RECOVERY_REPUDIATED are admin-N in normal mode per the matrix — admissible only in recovery mode. M3 doesn't gate these because broker modes ship later; today the writer simply allows them when `socket='admin'`. **Audit question**: should M3 hard-deny them until mode wiring lands?

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

`mode` is reserved as a future per-entry field. M3 always treats mode as `'normal'`. The writer ignores any `mode` field a caller passes — documenting now prevents callers from depending on a value the writer doesn't honor yet.

### 3.2 Admission check inside `_appendBatchUnlocked`

Insertion point: between `validatePayloadForAppend` and `buildEntry` per-entry. Pseudo-code:

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

Distinct from payload-validation errors (which currently `throw new Error('payload: ...')` per `validatePayloadForAppend`). MCP server + CLI surface errors with structured `{code, details}` to callers; tests pattern-match on `.code`.

---

## 4. Call-site impact

| Call site | File | Current type(s) | M3 socket |
|---|---|---|---|
| `silo init` — bootstrap | `src/cli/silo.js` cmdInit | PRINCIPAL_DECLARED, PRINCIPAL_UID_BOUND, PRINCIPAL_ACCESS_ENABLED | **admin** |
| `silo write` | `src/cli/silo.js` cmdWrite | write_event | standard |
| `silo curate` | `src/cli/silo.js` curate paths | TOPIC_CURATED, TOPIC_BULLETS_RETIRED, MEMORY_PROMOTED, MEMORY_RETIRED | standard |
| `silo suggest --run-now` | `src/topic-proposal/detect.js` | TOPIC_SUGGESTED + curation-status events | standard |
| `silo suggest --accept` | `src/topic-proposal/suggestion-ops.js` (batch) | TOPIC_METADATA_SET + TOPIC_SUGGESTION_ACCEPTED | standard |
| `silo suggest --dismiss` | `src/topic-proposal/suggestion-ops.js` | TOPIC_SUGGESTION_DISMISSED | standard |
| MCP `write_event` | `silo-mcp/server.js` (via `silo write` subprocess) | write_event | standard (inherits from CLI) |
| MCP `accept_suggestion` | `silo-mcp/server.js` (via `silo suggest --accept` subprocess) | (same batch as above) | standard (inherits from CLI) |
| MCP `dismiss_suggestion` | `silo-mcp/server.js` (via `silo suggest --dismiss` subprocess) | TOPIC_SUGGESTION_DISMISSED | standard (inherits from CLI) |
| `silo import-jarvis` (topic body) | `src/import-jarvis/index.js` | TOPIC_METADATA_SET, write_event, TOPIC_VERIFIED, TOPIC_CURATED | standard |
| `silo import-jarvis` (sensitive topic seal) | `src/import-jarvis/index.js` line ~310 | ACL_SEALED | **admin** |
| `silo import-jarvis` (event-log lines) | `src/import-jarvis/events.js` | write_event | standard |
| (test fixtures + bench) | `test/*` | various | varies — set per test intent |

**Important caller pattern note**: silo-mcp routes through `silo write` / `silo suggest` subprocesses (see `silo-mcp/server.js` write_event impl). That means MCP callers do NOT pass `socket` directly to LogWriter — the CLI layer does. MCP server-side changes for M3 are zero LOC; CLI is the seam.

The only call site that mixes sockets in a single execution is `silo import-jarvis`. ACL_SEALED needs admin; everything else needs standard. The implementation should make this explicit per `writer.append` call rather than running the whole import in admin mode.

---

## 5. Error semantics

### 5.1 CLI surface

`silo init` — running against a fresh silo dir is admin-bootstrap; no admission failure expected. If admission fails (e.g., re-init attempted), the existing "already has N entries; refusing to reinit" check covers it.

`silo write`, `silo curate`, `silo suggest` — all use socket='standard'. Admission failure here means the matrix says the event type isn't standard-admissible. Today no standard-write path emits an admin-only event, so admission failure indicates a bug — surface as `silo: admission gate refused: <code> for type=<type>` and exit 1.

`silo import-jarvis` — admission failure on ACL_SEALED in particular would mean the matrix changed without updating the import. Surface error, exit 1.

### 5.2 MCP surface

MCP tools route through CLI subprocesses; admission failures propagate as non-zero subprocess exits. The existing error-mapping in `silo-mcp/server.js` already converts subprocess stderr into MCP error envelopes. Add `ADMISSION_REFUSED` to the structured error code regex on `silo suggest --accept` / `--dismiss` error paths (current regex captures `SuggestionOpError code`).

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
11. **Admission runs BEFORE payload validation.** Send a malformed-payload ACL_SEALED on standard: error is `EVENT_NOT_ADMISSIBLE`, not a payload-shape error. Order matters — admission first means callers don't get payload feedback for events they were never allowed to emit.

### 6.2 Spec invariant test

`test/matrix-coverage.test.js` (new):

For every event type in matrix.yaml, assert that at least one positive admission case exists in the test suite. Implementation: at suite end, the matrix gate records every `(type, socket)` pair it admitted across all tests. The final test compares against `matrix.listTypes()` to flag any type the test suite never positively admits.

This is a meta-test that catches "added a new event type but forgot to test admission for it" regressions.

### 6.3 Integration tests

`test/cli-init.test.js` (extend existing): assert `silo init` events all carry socket='admin' internally — write a one-event-at-a-time call sequence with admission spy.

`test/cli-suggest.test.js` (extend existing): assert `silo suggest --accept` batch passes socket='standard' for both TOPIC_METADATA_SET + TOPIC_SUGGESTION_ACCEPTED.

`test/import-jarvis.test.js` (extend): import a topic with `sensitivity: 'private'`, assert the ACL_SEALED entry was emitted on admin and the rest on standard.

### 6.4 Backwards-compat sanity

Run the existing full suite. No test that doesn't explicitly use admin-only event types should change behavior (since standard is the default). Expect 476/476 still passing after M3 plus the new admission-gate tests.

---

## 7. Acceptance criteria

Implementation considered complete when:

- `LogWriter.append` and `batchAppend` accept optional per-entry `socket` (defaulting to `'standard'`).
- `_appendBatchUnlocked` calls `Matrix.isAdmissible(type, socket, 'normal')` for every entry BEFORE payload validation; rejects the batch on first failure.
- Unknown types throw `AdmissionError('UNKNOWN_EVENT_TYPE_NOT_REGISTERED')`.
- `silo init` passes `socket: 'admin'` for all three identity events.
- `silo import-jarvis` passes `socket: 'admin'` only for the ACL_SEALED line; everything else stays standard.
- All other call sites stay implicit (default to `'standard'`).
- New `test/log-admission-gate.test.js` covers the 11 scenarios in §6.1.
- `test/matrix-coverage.test.js` asserts every matrix type has at least one positive admission case.
- Full suite green: existing 476 + new tests, no regressions.
- README threat-model section updated: M3 moves from "roadmap" to "enforced" (footnote, not a separate commit).
- Memory event under `jarvis-claw` slug when M3 ships.

---

## 8. Risks

### 8.1 RECOVERY_ACCEPTED / RECOVERY_REPUDIATED gating

Matrix says these are admin-N in normal mode (admissible only in recovery mode). M3 implements only `mode='normal'`, so the writer would reject them on admin socket too. That's correct per the matrix — these events should never appear outside recovery mode. But there's currently no code path emitting them anyway, so the rejection has no observable consequence today.

**Open question for audit**: do we treat this as "matrix says no in normal mode, so writer rejects" (strict), or "M3 only gates by socket, mode comes later" (lenient)? Strict is safer; lenient delays a hard-coded check that will need to be removed when modes land. **Recommend strict.**

### 8.2 Test fixtures may rely on emitting matrix-N events on the default socket

Any existing test that constructs a writer and emits an admin event using default-socket-standard will start failing. Audit task: scan `test/**` for such cases pre-implementation. Spot check: `test/admission-2.2.test.js`, `test/log-foundation.test.js`, `test/topic-proposal-*` — none emit admin events, but bootstrap fixtures might. Inspection during implementation will surface any.

### 8.3 Performance

Matrix lookup is a map access (`O(1)`) — no measurable overhead. The existing payload validation is already heavier (regex, length checks). M3 adds zero noticeable cost.

### 8.4 Future broker-mode wiring

Mode is reserved but not honored in M3. When broker modes land:

- `install_freeze` — set during install transaction.
- `read_only` — set when broker enters degraded mode (e.g., disk full).
- `recovery` — set when broker enters recovery mode.

Each of these requires (a) a mechanism to transition into the mode, (b) a way to surface "current mode" to the writer, and (c) tests for the mode transitions. M3 leaves the `mode` parameter docs to flag it as reserved; the writer's hardcoded `mode='normal'` is the seam to be removed.

---

## 9. Out of scope

- **Broker mode transitions** (install_freeze, read_only, recovery). Documented as reserved; implementation is a separate milestone.
- **Per-principal authorization** (OAuth, per-user tokens). Multi-principal admission needs a `principal_class` dimension that the matrix doesn't currently have. Separate from M3.
- **REGISTER_EVENT_TYPE flow.** v12.5 spec allows dynamic event-type registration via this meta event. M3 keeps unknown types rejected; the registration path is M4+ work.
- **Matrix-yaml-driven payload schema generation.** Today payload validators are hand-coded in `src/admission/payload-validators.js`. Generating them from matrix.yaml metadata is a refactor, not an admission-gate concern.
- **Per-socket flock / process-level isolation.** Different sockets sharing the same writer process is fine; M3 doesn't fork the writer.

---

## 10. Implementation order

After audit ratification:

1. **AdmissionError class + matrix integration.** Add `src/log/admission-error.js`. Edit `_appendBatchUnlocked` to call the oracle + throw `AdmissionError`. Run `test/log-admission-gate.test.js` (failing initially) — tests drive the implementation.
2. **Call-site updates.** `silo init` (admin), `silo import-jarvis` (admin only on ACL_SEALED line). Confirm no other call site needs admin.
3. **Matrix coverage test.** Add `test/matrix-coverage.test.js` — should pass once all event types are exercised by §6.1 + existing tests.
4. **README threat-model update.** Move M3 from "roadmap" to "enforced" in the same commit as call-site changes (one shipped surface, one doc update).
5. **Deploy.** No silo-mcp changes; deploy via `cd /root/silo && git pull` only.
6. **Memory event.** `[CHANGED] jarvis-claw: M3 admission gate enforced...` per the per-ship pattern.

Per Helder's anti-bundling: implementation is ~4-5 commits — admission gate + tests in one, each call-site adjustment in its own, doc update in its own.

---

## 11. Audit charter

This is a DRAFT spec sent for audit before implementation. The intent of the audit:

- **ChatGPT round 1**: high-level review. Does the design make sense? Is the writer-level seam the right place to enforce? Are the error codes meaningfully different from payload-validation errors? Are the §8 risks fully enumerated?
- **Gemini round 1**: nitpick review. Are there call sites I missed? Are the matrix tables in §2 + §4 internally consistent with matrix.yaml as it stands today? Are there edge cases in the §6 test plan that would slip through?
- **Pre-flight internal**: re-read with fresh eyes, look for "I wrote this 30 minutes ago and missed X" gaps.

Findings get folded inline; the status line at the top updates from "DRAFT — pending audit round 1" to "Implementation-ready" once findings are addressed. If round 1 surfaces something structural (e.g., "the seam should be one layer up, not in `_appendBatchUnlocked`"), round 2 is on the table — but the goal is to ratify in one round given the scope.

Phase 2.2 needed 5 rounds because it was 2,800 LOC with subtle race conditions. M3 is ~150-200 LOC of wiring an already-spec'd oracle. One round should suffice.

---

*End of draft. After audit round 1 lands, this file's status line + any folded changes update in place; no separate -v2 or -FINAL filename.*
