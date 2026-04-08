# Silo — Claude Code Setup

Set up Silo as the memory system for Claude Code projects. This gives you
structured, persistent knowledge across sessions — organized by topic, with
changelogs and search.

**Time:** ~15 minutes
**Prerequisites:** Claude Code CLI installed

---

## How this differs from OpenClaw

Claude Code doesn't have:
- Built-in cron jobs (no automated pipelines)
- Session transcript exports (no automated extraction)
- A `projectContext` config (but `CLAUDE.md` auto-loads from the project root)

What it DOES have:
- `CLAUDE.md` auto-loading (equivalent to AGENTS.md + topic index)
- Full filesystem read/write access
- The ability to run scripts via Bash
- Hooks (pre/post command execution)

Silo in Claude Code is **the same architecture, manually triggered.** You
get topic files, event logs, changelogs, and search — but curation happens when
you ask for it, not on a schedule.

---

## Step 1 — Create the directory structure

In your project root:

```
mkdir -p topics events knowledge
```

## Step 2 — Create CLAUDE.md

Claude Code auto-loads `CLAUDE.md` from the project root. This is your combined
operating rules + topic index + curation protocol.

Copy `quickstart/claude-code/CLAUDE.md` from this repo to your project root.
Edit it to match your project.

The file has three sections:
1. **Identity and rules** — Who you are, how the assistant should behave
2. **Topic index** — One-line per topic file (updated manually or by asking
   the assistant to regenerate it)
3. **Curation protocol** — What to do when you say "save"

## Step 3 — Create TEMPLATE.md

Copy `quickstart/openclaw/TEMPLATE.md` to your project root. This is the
template for new topic files.

## Step 4 — Create your first topic file

```bash
cp TEMPLATE.md topics/my-project.md
```

Edit it: fill in the header, remove instruction comments, add initial facts.

## Step 5 — Start using it

In your Claude Code session:

**To load a topic:**
> "Open the CRM topic file"

The assistant reads `topics/crm.md` Layers 1+2 (never Layer 3 directly).

**To save a conversation excerpt:**
> "Remember this"

The assistant saves to the open topic file's Layer 3.

**To log a fact or decision:**
> "Log this: we decided to use Flask for the backend"

The assistant writes to `events/YYYY-MM-DD.md`.

**To search memory:**
> "Search memory for WhatsApp integration"

The assistant uses Grep on topic files and event logs.

**To create a new topic:**
> "Create a topic file for the workshop"

The assistant copies TEMPLATE.md, fills in the header, and updates the topic
index in CLAUDE.md.

**To end a session:**
> "Save"

The assistant updates CLAUDE.md's current state and logs a session summary.

---

## Automating extraction (optional)

Claude Code doesn't have cron, but you can:

1. **Use hooks:** Configure a post-session hook that calls an extraction script.
   See Claude Code's hooks documentation.

2. **Manual curation:** Periodically ask the assistant: "Review the event log
   from the last week and promote any important facts to topic files."

3. **External cron:** If your machine has cron/Task Scheduler, run an extraction
   script against Claude Code's session files on a schedule.

---

## What you get vs OpenClaw

| Feature | Claude Code | OpenClaw |
|---------|-------------|----------|
| Topic files with 3 layers | Yes | Yes |
| Event log with tags | Yes | Yes |
| Search (keyword) | Yes (Grep) | Yes (BM25) |
| Search (semantic) | No (unless you add it) | Yes (Gemini/OpenAI) |
| Auto-extraction | Manual or hooks | Automated (cron) |
| Nightly curation | Manual | Automated (cron) |
| Topic suggestion | Manual | Automated (nightly) |
| Auto-load at startup | CLAUDE.md | projectContext |
| Context budget | Same (~5-8 KB) | Same (~5-8 KB) |
