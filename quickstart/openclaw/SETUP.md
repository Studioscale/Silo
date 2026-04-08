# Silo — OpenClaw Setup

Set up Silo as the memory system for your OpenClaw instance. This replaces
the built-in MEMORY.md approach with structured topic files and automated pipelines.

**Time:** ~30 minutes
**Prerequisites:** OpenClaw running in Docker with exec tools enabled

---

## Step 1 — Create the directory structure

Inside your OpenClaw workspace (the directory mounted into the container):

```bash
mkdir -p topics events bin handoff/jarvis-to-cc handoff/cc-to-jarvis
```

## Step 2 — Copy the starter files

Copy these files from this repo's `quickstart/openclaw/` directory into your workspace root:

- `AGENTS.md` — Operating rules (auto-loaded via `projectContext`)
- `MEMORY-SYSTEM.md` — Full architecture reference (loaded on demand)
- `TEMPLATE.md` — Topic file template
- `TOPIC-INDEX.md` — Starter index (empty)

```bash
# From the host, copy into the mounted workspace directory
cp quickstart/openclaw/AGENTS.md /path/to/workspace/
cp quickstart/openclaw/MEMORY-SYSTEM.md /path/to/workspace/
cp quickstart/openclaw/TEMPLATE.md /path/to/workspace/
cp quickstart/openclaw/TOPIC-INDEX.md /path/to/workspace/

# Set ownership to match the container user
chown 1000:1000 /path/to/workspace/AGENTS.md
chown 1000:1000 /path/to/workspace/MEMORY-SYSTEM.md
chown 1000:1000 /path/to/workspace/TEMPLATE.md
chown 1000:1000 /path/to/workspace/TOPIC-INDEX.md
```

## Step 3 — Configure OpenClaw

Add to your `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "extraPaths": ["./topics", "./events"],
        "sync": { "watch": true },
        "hybrid": {
          "vectorWeight": 0.7,
          "textWeight": 0.3
        }
      },
      "projectContext": [
        { "path": "AGENTS.md", "autoLoad": true },
        { "path": "TOPIC-INDEX.md", "autoLoad": true }
      ]
    }
  }
}
```

This ensures:
- Topic files and event logs are indexed for search
- AGENTS.md and TOPIC-INDEX.md load automatically every session
- Hybrid search (BM25 + semantic) is enabled

## Step 4 — Create your first topic file

```bash
# Inside the container or via exec
cp TEMPLATE.md topics/my-project.md
```

Edit `topics/my-project.md`:
1. Fill in the header fields (topic, type, tags, entities, summary)
2. Remove the instruction comments from Layers 2 and 3
3. Add any initial facts to Layer 2

Then regenerate the topic index (you'll automate this later):

```bash
# Manual for now — the script will do this automatically
echo "my-project | project | tag1,tag2 | active | Short summary." > TOPIC-INDEX.md
```

## Step 5 — Set up the extraction script

Copy `scripts/session-extract.js` from this repo to your `bin/` directory. This
is a reference implementation — you will need to configure:

1. **API key:** Set your OpenAI API key in `bin/.curation-config`:
   ```
   OPENAI_API_KEY=sk-your-key-here
   ```

2. **Sessions directory:** Set `SESSIONS_DIR` to your OpenClaw sessions path
   (usually `/home/node/.openclaw/agents/main/sessions`)

3. **Make it executable:**
   ```bash
   chmod +x bin/session-extract.js
   chown 1000:1000 bin/session-extract.js
   ```

4. **Test it:**
   ```bash
   docker exec your-container node /path/to/workspace/bin/session-extract.js --dry-run
   ```

## Step 6 — Set up cron jobs

Inside the container:

```bash
# Session extraction — every 30 minutes
openclaw cron add --name "silo-extract" --every 30m \
  --message "Run session extraction: exec node bin/session-extract.js"

# Nightly curation — 2:00 AM (adjust timezone)
openclaw cron add --name "silo-curation" --every 24h \
  --message "Run curation: exec node bin/curation-runner.js"

# Verify
openclaw cron list
```

## Step 7 — Verify the setup

1. Have a conversation with your assistant
2. Mention a fact: "The project deadline is April 30th"
3. Say "remember this" — the assistant should save to the open topic file's Layer 3
4. End the session
5. Check the event log: `cat events/$(date +%Y-%m-%d).md`
6. You should see auto-extracted entries from the extraction script

## Step 8 — Set up additional scripts (optional)

See `scripts/` in this repo for reference implementations of:
- `topic-index-generator.js` — Regenerates the topic index from headers
- `file-validator.js` — Validates topic file structure
- `curation-preflight.js` — Identifies which files need curation
- `curation-runner.js` — Orchestrates the full curation pipeline
- `topic-suggest.js` — Detects general-slug clusters
- `migrate-topic.js` — Creates topic files from suggestions

These are reference implementations. Adapt paths, API keys, and error handling
for your environment.

---

## What to expect

- **First week:** You'll create 3-5 topic files for your main domains. The event log
  will start accumulating entries. The extraction script will produce [AUTO-*] entries.
- **First month:** The curation pipeline will be promoting facts from Layer 3 to Layer 2.
  Topic suggestions may surface if you have general-slug clusters.
- **Ongoing:** The system maintains itself. Curation keeps facts current. The health
  log shows you what's happening. The search hierarchy keeps token costs low.
