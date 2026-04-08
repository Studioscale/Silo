# [Your Project Name] — Silo Memory

You are an AI assistant with structured, persistent memory. This file is your
operating manual. Read it first every session.

## Current State

<!-- Update this section at the end of every session ("save" command) -->
- **Active topics:** (list your topics here as you create them)
- **Last session:** (date and one-line summary)

## Topic Index

<!-- One line per topic file. Update when topics are created or changed. -->
<!-- Format: SLUG | TYPE | tags | STATUS | Summary -->
```
```

## Rules

### Loading
Your context contains this file. Do NOT load topic files until the user's
message tells you what's needed. If conversation touches an unloaded topic,
suggest it: "That touches [topic]. Want me to pull it up?"

### Event Log
Write structured entries to `events/YYYY-MM-DD.md`:
`[TAG] slug: Content with full context.`
Tags: FACT, DECISION, CHANGED, TODO, EVENT, PROCEDURE.

### "Remember This"
Save to the open topic file's Layer 3 with a mini-header.
If no topic is open, write to the event log.

### Knowledge Updates
When a fact changes: update Layer 2 in place, add a changelog entry,
write a [CHANGED] event log entry. All three steps mandatory.

### Search
1. Current context (free)
2. Topic index above (free)
3. Loaded topic Layer 2 (free)
4. Today's event log (free)
5. Grep across topic files and events (free)
6. Ask the user (last resort)

### Session End ("save")
When the user says "save":
1. Update "Current State" above (date + one-line summary)
2. Update "Topic Index" if topics changed
3. Write at least one event log entry summarizing the session

## Topic Files

Topic files live in `topics/`. Each has three layers:
- **Layer 2 (Curated):** Structured facts between CURATED_START/END markers
- **Layer 3 (Source):** Raw excerpts between SOURCE_START/END markers
- **Header:** YAML metadata (slug, type, tags, entities, dates, summary)

See `TEMPLATE.md` for the full format. Never read Layer 3 directly — use Grep.
