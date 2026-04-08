# Silo — Agent Rules

> This file is auto-loaded every session. Keep it under 3 KB.
> For the full architecture, read MEMORY-SYSTEM.md.

---

## Rule 1 — Startup

Your context already contains: this file, TOPIC-INDEX.md, and today's event log.
Do NOT load anything else until the user's first message tells you what's needed.

## Rule 2 — Topic Loading

**Default: explicit.** User says which topics to open. You load Layers 1+2 only (never Layer 3).

If conversation touches a topic that isn't loaded, **suggest** it:
"That touches the [topic] file. Want me to pull it up?"
Do NOT auto-load. Wait for confirmation.

## Rule 3 — Event Log

Write structured one-liners to `events/YYYY-MM-DD.md` as the session progresses.

**Format:** `[TAG] topic-slug: Content with enough context to stand alone.`

**Tags:** FACT, DECISION, CHANGED, PROCEDURE, TODO, EVENT

**Slug** must match a topic from TOPIC-INDEX.md. If unsure, use `general`.

**"Enough context" means:** someone reading only this line, months later, understands what happened and why.

## Rule 4 — "Remember This"

When the user says "remember this" or similar:
1. Save to the open topic file's Layer 3 with mini-header format
2. New entries go at the top of Layer 3
3. Confirm which file you saved to
4. If no topic file is open, write to the event log instead

## Rule 5 — Knowledge Updates

When a fact changes in a loaded topic file:
1. Update Layer 2 **in place**
2. Add changelog entry: `- YYYY-MM-DD: [field] new value. Was: old value. Reason.`
3. Write a `[CHANGED]` entry to the event log

## Rule 6 — Search Hierarchy

1. Current context (free)
2. TOPIC-INDEX.md — scan for relevant files (free)
3. Loaded topic file Layer 2 (free)
4. Today's event log (free)
5. BM25 keyword search (free)
6. Semantic search (~1-3c/query)
7. Ask one clarifying question

Never jump to step 6 without trying step 5 first.

## Rule 7 — What You Must NOT Do

- **Never read Layer 3 directly.** Use search tools.
- **Never auto-load topic files.** Suggest and wait.
- **Never run curation tasks.** Scripts handle curation.
- **Never modify TOPIC-INDEX.md.** It's auto-generated.
- **Never set `last_curated`, `curated_lines`, `source_lines`, or `source_kb`.** Scripts own these.

## Rule 8 — Session End

Before a session ends: if you produced something meaningful and wrote no event log entries, that's a memory leak. Write at least one entry summarizing what happened.
