# Silo Phase 2.2 — FINAL Implementation Spec

**Author**: desktop-claude
**Date**: 2026-05-18
**Status**: **Implementation-ready.** Ratified by 5 external audit rounds + 2 internal pre-flight passes (round 5 verdict: 2× approve-as-is + 1× approve-with-minor; ChatGPT's single minor folded inline as §11.1).
**Scope**: Topic proposal feature for standalone Silo users. Closes the usability gap where events accumulate in `general` forever because there's no in-band mechanism to create new topics.
**Repository**: `github.com/Studioscale/Silo`. Target tag: `phase-2.2-topic-proposal`. Baseline: tag `phase-2.1-hardening`, 183/183 tests passing.

This document is the **single authoritative spec** for implementing Phase 2.2. It inlines all decisions from rounds 1-5; previous versioned specs (v1-v3.3) and audit reviews are preserved in `archive/phase-2.2-full-history/` for traceability but are NOT needed for implementation.

---

## 1. Architecture (4 components)

Phase 2.2 is four loosely-coupled components, sharing only the Silo operation log:

1. **Detection** — server-side cron (mirrors `silo-curate.sh`) scans `general` events for clusters that should become their own topic. Writes `TOPIC_SUGGESTED` events.
2. **Surfacing** — MCP server reads a projected `PENDING-SUGGESTIONS.json` file. Read tools (`read_index`, `search`, `list_handoffs`) include a structured `_silo_notices` field (array) when any notice applies. Consumer LLM surfaces it to the user once per session. (Plural — accommodates other notice kinds like Phase 2.3 update-availability.)
3. **Acceptance** — MCP `accept_suggestion` tool. User says yes (via LLM); server emits `TOPIC_METADATA_SET` + `TOPIC_SUGGESTION_ACCEPTED` as an atomic batch; projection creates the topic file.
4. **Dismissal** — MCP `dismiss_suggestion` tool. User says no; server emits `TOPIC_SUGGESTION_DISMISSED` with cooldown; detection respects cooldown via normalized-slug comparison.

User-facing UX: user does nothing proactive. LLM mentions pending suggestion when convenient. User says yes/no. Topic exists. ~30 seconds of conversation.

---

## 2. Three new event types

All admission-validated, all state-bearing, all hash-chained.

### 2.1 `TOPIC_SUGGESTED`

Detector emits when a cluster passes threshold.

```yaml
# matrix.yaml addition:
TOPIC_SUGGESTED:
  is_state_bearing: true
  family: topic
  admission:
    standard: Y
    admin: Y
    install_freeze: N
    recovery: N
    read_only: N
```

Payload schema (admission validator):
```
Required fields:
  slug: matches /^[a-z0-9]+(-[a-z0-9]+)*$/, length 2..40
  name: non-empty single-line string, ≤80 chars
  description: non-empty single-line string, ≤240 chars
  supporting_seqs: array length 1..100, strictly ascending unique safe positive ints, all ≤ maxKnownSeq
  rationale: non-empty single-line string, ≤500 chars
Optional fields:
  source: non-empty single-line string ≤60 chars (e.g. "silo-topic-detector")
Forbidden fields (anything else): rejected at admission
```

Principal: set by caller via `--principal=topic-detector` flag. NOT in payload.

### 2.2 `TOPIC_SUGGESTION_ACCEPTED`

User accepts via MCP. Lifecycle/audit only — does NOT carry topic metadata.

```yaml
TOPIC_SUGGESTION_ACCEPTED:
  is_state_bearing: true
  family: topic
  admission: { standard: Y, admin: Y, install_freeze: N, recovery: N, read_only: N }
```

Payload schema:
```
Required fields:
  suggestion_seq: safe positive int ≤ maxKnownSeq
  accepted_slug: slug regex, length 2..40
Forbidden fields (anything else): rejected at admission
```

Topic metadata (type, name, summary, tags) goes in the paired `TOPIC_METADATA_SET` (§2.4 below), emitted as a batch with this event.

### 2.3 `TOPIC_SUGGESTION_DISMISSED`

User rejects via MCP. Accepts batch dismiss (multiple seqs at once).

```yaml
TOPIC_SUGGESTION_DISMISSED:
  is_state_bearing: true
  family: topic
  admission: { standard: Y, admin: Y, install_freeze: N, recovery: N, read_only: N }
```

Payload schema:
```
Required fields:
  suggestion_seqs: array length 1..50, strictly ascending unique safe positive ints, all ≤ maxKnownSeq
  cooldown_days: integer 1..365
Optional fields:
  reason: non-empty single-line string ≤120 chars
Forbidden fields: rejected
```

All-or-nothing semantics: if ANY seq is non-pending/non-existent/already-resolved, the whole call rejects with structured error listing the invalid seqs.

### 2.4 `TOPIC_METADATA_SET` (existing event type — now needs admission validator)

Exists in current code but has NO admission validator. Phase 2.2 makes it a user-facing surface (via accept_suggestion), so it needs validation.

Payload schema (NEW admission validator):
```
Required field:
  topic: slug regex, length 2..40
Optional fields:
  type: enum {reference, project, feedback, personal, archive, business, hobby}
  tags: array length 0..20, items slug-like ≤30 chars
  entities: array length 0..20, items ≤80 chars
  status: enum {active, paused, archived, reference, deferred}
  sensitivity: string ≤20 chars
  created: ISO date string
  summary: string ≤1000 chars, no \r
  summary_trailing_blank: boolean
Forbidden fields: rejected
```

---

## 3. State slots (final)

In `src/interpret/state.js`:

```js
state.topic_suggestions = new Map();
  // Map<seq, {
  //   seq, slug, name, description, supporting_seqs, rationale, ts, source,
  //   status: 'pending' | 'accepted' | 'dismissed',
  //   resolved_at, resolved_by_seq,
  //   accepted_slug  // ACCEPTED only
  // }>

state.pending_topic_suggestion_seqs = new Set();
  // Set<seq>

state.accepted_topic_suggestion_by_slug = new Map();
  // Map<accepted_slug, suggestion_seq>
  // For bootstrap: maps user's final accepted slug (raw) → original suggestion seq

state.dismissed_topic_suggestion_history = new Map();
  // Map<normalized_slug, Array<{
  //   suggestion_seq, source_dismissal_seq, dismissed_at, cooldown_days,
  //   until_ts, support_fingerprint, reason, cleared_by_accept_seq
  // }>>
  // Append-only history. Every dismissal adds an entry per suggestion_seq in the dismiss batch.

state.cooldowns_by_normalized_slug = new Map();
  // Map<normalized_slug, { source_dismissal_seq, until_ts, cleared_by_accept_seq }>
  // DERIVED VIEW: computed during interpret() finalization from dismissed history.
  // Picks max-until_ts uncleared record per normalized slug.
  // cleared_by_accept_seq is always null here (cleared entries excluded by loop).

state.seq_to_event = new Map();
  // Map<seq, { slug, tag, content, ts, source, principal }>
  // Populated on each write_event fold. source from entry.payload.source ?? null.
  // Used by bootstrap (cross-slug content lookup) and accept-time re-validation.
```

---

## 4. `interpret()` fold rules

### 4.1 `TOPIC_SUGGESTED` handler

```js
state.topic_suggestions.set(entry.seq, {
  seq: entry.seq,
  slug: entry.payload.slug,
  name: entry.payload.name,
  description: entry.payload.description,
  supporting_seqs: entry.payload.supporting_seqs,
  rationale: entry.payload.rationale,
  ts: entry.ts,
  source: entry.payload.source ?? null,
  status: 'pending',
  resolved_at: null,
  resolved_by_seq: null,
  accepted_slug: null,
});
state.pending_topic_suggestion_seqs.add(entry.seq);
```

### 4.2 `TOPIC_SUGGESTION_ACCEPTED` handler

```js
const suggestionSeq = entry.payload.suggestion_seq;
const acceptSeq = entry.seq;
const acceptedSlug = entry.payload.accepted_slug;
const normalized = normalizeSlugKey(acceptedSlug);

const suggestion = state.topic_suggestions.get(suggestionSeq);
if (!suggestion || suggestion.status !== 'pending') {
  state.skipped.push({
    seq: acceptSeq,
    reason: 'suggestion_seq_not_pending',
    suggestion_seq: suggestionSeq,
  });
  return;
}

// 1. Update lifecycle state
suggestion.status = 'accepted';
suggestion.resolved_at = entry.ts;
suggestion.resolved_by_seq = acceptSeq;
suggestion.accepted_slug = acceptedSlug;
state.pending_topic_suggestion_seqs.delete(suggestionSeq);

// 2. Maintain bootstrap index (raw slug → suggestion_seq)
state.accepted_topic_suggestion_by_slug.set(acceptedSlug, suggestionSeq);

// 3. Stamp cleared_by_accept_seq on existing dismissed history records
//    (causal precision: each dismissal cleared by the FIRST accept that satisfies acceptSeq > source_dismissal_seq)
const history = state.dismissed_topic_suggestion_history.get(normalized);
if (history) {
  for (const record of history) {
    if (record.cleared_by_accept_seq != null) continue;
    if (acceptSeq > record.source_dismissal_seq) {
      record.cleared_by_accept_seq = acceptSeq;
    }
  }
}
```

### 4.3 `TOPIC_SUGGESTION_DISMISSED` handler

```js
for (const sugSeq of entry.payload.suggestion_seqs) {
  const suggestion = state.topic_suggestions.get(sugSeq);
  if (!suggestion || suggestion.status !== 'pending') {
    state.skipped.push({
      seq: entry.seq,
      reason: 'suggestion_seq_not_pending',
      suggestion_seq: sugSeq,
    });
    continue;
  }
  suggestion.status = 'dismissed';
  suggestion.resolved_at = entry.ts;
  suggestion.resolved_by_seq = entry.seq;
  state.pending_topic_suggestion_seqs.delete(sugSeq);

  const normalized = normalizeSlugKey(suggestion.slug);
  const history = state.dismissed_topic_suggestion_history.get(normalized) ?? [];
  history.push({
    suggestion_seq: sugSeq,
    source_dismissal_seq: entry.seq,
    dismissed_at: entry.ts,
    cooldown_days: entry.payload.cooldown_days,
    until_ts: entry.ts_ms + entry.payload.cooldown_days * 86400000,
    support_fingerprint: computeSupportFingerprint(suggestion.supporting_seqs),
    reason: entry.payload.reason ?? null,
    cleared_by_accept_seq: null,
  });
  state.dismissed_topic_suggestion_history.set(normalized, history);
}
```

### 4.4 `write_event` handler extension

Existing handler folds write_event into `state.topic_content`. Add one line:

```js
state.seq_to_event.set(entry.seq, {
  slug: entry.payload.slug,
  tag: entry.payload.tag,
  content: entry.payload.content,
  ts: entry.ts,
  source: entry.payload.source ?? null,
  principal: entry.principal,
});
```

### 4.5 Finalization (after all events folded)

```js
// Derive cooldowns_by_normalized_slug from dismissed history
state.cooldowns_by_normalized_slug = new Map();
for (const [normalizedSlug, history] of state.dismissed_topic_suggestion_history.entries()) {
  let strongest = null;
  for (const record of history) {
    if (record.cleared_by_accept_seq != null) continue;
    if (!strongest || record.until_ts > strongest.until_ts) {
      strongest = record;
    }
  }
  if (strongest) {
    state.cooldowns_by_normalized_slug.set(normalizedSlug, {
      source_dismissal_seq: strongest.source_dismissal_seq,
      until_ts: strongest.until_ts,
      cleared_by_accept_seq: null,
    });
  }
}
```

---

## 5. `LogWriter` changes

Three changes to `src/log/append.js`:

### 5.1 OS-level flock at primitive layer

Add `_acquireFlock(siloDataDir)` and `_releaseFlock(fd)` using `fs-ext` npm package. Lock path:

```js
// src/log/file-lock.js
function getLockPath(siloDataDir) {
  const envOverride = process.env.SILO_LOCK_DIR;
  if (envOverride) return path.join(envOverride, 'operation-log.lock');
  return path.join(siloDataDir, '.locks', 'operation-log.lock');
}
```

Auto-create parent directory on first writer init:
```js
fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
const lockFd = fs.openSync(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600);
```

Native build dependency (`fs-ext`) documented as requirement for Linux/macOS. Windows users without `fs-ext` get a degraded mode warning.

### 5.2 Public `append()` and `batchAppend()` acquire flock

```js
async append(entry) {
  return this._locked(async () => {
    const lockFd = await this._acquireFlock();
    try {
      const freshTail = await this._scanTailUnlocked();
      this._tail = freshTail;
      // Note: NO explicit validate here — _appendUnlocked validates internally
      return await this._appendUnlocked(entry);
    } finally {
      await this._releaseFlock(lockFd);
    }
  });
}

async batchAppend(entries) {
  return this._locked(async () => {
    const lockFd = await this._acquireFlock();
    try {
      const freshTail = await this._scanTailUnlocked();
      this._tail = freshTail;
      return await this._appendBatchUnlocked(entries);
    } finally {
      await this._releaseFlock(lockFd);
    }
  });
}
```

**Admission validation invariant:** `_appendUnlocked` / `_appendBatchUnlocked` call `validatePayloadForAppend(entry, { maxKnownSeq: this._tail.seq })` internally per entry, BEFORE serialization/hashing. Wrappers do NOT pre-validate. Single source of truth.

### 5.3 `withAppendLock(asyncFn)` + tolerant `_scanTail`

New helper for state-dependent write paths (accept/dismiss):

```js
async withAppendLock(asyncFn) {
  return this._locked(async () => {
    const lockFd = await this._acquireFlock();
    try {
      const freshTail = await this._scanTailUnlocked();
      this._tail = freshTail;
      const freshState = await interpret(this);  // 'this' has readAll()
      return await asyncFn({ writer: this, freshTail, freshState });
    } finally {
      await this._releaseFlock(lockFd);
    }
  });
}
```

Callers inside `asyncFn` MUST use `_appendBatchUnlocked` / `_appendUnlocked` (lock-bypassing primitives) — calling public `append()` from inside would re-enter `_locked()` and deadlock.

Update `_scanTail` to tolerate malformed trailing lines (walk backward to last valid). Brings it in line with existing `readAll()` semantics. Discarded bytes logged once to stderr.

### 5.4 `_appendBatchUnlocked` short-write retry

```js
async function writeFully(fd, buffer) {
  let offset = 0;
  let retries = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fs.write(fd, buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) {
      retries++;
      if (retries >= 5) throw new Error('short write: 5 retries exhausted');
      await new Promise(r => setTimeout(r, 10 * retries));
    } else {
      offset += bytesWritten;
      retries = 0;
    }
  }
}
```

**Recovery model: "replay-safe prefix recovery" (NOT atomic).** Crashes mid-batch leave a valid prefix; tolerant `_scanTail` recovers. Residual case: line 1 fsynced + line 2 missing = metadata exists but lifecycle event doesn't (suggestion stays pending; detection won't re-propose because slug now in TOPIC-INDEX; manual dismiss clears).

---

## 6. New projection: `PENDING-SUGGESTIONS.json`

Written by `regenerateProjections()` on every regen call. Atomic write via `.tmp` → `fs.rename`.

Envelope shape:
```json
{
  "schema_version": 1,
  "generated_at": "2026-05-18T14:32:11Z",
  "suggestions": [
    {
      "seq": 1602,
      "slug": "pets",
      "name": "Pets",
      "description": "Health, training, routine for pets",
      "supporting_seqs": [1421, 1438, 1502, 1567, 1580],
      "rationale": "5 events about a dog Rover over 23 days",
      "ts": "2026-05-15T10:00:00Z",
      "age_days": 3
    }
  ],
  "count": 1,
  "oldest_pending_age_days": 3,
  "cap": 10,
  "cap_reached": false,
  "detector_status": {
    "last_run_at": "2026-05-18T05:00:00Z",
    "last_success_at": "2026-05-18T05:00:00Z",
    "consecutive_failures": 0,
    "first_run_deferred": false
  }
}
```

Sorted oldest-first by `ts`. Missing file → empty suggestions list (no entry added to `_silo_notices`). Malformed file → log warning, treat as empty.

MCP server caches by mtime (mirrors existing `loadTopicIndex` pattern in `silo-mcp-server.js`).

---

## 7. MCP tool surface

Three new tools + structured notice on existing read tools.

### 7.1 `list_pending_suggestions()`

Returns the projected envelope (or `{suggestions: [], count: 0, detector_status: null}` if file missing/malformed).

### 7.2 `accept_suggestion({suggestion_seq, slug?, name?, description?, type?, tags?})`

All five fields after `suggestion_seq` user-overridable. Server emits batch (see §8). Returns `{accepted: true, accepted_seq, regenerated, topic_visible_in_index}`.

### 7.3 `dismiss_suggestion({suggestion_seqs, cooldown_days?, reason?})`

Batch dismiss. Default `cooldown_days = 90`. All-or-nothing semantics — any invalid seq → reject entire call with `{invalid: [{seq, reason}, ...]}`.

### 7.4 `_silo_notices` structured field (array)

Added to JSON responses of `read_index`, `search`, `list_handoffs` ONLY (NOT `read_events`, `get_topic`, write tools, or `list_pending_suggestions` itself). When pending count > 0:

```json
{
  "topics": [...],
  "_silo_notices": [
    {
      "kind": "pending_topic_suggestions",
      "count": 1,
      "cap_reached": false,
      "tool": "list_pending_suggestions",
      "message": "Silo has 1 pending topic suggestion. Available for review when convenient — mention once per session if relevant to the user's current task.",
      "first_pending_age_days": 2
    }
  ]
}
```

`_silo_notices` is an array. Phase 2.2 contributes the `pending_topic_suggestions` kind. Phase 2.3 (update notification) adds the `update_available` kind to the same array. Both can coexist in a single response.

When no notices apply (no pending suggestions, no update available): field absent (NOT empty array, NOT null — preserves backward compat).
On error responses: field absent.
Marked optional in tool JSON schema (Gemini round-4 F4).

---

## 8. Canonical accept flow (atomic, source-grounded)

```js
async function accept_suggestion(input) {
  let appendedEntries;
  await writer.withAppendLock(async ({ writer, freshTail, freshState }) => {
    // 1. Validate against fresh state under lock
    const suggestion = freshState.topic_suggestions.get(input.suggestion_seq);
    if (!suggestion || suggestion.status !== 'pending') {
      throw new MCPError('SUGGESTION_NOT_PENDING');
    }

    const finalSlug = input.slug ?? suggestion.slug;
    if (!validateSlugRegex(finalSlug)) {
      throw new MCPError('INVALID_SLUG');
    }
    if (freshState.topic_index.has(finalSlug)) {
      throw new MCPError('SLUG_COLLISION');
    }

    // 2. Accept-time semantic re-validation of supporting_seqs
    for (const seq of suggestion.supporting_seqs) {
      const ev = freshState.seq_to_event.get(seq);
      if (!ev) {
        throw new MCPError('SUPPORTING_SEQ_NOT_FOUND', { seq });
      }
      if (ev.source === 'silo-topic-detector') {
        throw new MCPError('SUPPORTING_SEQ_INVALID_SOURCE', { seq, source: ev.source });
      }
      if (!DETECTOR_SCAN_SLUGS.includes(ev.slug)) {
        throw new MCPError('SUPPORTING_SEQ_WRONG_SLUG', { seq, found_slug: ev.slug });
      }
    }

    // 3. Build batch — object-form entries
    const metadataIntentId = input.intent_id
      ? `${input.intent_id}:metadata`
      : generateIntentId('accept-metadata');
    const acceptIntentId = input.intent_id
      ? `${input.intent_id}:accept`
      : generateIntentId('accept-lifecycle');

    const metadataPayload = {
      topic: finalSlug,
      type: input.type ?? 'reference',        // CRITICAL DEFAULT — required for projection
      status: input.status ?? 'active',       // CRITICAL DEFAULT
      summary: input.description ?? suggestion.description,
      tags: input.tags ?? [],
    };
    const acceptedPayload = {
      suggestion_seq: input.suggestion_seq,
      accepted_slug: finalSlug,
    };

    // 4. Atomic batch append — single fs.write + fsync inside the lock
    appendedEntries = await writer._appendBatchUnlocked([
      {
        type: 'TOPIC_METADATA_SET',
        isStateBearing: true,
        intentId: metadataIntentId,
        principal: input.principal ?? DEFAULT_PRINCIPAL,
        payload: metadataPayload,
      },
      {
        type: 'TOPIC_SUGGESTION_ACCEPTED',
        isStateBearing: true,
        intentId: acceptIntentId,
        principal: input.principal ?? DEFAULT_PRINCIPAL,
        payload: acceptedPayload,
      },
    ]);
  });

  // 5. After lock release, trigger regen subprocess
  const regenSuccess = await spawnRegen();

  return {
    accepted: true,
    accepted_seq: appendedEntries[1].seq,
    regenerated: regenSuccess,
    topic_visible_in_index: regenSuccess,
  };
}
```

Note: `intent_id` is for audit/correlation. Duplicate-suppression for retries relies on lock-scoped fresh-state validation (suggestion-not-pending throws on retry), NOT on writer-level dedup. (See §11.1 — this clarifies the v2 carry-forward claim that ChatGPT round-5 F1 corrected.)

---

## 9. Detection module

New module `src/topic-proposal/detect.js`.

### 9.1 Cron job

`silo-detect.sh` on VPS, daily at 04:00 UTC (mirror of `silo-curate.sh` 05:00 UTC). Pattern:

```bash
#!/bin/bash
set -e

# Separate bash cron mutex (NOT the operation-log lock)
CRON_LOCK="/var/lock/silo-detect.lock"
exec 9>"$CRON_LOCK"
flock -n 9 || { echo "Another silo-detect is running; exiting"; exit 0; }

RUN_ID=$(uuidgen)

# Status: run started
node /root/silo/src/cli/silo.js write \
  --silo-dir="$SILO_DIR" \
  --slug=system \
  --tag=FACT \
  --principal=topic-detector \
  --source=silo-topic-detector \
  --content="silo-detect run started (run_id=$RUN_ID, scope=general, days_back=30)"

# Run detection
node /root/silo/src/cli/silo.js suggest --run-now --silo-dir="$SILO_DIR" --run-id="$RUN_ID"

# Status: run complete (or failed)
node /root/silo/src/cli/silo.js write \
  --silo-dir="$SILO_DIR" \
  --slug=system \
  --tag=FACT \
  --principal=topic-detector \
  --source=silo-topic-detector \
  --content="silo-detect run complete (run_id=$RUN_ID, N suggested, M skipped, K validated)"
```

Operation-log lock acquisition happens inside the Node CLI via fs-ext, NOT in bash. Bash mutex prevents two cron instances; flock prevents two writers.

### 9.2 Detection logic

For each run:
1. Read events from `scan_slugs` (default `['general']`) within `days_back` (default 30).
2. Exclude events with `payload.source === 'silo-topic-detector'` (anti-self-citation).
3. If new event count < `min_events` (default 3): exit with `[FACT] system: silo-detect: insufficient events, no clusters` event.
4. Cap input to `max_input_tokens` (default 50,000). On overflow: stratified sample (every Nth + first/last); log "sampled M of N events" status.
5. Send to LLM with anti-fragmentation prompt: "prefer fewer broader topics over many narrow ones; reject clusters whose slug matches existing TOPIC-INDEX; reject clusters with <`min_events` supporting events."
6. LLM returns array of proposed clusters.
7. For each proposal:
   - Validate slug regex
   - Reject if slug exists in TOPIC-INDEX
   - Reject if normalizeSlugKey(slug) is in active cooldown (`isCooldownActive(state.cooldowns_by_normalized_slug.get(norm))`)
   - Reject if support fingerprint overlaps ≥0.65 Jaccard with any pending or cooldown-active dismissed suggestion (configurable threshold)
   - Validate every supporting_seq exists in `state.seq_to_event`, is a `write_event`, has matching slug in scan_slugs (anti-hallucination)
8. For valid proposals up to `max_suggestions_per_run` (default 3), build deterministic intent_id:
   ```
   intent_id = `silo-detect:${YYYY-MM-DD}:cluster-${supportFingerprint}`
   ```
   This makes duplicate cron runs land identical intent_ids; replay sees second one in `state.skipped`.
9. Emit `TOPIC_SUGGESTED` via writer.append() (which acquires flock).
10. Regenerate projections.

### 9.3 First-run deferral

If no prior `TOPIC_SUGGESTED` events exist AND `general` event count > 50:
- Skip auto-run, emit `[FACT] system: silo-detect first run deferred (general_count=N, run silo suggest --bulk-scan to onboard)`
- Subsequent runs check for this event and continue skipping until `--bulk-scan` runs OR operator manually runs detector

### 9.4 `computeSupportFingerprint(supporting_seqs)`

```js
const { createHash } = require('crypto');
function computeSupportFingerprint(seqs) {
  if (!Array.isArray(seqs) || seqs.length === 0) {
    throw new Error('computeSupportFingerprint: non-empty array required');
  }
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  const hash = createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
  return hash.slice(0, 16);
}
```

Pure, deterministic, replay-safe.

### 9.5 `normalizeSlugKey(slug)`

```js
function normalizeSlugKey(slug) {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new TypeError(`normalizeSlugKey: expected non-empty string, got ${typeof slug}`);
  }
  return slug.normalize('NFC').toLowerCase().replace(/-/g, '');
}
```

Handles `pets` / `Pets` / `pet-s` / `PETS` all normalizing to `pets`.

### 9.6 `isCooldownActive(record, now = Date.now())`

```js
function isCooldownActive(record, now = Date.now()) {
  if (!record) return false;
  if (record.cleared_by_accept_seq != null) return false;
  return now < record.until_ts;
}
```

Wall-clock comparison happens OUTSIDE interpret() (consumer code only).

---

## 10. Bootstrap curate path

When `accept_suggestion` creates a topic, the new topic has no own-slug events. `silo curate` on the next cron run needs to populate Layer 2 from the suggestion's `supporting_seqs` (which live under `general`).

### 10.1 Eligibility predicate

```js
function isBootstrapEligible(slug, state, now = Date.now()) {
  const meta = state.topic_index.get(slug);
  if (!meta?.topic_type) return false;
  const suggestionSeq = state.accepted_topic_suggestion_by_slug.get(slug);
  if (!suggestionSeq) return false;
  const suggestion = state.topic_suggestions.get(suggestionSeq);
  if (!suggestion || suggestion.status !== 'accepted') return false;
  const ownEvents = state.topic_content.get(slug) ?? [];
  const ownCurated = ownEvents.filter(h =>
    h.tag === 'CURATED' && !state.retired_curated_seqs.has(h.seq)
  );
  if (ownCurated.length > 0) return false;  // already bootstrapped
  const ageDays = (now - Date.parse(suggestion.resolved_at)) / 86400000;
  if (ageDays > 60) return false;  // stale
  return true;
}
```

### 10.2 cmdCurate integration

Add a separate top-of-function loop in `cmdCurate`:

```js
const bootstrapSlugs = [];
for (const slug of state.topic_index.keys()) {
  if (isBootstrapEligible(slug, state)) bootstrapSlugs.push(slug);
}
for (const slug of bootstrapSlugs) {
  await runBootstrapCurate(slug, state, args);
}
// ... existing target discovery + normal curate loop continues
```

### 10.3 Bootstrap prompt

```
You are bootstrapping a brand-new topic with no curated content. The user just
created the topic "${slug}" (type=${type}) from a topic-detector suggestion.

Below are the original events from `general` that triggered the detection.
They are the seed material for this topic.

Your task: write durable curated bullets (Layer 2) that capture what's worth
remembering ABOUT THE TOPIC LONG-TERM. Phrase bullets as facts/decisions
about ${slug}, not as event timestamps.

Topic name: ${name}
Topic summary: ${summary}
Tags: ${tags}

Seed events from `general` (sorted by date):
${events_formatted}

OUTPUT RULES:
- New bullets only, one per line, each starting with "- "
- Each bullet ≤200 chars, single line, no newlines mid-bullet
- No headings, no numbering, no prose before/after
- At most ${maxBullets} bullets
- If nothing is durable enough to write, output exactly: NOTHING_TO_ADD
```

Cap `supporting_seqs` fed to prompt at 50 most recent (anti-overflow per Gemini round-2 F3).

Events fetched via `state.seq_to_event.get(seq)` — cross-slug lookup, regardless of their original slug.

---

## 11. Carry-forward corrections

### 11.1 (ChatGPT round-5 F1) `intent_id` is NOT writer-level dedup

**Correction to v2 carry-forward text:** v2 §2.4 claimed deterministic `intent_id`s make duplicate detection cron runs safe because "Silo's existing `dedup_witness_set` rejects duplicates at the writer level." This is FALSE. `dedup_witness_set` is populated during `interpret()` replay; `LogWriter.append()` does NOT consult it before writing.

**Actual duplicate-prevention model for Phase 2.2:**
- `accept_suggestion`: lock-scoped fresh-state check (`SUGGESTION_NOT_PENDING` throws on retry).
- `dismiss_suggestion`: same lock-scoped check.
- Detection: support-overlap Jaccard ≥0.65 against pending + cooldown-active dismissed.
- `intent_id` is for audit/correlation. Replays see duplicates in `state.skipped` but they DO land in the log.

**Implementation impact:** do NOT write tests that assert "writer-level dedup rejects duplicate intent_id." The tests should verify the lock-scoped + support-overlap paths.

---

## 12. CLI extensions

### 12.1 `cmdWrite --source` flag

`src/cli/silo.js` `cmdWrite`:

```js
async function cmdWrite({ 'silo-dir': siloDir, slug, tag, content, principal, confidence, source }) {
  const payload = { slug, tag: tag || 'FACT', content };
  if (confidence) payload.confidence = confidence;
  if (source) payload.source = source;
  // ... existing append (now flock-protected per §5.2) ...
}
```

Add `source: { type: 'string' }` to parseArgs schema. Used by detector cron with `--source=silo-topic-detector`.

### 12.2 `silo suggest` admin subcommand

```
silo suggest --run-now [--dry-run]
silo suggest --list [--json]
silo suggest --accept <seq> [--slug=X] [--name=Y] [--type=Z] [--tags=A,B]
silo suggest --dismiss <seq> [--cooldown-days=N] [--reason="..."]
silo suggest --status
silo suggest --bulk-scan [--days-back=180] [--confirm]
```

Not user-facing in README; operator/debugging surface.

---

## 13. Out of scope (deferred, NOT implemented in Phase 2.2)

- Auto-expire pending suggestions (cap-only behavior; no TTL)
- Event reassignment from `general` to new topic
- Scanning slugs other than `general` (default + only)
- TOPIC_VERIFIED extension to suggestions
- Cross-topic dreaming (Phase 3)
- Full matrix admission gate (Phase 2.3)
- Multi-principal T2 semantics
- One-time onboarding `_silo_notices` entry

---

## 14. Acceptance criteria (unified)

**Core functionality:**
- [ ] `accept_suggestion` with no `type` override → topic file appears, `type=reference`, `status=active`
- [ ] Parallel CLI write spawns produce strictly-increasing seqs + valid hash chain
- [ ] Parallel `silo-curate.sh` + Node `silo write` → no duplicate seqs (flock works across processes)
- [ ] Crash mid-batch leaves recoverable prefix; subsequent init succeeds
- [ ] Same-process parallel `accept_suggestion` for same slug → exactly one succeeds, other returns SLUG_COLLISION

**Bootstrap:**
- [ ] Accept suggestion whose supporting events are under `general`. Verify `isBootstrapEligible(slug, state) === true` BEFORE any own-slug event
- [ ] Next `silo curate --slug=<accepted>` populates Layer 2 from supporting_seqs
- [ ] Bootstrap fires only ONCE per slug (idempotent if LLM returns NOTHING_TO_ADD)

**Admission validators (4 new):**
- [ ] TOPIC_METADATA_SET, TOPIC_SUGGESTED, TOPIC_SUGGESTION_ACCEPTED, TOPIC_SUGGESTION_DISMISSED — all reject unknown payload fields
- [ ] All reject out-of-bound values (length, integer ranges, etc.)
- [ ] TOPIC_SUGGESTION_ACCEPTED rejects `suggestion_seq > maxKnownSeq`

**Cooldown semantics:**
- [ ] Dismiss `pets` 365d + `pet-s` 1d → after 2 days, `isCooldownActive(state.cooldowns_by_normalized_slug.get('pets'))` returns true
- [ ] Accept after dismissals → `cleared_by_accept_seq` correctly stamped to ACCEPT seq (not suggestion_seq)
- [ ] Dispatch: dismiss → accept-older-pending → cooldown cleared

**Detection:**
- [ ] Detection rejects clusters whose support_fingerprint overlaps ≥0.65 Jaccard with pending/cooldown-active
- [ ] Detection rejects clusters with hallucinated supporting_seqs (not in state.seq_to_event)
- [ ] First-run deferral writes single durable event; subsequent runs check for it
- [ ] Detector status events written under `system` slug with `source: silo-topic-detector`
- [ ] Detector excludes events with `source: silo-topic-detector` from cluster scanning

**MCP surface:**
- [ ] `_silo_notices` array appears in `read_index`, `search`, `list_handoffs` when any notice applies (count > 0 or update available)
- [ ] Each notice in the array has a `kind` discriminator
- [ ] Field omitted when count = 0 or on error responses
- [ ] `accept_suggestion` returns `{accepted: true, accepted_seq, regenerated, topic_visible_in_index}`
- [ ] `dismiss_suggestion` all-or-nothing with invalid seqs returning structured error

**Projection:**
- [ ] PENDING-SUGGESTIONS.json written via `.tmp` then `fs.rename` (atomic)
- [ ] Missing file → empty suggestions list (no crash)
- [ ] mtime caching in MCP server

**Concurrency:**
- [ ] `withAppendLock(asyncFn)` wraps `_locked()` (in-process mutex) AND flock (cross-process)
- [ ] Public `append()` / `batchAppend()` also wrap both
- [ ] `_appendUnlocked` / `_appendBatchUnlocked` validate internally; wrappers don't pre-validate (single source of truth)

**Carry-forward correction (§11.1):**
- [ ] No test asserts "writer-level dedup rejects duplicate intent_id"
- [ ] intent_id documented as audit/correlation label, not authoritative dedup

**Implementation hygiene:**
- [ ] No regression in existing 183-test count; target post-2.2: ~240-275
- [ ] README "Topic suggestions" section + `silo init` hint
- [ ] Implementation lands on `github.com/Studioscale/Silo` with tag `phase-2.2-topic-proposal`
- [ ] Silo memory event logged with `[CHANGED]` tag describing the new capability

---

## 15. Suggested implementation order

1. **Foundation layer** (no behavioral changes; sets up infrastructure):
   - `src/log/file-lock.js` (new) with `getLockPath`, `_acquireFlock`, `_releaseFlock`
   - `_scanTail` tolerance
   - `_appendBatchUnlocked` + short-write retry
   - Wrap public `append()` / `batchAppend()` in flock
   - `withAppendLock(asyncFn)` helper
   - Update `_doAppend` → `_appendUnlocked` (rename, no behavior change)

2. **State + interpret extensions:**
   - Add 6 new state slots to `state.js`
   - Add `normalizeSlugKey` to `src/admission/slug.js`
   - Add `computeSupportFingerprint` to `src/util/support-fingerprint.js`
   - Extend write_event fold to populate `seq_to_event`
   - Add 3 new event handlers (TOPIC_SUGGESTED, ACCEPTED, DISMISSED)
   - Add finalization step for `cooldowns_by_normalized_slug`

3. **Admission validators (4 new):**
   - Extend `src/admission/payload-validators.js` with 4 validators
   - All wired into `_appendUnlocked` per existing pattern

4. **Matrix entries:** add 3 new event types to `src/matrix/matrix.yaml`

5. **Projection:**
   - `src/projection/regenerate-pending-suggestions.js`
   - Wire into `src/projection/index.js`'s `regenerateProjections()`

6. **Bootstrap curate:**
   - Add `isBootstrapEligible` to `src/cli/silo.js`
   - Add `runBootstrapCurate` with dedicated prompt
   - Wire into `cmdCurate` as pre-loop pass

7. **Detection module:** new `src/topic-proposal/detect.js`

8. **CLI extensions:**
   - `cmdWrite --source` flag
   - `silo suggest` admin subcommand

9. **MCP server (VPS):**
   - 3 new tools (list/accept/dismiss)
   - `_silo_notices` (array) wiring on read tools
   - PENDING-SUGGESTIONS.json mtime cache

10. **Cron wrapper:** `silo-detect.sh` on VPS

11. **Tests:** ~75-100 new unit + integration tests covering all acceptance criteria

12. **Docs:** README updates, `silo init` hint

13. **Tag + memory event:** ship `phase-2.2-topic-proposal` tag; log `[CHANGED] jarvis-claw` in Silo memory.

---

## 16. Audit trail

This spec is the synthesis of:
- 5 external audit rounds (each 3 reviewers: ChatGPT, Gemini, fresh Claude sub-agent)
- 2 internal pre-flight passes (fresh Claude sub-agents)
- 7 versioned specs (original design → v1 synthesis → v2 → v3 → v3.1 → v3.2 → v3.3)

Round-5 final verdicts:
- Fresh Claude: Approve as-is (0 findings)
- Gemini: Approve as-is (0 findings)
- ChatGPT: Approve with minor changes (1 minor — §11.1 above)

Total bugs surfaced and fixed across iterations: 14+ critical/major issues.

Full audit history preserved in `archive/phase-2.2-full-history/` for traceability.

---

*End of FINAL spec. Implementation begins on `github.com/Studioscale/Silo` after Helder's go-ahead.*
