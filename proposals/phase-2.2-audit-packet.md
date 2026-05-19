# Silo Phase 2.2 Audit Packet — Topic Proposal

**Author**: desktop-claude (Silo-only session)
**Date**: 2026-05-15
**Status**: Pre-implementation. NO code has been written. The design proposal exists at `phase-2.2-design-proposal.md` in this directory.
**Audience**: Three independent reviewers — Gemini, ChatGPT, fresh Claude. Mirror of the Phase 2 / Phase 2.1 / Phase 3 review process.
**Goal**: Surface design errors, missing requirements, security/correctness gaps, UX problems, and viable alternatives BEFORE any code is written.

---

## 0. How to audit

You are reviewing a NOT-YET-IMPLEMENTED design. Your job is NOT to find bugs in code (there is none). Your job is to find:

1. **Design errors.** Things the proposal got wrong about how Silo currently works, what users want, or what's technically feasible.
2. **Missing requirements.** Cases the proposal doesn't handle. Failure modes not addressed.
3. **Security / correctness gaps.** Append-only log invariants, hash chain integrity, admission validation, single-writer model — does Phase 2.2 preserve them?
4. **UX problems.** The "MCP-surfaces-via-tool-footer" UX is novel. Does it actually work? Will the LLM cooperate? Will users hate the footer?
5. **Better alternatives.** A simpler design that achieves the same outcome.
6. **Out-of-scope concerns that should be in-scope.** The proposal defers event reassignment, scan-other-slugs, auto-expire — which of these should actually be in v1?
7. **Calibration on the §11 audit questions in the design proposal.** Sixteen specific open questions are listed. Opine on each.

Deliver findings in the format in §6 of this packet.

---

## 1. Audit scope

**In scope:**
- The design proposal `phase-2.2-design-proposal.md` (§1-§12)
- Interaction with existing Silo primitives (admission validator, interpret, regenerate, MCP server)
- New event type semantics (TOPIC_SUGGESTED, TOPIC_SUGGESTION_ACCEPTED, TOPIC_SUGGESTION_DISMISSED)
- MCP tool surface (list / accept / dismiss + side-channel footer)
- UX viability (will the LLM cooperate? will users adopt it?)

**Out of scope:**
- Phase 3 (`silo dream`) — deferred
- Phase 2.3 (full matrix admission gate) — separate audit when its time comes
- Cross-topic synthesis
- Multi-principal T2 semantics
- Anything not directly related to topic proposal

---

## 2. Required reading

Before forming opinions, read these in order:

**Primary:**
1. `proposals/phase-2.2-design-proposal.md` — the design under audit
2. `proposals/phase-3-design-proposal.md` — for context on what was deferred and why
3. `proposals/phase-2-audit-packet.md` — for the audit precedent + Phase 2.1 hardening context (§0 + §8 + §9 are most relevant)

**Silo source (current state, must read to ground audit):**
4. `src/matrix/matrix.yaml` — admission oracle, including the existing `TOPIC_BULLETS_RETIRED` registration as the template for the 3 new event types
5. `src/admission/payload-validators.js` — Phase 2.1 admission validator. Phase 2.2 must extend this for 3 new payload schemas
6. `src/interpret/state.js` + `src/interpret/index.js` — state structure + per-event-type case handlers
7. `src/projection/regenerate-topic-file.js` — how topic files are projected from state
8. `src/projection/regenerate-topic-index.js` — how TOPIC-INDEX is regenerated
9. `src/distill/distill.js:44` — the line that hardcodes "use existing slug or `general`"
10. `silo-mcp/server.js` on the VPS (path: `/root/silo-mcp/server.js`) — MCP server. Phase 2.2 adds 3 new tools and modifies read-tool responses

**Operational context:**
11. `silo-curate.sh` on VPS (cron wrapper for daily curate; Phase 2.2's detection job will mirror this pattern)
12. `~/.claude/CLAUDE.md` global rules for Helder's deployment (rule #6 + rule #7 — context for how desktop-claude uses Silo)

---

## 3. Background context for reviewers

### 3.1 What problem are we solving?

Silo has no in-band mechanism to propose new topics. Standalone Silo users (no Jarvis-equivalent external pipeline) accumulate events in `general` indefinitely, with no signal to create new topics. Users will not manually run `silo suggest` (a previous design iteration was rejected on that ground).

Phase 2.2 closes the gap by:
- Automatic server-side detection (cron)
- Persistent pending suggestions in the operation log (3 new event types)
- Surfacing via MCP side-channel (footer on read-tool responses) so the consumer LLM sees pending counts naturally
- One MCP tool call to accept (creates topic file as interpret() side effect)
- One MCP tool call to dismiss (with cooldown)

### 3.2 Why this design over alternatives?

| Alternative | Why rejected |
|---|---|
| Manual `silo suggest` CLI | User won't remember to run it. Won't survive contact with real usage. |
| Silo auto-creates topics without confirmation | Conflicts with "user holds the pen" principle. TOPIC-INDEX changes silently. Bad slug names cement themselves. |
| Per-user CLAUDE.md rule telling LLM to check pending suggestions at session start | Doesn't work for standalone Silo users (vanilla Claude Code, no custom rules) |
| Fold into Phase 3 (`silo dream`) | Phase 3 is deferred indefinitely. Phase 2.2 must work without Phase 3 ever shipping. |

### 3.3 Silo invariants that MUST hold post-Phase-2.2

(Listed for reviewer convenience; reject any design choice that breaks these.)

1. **Append-only log.** Events are never deleted or rewritten. Hash chain integrity preserved.
2. **JCS canonical hashing.** Unknown payload fields rejected at admission (Phase 2.1 invariant).
3. **`interpret()` totality.** Every state-bearing event type has a defined case handler.
4. **Registry-authoritative `is_state_bearing`.** `matrix.yaml` is the source of truth.
5. **Single-writer model.** Operation log writes are serialized through one writer.
6. **Admission validation BEFORE canonicalization.** Bad payloads never land in the log.
7. **Silo never silently changes user state.** Every state change has a log event.

Phase 2.2's `TOPIC_SUGGESTION_ACCEPTED` creates a new topic file as a side effect of `interpret()`. This is a new pattern (previously, topic files were only created by `silo init` or manual hand-editing). Audit input on whether this fits cleanly.

---

## 4. Specific audit questions

Organized into seven categories. Reviewers should opine on each. Brief answers OK; "neutral" / "no opinion" valid where applicable.

### 4.1 Architecture

A1. Is the 4-component architecture (detection / surfacing / acceptance / dismissal) the right decomposition? Better alternatives?

A2. Should detection live in a new module (`src/topic-proposal/`) or be folded into existing curation code (`src/cli/silo.js cmdCurate`)?

A3. Server-side cron vs event-triggered detection (Q1 in design proposal): which is right for v1?

A4. The "side-channel footer in MCP read tool responses" is novel. Will the LLM actually cooperate (mention it to the user once, not every turn)? Will it work across different LLM hosts (Claude Code, Claude Desktop, OpenClaw, other MCP clients)?

A5. Is appending a footer to tool response text the right surfacing mechanism, or should we use MCP "resources" or "prompts" primitives instead?

### 4.2 Event types and state

E1. Are three new event types correct, or could we collapse to fewer (e.g., one `TOPIC_PROPOSAL` event with a `state` field)?

E2. `TOPIC_SUGGESTION_ACCEPTED` creates a new topic file as a side effect of `interpret()`. Is this consistent with how other side-effect-bearing events work today? Or does it warrant a new permission class?

E3. The `supporting_seqs` field on `TOPIC_SUGGESTED` must validate against actual log entries at WRITE time. What happens if those seqs are retired/invalidated later, before accept? Should accept re-validate?

E4. Should pending suggestions auto-expire (`TOPIC_SUGGESTION_EXPIRED` event) after N days unattended? Design proposal Q5 leaves this open.

E5. Should `TOPIC_VERIFIED` (Phase 1 mechanism) be extended to verify suggestions the same way it verifies bullets?

### 4.3 MCP surface

M1. Three new tools (`list`, `accept`, `dismiss`). Is this the right surface, or should `dismiss` accept multiple seqs in one call?

M2. `accept_suggestion` allows user override of `slug`, `name`, `type`, `tags`. Should `description` be overridable too? Or pre-fixed from the suggestion?

M3. Side-channel footer: appears on `read_index`, `read_events`, `get_topic`, `search`, `list_handoffs` — NOT on write tools (`write_event`, `write_handoff`). Right cut?

M4. The footer text `[silo] N pending topic suggestion(s). Use list_pending_suggestions to review.` — does it surface the right amount of info? Does it bias the LLM toward mentioning it appropriately?

M5. Should the MCP server enforce auth on `accept_suggestion` differently (e.g., higher privilege than `write_event`)? Or is bearer-token-only sufficient?

### 4.4 Detection logic

D1. Default thresholds: `--min-events=3`, `--days-back=30`, `--max-suggestions-per-run=3`. Are these right? Should they be tuned per Silo's volume?

D2. Anti-hallucination: validate every cited supporting seq exists in the scanned window. Is this sufficient? Other hallucination vectors?

D3. Anti-fragmentation: system prompt asks LLM to prefer broader topics. Is this enough? What other safeguards?

D4. Should detection scan non-`general` slugs for subdivision candidates? Design proposal Q8 defers. Should v1 include this?

D5. What if the LLM's proposed slug collides with a slug already in dismissal cooldown? Reject at detection time, or include with a "previously dismissed" flag?

### 4.5 UX

U1. The Rover example walkthrough (§6 of design proposal). Realistic? Where does the user experience break?

U2. What happens if pending suggestions pile up (10+)? Cap of 10 in design proposal. Should new detection runs warn or auto-dismiss-oldest?

U3. What if the user wants to defer (neither accept nor dismiss)? Currently: do nothing, surface again next session. Right behavior?

U4. What if the LLM hallucinates an `accept_suggestion` call referencing a non-existent or already-retired suggestion_seq? Server rejects. But the LLM may not surface the error clearly. Audit input on error UX.

U5. First-time-user experience: fresh Silo install, no events yet. How does the user know `silo suggest`-style functionality exists? Discoverability?

### 4.6 Operational

O1. Detection cron failure modes: if the cron job fails repeatedly (LLM down, API key invalid), how does the user find out? Today's silo-curate cron fails silently. Should Phase 2.2 surface this differently?

O2. Cost: daily LLM scan of `general` events. Bounded by `--max-input-tokens=50000`. Realistic cost estimate for a real deployment?

O3. Rollback path: if Phase 2.2 ships and turns out wrong, how do we roll back? (Log events are append-only; we can't delete them. But we can stop emitting new ones and ignore old ones.) Acceptable, or do we need a feature flag?

O4. Concurrency: detection cron emitting `TOPIC_SUGGESTED` while user (via MCP) calls `accept_suggestion`. Single-writer model handles this — confirm.

O5. Migration: existing Silo deployments (Helder's HS Precisão) have months of `general` events. First Phase 2.2 detection run could surface many suggestions at once. Strategy?

### 4.7 Topic file creation

T1. The topic file template in design proposal §5.4 has empty Layer 2. First `silo curate` populates it. Should v1 seed Layer 2 with an initial bullet derived from the LLM rationale + supporting events?

T2. `silo curate` currently scans events under a topic's slug to build Layer 2. For a brand-new topic, all supporting events are in `general`. Does `curate` need cross-slug support, or does the system wait for new events under the new slug?

T3. Should the topic file include a comment block linking back to supporting seqs (audit trail of where this topic came from)?

T4. Slug regex: enforced at detection AND at accept (in case user overrides)? Or only at detection?

T5. What if the user accepts with override slug that collides with a slug now in dismissal cooldown? Reject?

---

## 5. Risks I want reviewer eyes on specifically

Calibration: these are the risks I (the author) think matter most. Reviewers may disagree on weighting.

1. **LLM cooperation with the MCP footer is empirical, not provable.** The whole UX hinges on the LLM seeing `[silo] 1 pending topic suggestion` in tool output and mentioning it. If the LLM ignores it or mentions it every turn, the UX falls apart. I don't have hard evidence either way. *Need reviewers' calibration: have you seen similar MCP-surface patterns work in practice?*

2. **`TOPIC_SUGGESTION_ACCEPTED` as topic-file-creator is a new pattern.** Previously, every "create topic" was a manual operation. Phase 2.2 makes it an interpret() side effect. *Are there hidden gotchas with this pattern? E.g., what if regen happens BEFORE the topic file write completes? Race conditions? Crash recovery?*

3. **Detection cron is single-writer assumption.** If the cron job crashes mid-run (after writing some `TOPIC_SUGGESTED` events but before completing the batch), is the state consistent? *I think yes (each event is atomic), but want confirmation.*

4. **The "supporting events stay in general" deferral.** v1 leaves historical events behind. *Is this a real UX problem or just an aesthetic one? Will users get angry that their accepted topic doesn't have its events?*

5. **Cooldown semantics under slug re-use.** User dismisses `pets` → 90-day cooldown → user later DECIDES they want `pets` and types it manually. The cooldown still applies to AUTO-PROPOSAL but should not block manual creation. *Audit input on whether dismissed slug rules need to gate manual creation too.*

6. **Discoverability for first-time users.** Phase 2.2 is invisible until the first suggestion is surfaced. Until then, the user has no idea Silo has this capability. *Should the README explicitly call this out? Should the first `silo init` print a hint?*

7. **`silo curate` interaction.** When `silo curate` runs on a brand-new topic created via accept, what does it see? The topic file's Layer 2 is empty; supporting events are in `general`. *Does curate skip or does it need to be taught to look up the supporting seqs from the original suggestion?*

---

## 6. Output format expected from reviewers

Each reviewer should produce a single markdown file named:
- `phase-2.2-fix-proposals-gemini.md`
- `phase-2.2-fix-proposals-chatgpt.md`
- `phase-2.2-fix-proposals-claude.md`

Mirroring the Phase 2 / Phase 2.1 precedent. Structure:

```markdown
# Phase 2.2 Audit — [Reviewer Name]

## Findings

### F1 — [Severity: Critical / Major / Minor / Question] — [One-line title]
**Category**: [Architecture / Events / MCP / Detection / UX / Operational / Topic File / Other]
**What**: [Specific problem or concern]
**Why it matters**: [Impact if unaddressed]
**Proposed fix**: [Concrete remediation. "Defer to Phase 3" / "Add this validator" / "Reject this approach because X" / etc.]
**Alternative**: [If applicable]

### F2 — ...

## Answers to §4 audit questions

A1: [Your opinion]
A2: ...
[answer all 4.1-4.7 questions or mark "no opinion"]

## Answers to §5 risk calibration

R1: [Your calibration: low/medium/high + brief rationale]
R2: ...

## Recommended scope changes (if any)

- [Things you think should move from "deferred to v2" to "must be in v1"]
- [Things you think should move from "in v1" to "deferred"]

## Overall verdict

[ ] Approve as-is
[ ] Approve with minor changes (list them)
[ ] Significant revision needed — do not implement until addressed
[ ] Reject — fundamental design problem (explain)
```

---

## 7. How to deliver

Each reviewer saves their `phase-2.2-fix-proposals-*.md` to `proposals/` in this workspace. desktop-claude then synthesizes a trimmed v1 spec accepting / rejecting / deferring each finding with rationale, posts the synthesis for confirmation, and only then begins implementation on `github.com/Studioscale/Silo`.

---

## 8. Audit baseline

- Test count at start of Phase 2.2 work: **183/183 passing**
- Silo tag at start: **`phase-2.1-hardening`**
- Repository: `github.com/Studioscale/Silo`
- Bake state: Phase 2.1 shipped 2026-05-10; this packet circulates 2026-05-15 (5 days in; full bake = 1-2 weeks per `project_silo_dreaming_plan.md`). No false-positive admission validator rejections surfaced in production yet.

Expected post-Phase-2.2:
- Test count: 198-208 (+15-25 new tests per design proposal §12)
- New tag: `phase-2.2-topic-proposal`
- Anthropic API cost delta: ~$0.50-1.50/day for detection (in addition to existing ~$2/day for curate)

---

## 9. Out-of-scope reminders for reviewers

Do not opine on:
- Whether Phase 3 (`silo dream`) should be revived
- Whether the Anthropic-vs-OpenAI choice for the detector should change (use whatever the existing factory picks)
- Whether Silo should adopt vector embeddings (settled "no" in `project_byterover_comparison.md`)
- Multi-user T2 semantics
- ATS framework alignment (separate work track)

Stay focused on the design under audit. Tangents waste reviewer time and dilute findings.

---

*End of audit packet. Once reviewers respond, desktop-claude synthesizes findings into a trimmed v1 implementation spec.*
