# Silo Proposals — Implementation-Ready Specs

This folder contains implementation specs that have been audit-validated and are queued for implementation. Each spec is self-contained — no external history-reading required.

## Currently queued

| Spec | Scope | LOC est. | Sessions est. | Audit posture |
|---|---|---|---|---|
| `phase-2.2-FINAL.md` | Topic proposal (auto-detect + MCP-surfaced + one-call accept) | ~2,800 | 9-13 | 5 external rounds + 2 pre-flight passes; ratified |
| `phase-2.3-FINAL.md` | Update notification (auto-check GitHub + MCP-surfaced) | ~260 | 1-2 | 1 pre-flight + 1 external round; ratified |

## Implementation order

Phase 2.2 first, then Phase 2.3. (Numerical order — Helder's preference. Phase 2.3 needs Phase 2.2's `_silo_notices` array in code.)

## How to implement

Open a Claude Code session in this workspace. Tell the session:

> "Implement Phase 2.2 per `proposals/phase-2.2-FINAL.md`. Follow the §15 implementation order — start with foundation layer (LogWriter changes)."

The spec has acceptance criteria (§14) that each implementation step must satisfy. No need to read the audit history unless something is unclear — the spec inlines all decisions.

## Audit charter

`phase-2.2-audit-packet.md` is the original audit charter used during the design phase. Useful reference if future features need similar audit cycles.

## Full audit history

Preserved at `../../silo-design-history/` (sibling folder, outside this repo) — keeps this repo clean for open-source distribution while preserving traceability for the design decisions.
