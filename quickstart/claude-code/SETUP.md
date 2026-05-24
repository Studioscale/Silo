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

## Recommended: catch-up directive for the Silo MCP bridge

> Only relevant if you've installed Silo's MCP bridge (so Claude Code can call
> `mcp__silo__write_event` over MCP). If you're using the project-local
> file-based pattern only, skip this section.

If you've wired Silo's MCP bridge into Claude Code, you can add a **catch-up
directive** to your global `~/.claude/CLAUDE.md`. The pattern: you say a phrase
like "save to silo" or "catch up silo" and the assistant retrospectively scans
the conversation, writes any silo-worthy events it finds via `write_event`,
acknowledges inline, and continues — all without asking which items to save.

Two main uses:
- **Safety net** — catches things you (or the assistant) forgot to log
  in-the-moment via the proactive `write_event` discipline.
- **Cross-instance sync** — if you run parallel Claude Code instances against
  the same project (one for the database, one for the UI, one for debugging),
  saying "save to silo" before switching instances keeps them in sync. The
  next instance reads what the first one decided.

### Installation

Paste the rule below into your global `~/.claude/CLAUDE.md` (the user-level
one in your home directory, not a project-local one):

````markdown
**Catch-up directive — batch-save without asking.**

This is how parallel Claude Code instances stay in sync. When the user
makes a decision in one instance and switches to another, they say
"save to silo" so the next instance reads the decision just made. Treat
catch-up as active cross-instance coordination, not just a safety net
for later sessions. Latency matters; the user is mid-context-switch.

**Trigger shape.** Any user message that names silo AND signals a sweep
over past conversation. Common phrasings:
- "save to silo" / "save everything to silo"
- "catch up silo"
- "silo everything"
- "don't forget to save everything to silo"
- "audit silo for this session"

Anchor on intent, not exact strings. "Make sure silo has everything we
discussed" triggers. "Snapshot silo before I close" triggers.

**Explicitly excluded**: the singular pattern "silo this: <content>" is
a single-item save with user-provided wording, NOT catch-up. If the user
provides a colon-delimited payload after "silo," write that one item
using exactly their wording, then stop.

**Do NOT** ask which candidates to save, offer a numbered list for
review, narrate progress, or treat catch-up as a separate exchange. The
user has already decided — execute the audit and continue with whatever
the conversation was about.

**Procedure:**

a. (No narration before the result) Call `mcp__silo__read_events` with
   `{ days_back: 2 }` to see what's logged in the last 48 hours. This
   covers cross-UTC-midnight sessions and is the dedup floor: any event
   from the last 48h with your configured principal is already-covered;
   don't re-log it.

b. (No narration) Scan the ENTIRE visible conversation for candidates —
   not just since your last `write_event` call. Rely on step (a)'s
   dedup floor plus the server's Jaccard ≥0.8 check to suppress re-logs.

   **If the conversation was compacted**: audit only what's still
   verbatim in context. Do NOT manufacture candidates from the
   compaction summary — the summary loses precision.

   Categories, in priority order:
   - **[CHANGED]** — corrections to earlier wrong silo events
     (highest priority — prevents error propagation)
   - **[DECISION]** — choices made between alternatives, ideally
     with rationale
   - **[FACT]** — durable truths (numbers, paths, conventions,
     discoveries, names, dates)
   - **[PROCEDURE]** — repeatable how-tos
   - **[TODO]** — open follow-ups noted but not done
   - **[EVENT]** — notable one-time occurrences

   Drop things stated but later reversed in the same session. Drop
   speculation that wasn't actually decided. Pick correct slug + tag
   + ≤500-char single-line content.

   **Cap**: aim for ≤15 events per catch-up. If a session legitimately
   has more, write the top 15 by priority and surface the overflow in
   the acknowledgment ("Saved 15; ~6 more candidates trimmed — ask if
   you want a deeper sweep").

c. (No narration) Call `mcp__silo__write_event` for each candidate,
   one per call. Handle rejections silently: duplicate detection
   (Jaccard ≥0.8) → skip; slug not in index → fall back to `general`;
   content >500 chars → split into multiple events OR trim to the
   essential observation.

d. Acknowledge inline in your normal next response — ONE short
   sentence, not a separate turn. Examples:
   - "Saved 5 events to silo. [continue with the actual response]"
   - "Nothing new to save since the last catch-up. [continue]"
   - "Saved 3 events, 2 skipped as duplicates. [continue]"

   **If the catch-up directive is the entire user message** (no
   other question to continue with), the one-sentence acknowledgment
   IS the full reply — that's not a violation of "not a separate
   turn"; it's just a short reply.

   **Exception — real errors are loud.** If `write_event` returns
   auth failure, MCP unreachable, or another non-recoverable error,
   surface it distinctly: "Silo MCP returned auth error — your token
   may have expired. Nothing was saved." Don't hide failure as success.

**Threshold guidance**: err generous on "is this a candidate?" False
positives are cheap (correctable later via [CHANGED]; silo's dedup
catches near-duplicates). False negatives are expensive — the whole
reason for this rule is that the autonomous threshold defaults too
conservative.
````

Restart your Claude Code session after saving for the rule to take effect.

### How to use it

In any Claude Code session connected to your Silo MCP bridge, say one of the
trigger phrases when you want a retrospective sweep:

- Before closing a session: *"catch up silo and let's wrap up"*
- Before switching to another instance: *"save to silo"*
- After making a meaningful decision: *"don't forget to save everything to silo"*

The assistant will scan the conversation, write events for everything
silo-worthy, acknowledge inline ("Saved N events to silo"), and continue.
No confirmation prompts, no list of what was saved — just done.

### What this doesn't replace

The catch-up directive is a complement to, not a replacement for, the
in-the-moment proactive `write_event` discipline (rule #6 in your CLAUDE.md
if you've installed Silo's recommended global rules). Keep saying "log this
fact" / "remember that decision" when you want events written immediately
with your exact wording. Catch-up is the periodic sweep for everything else.

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
