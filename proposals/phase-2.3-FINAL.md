# Silo Phase 2.3 — Update Notification (FINAL)

**Author**: desktop-claude
**Date**: 2026-05-18 (revised same day after 1 pre-flight pass + 1 external audit round)
**Status**: **Implementation-ready.** All findings from internal pre-flight + 3 external reviewers (ChatGPT + Gemini + fresh-Claude sub-agent) folded inline. Unanimous "approve with minor changes" verdict.
**Scope**: Notify Silo users when a new GitHub release is available, via the `_silo_notices` array Phase 2.2 introduces. ~210 LOC, 1-2 implementation sessions. Implementation order: AFTER Phase 2.2 ships (numerical order per Helder's preference).

---

## 0. Problem statement

Silo has no in-band update-notification mechanism. When a fix is tagged on `github.com/Studioscale/Silo`, existing deployments don't learn about it unless the operator (Helder) calls users personally. Phase 2.3 closes the gap inside Silo itself — automatic checks, in-band notification through the same MCP `_silo_notices` channel that surfaces Phase 2.2 topic suggestions, no operator action required.

---

## 1. Architecture

Three components, mirroring Phase 2.2's surfacing pattern:

1. **Version check** — every silo CLI invocation (except `silo doctor` and explicit opt-out) detaches a background process that queries GitHub Releases API once per 24h (throttled via cache file), writes result to `<silo-dir>/update-status.json`.
2. **Surfacing** — MCP server reads update-status.json and includes an `update_available` notice in the `_silo_notices` array on read-tool responses. Coexists with Phase 2.2's `pending_topic_suggestions` kind.
3. **CLI** — `silo doctor` shows status; `silo doctor --check-updates` forces a fresh check.

---

## 2. `_silo_notices` integration

Phase 2.2-FINAL already uses `_silo_notices` as a plural array. Phase 2.3 adds a new notice `kind: "update_available"`:

```json
{
  "topics": [...],
  "_silo_notices": [
    {
      "kind": "pending_topic_suggestions",
      "count": 1,
      ...
    },
    {
      "kind": "update_available",
      "current_version": "0.1.0-m1",
      "latest_version": "0.1.0-m2",
      "tag_url": "https://github.com/Studioscale/Silo/releases/tag/v0.1.0-m2",
      "released_at": "2026-05-17T14:00:00Z",
      "message": "Silo v0.1.0-m2 available (current: v0.1.0-m1). Run `git pull && npm install` to upgrade."
    }
  ]
}
```

**Field-absence semantics:** when no notices apply, `_silo_notices` is **absent from the response** — never empty array, never null. Aligned with Phase 2.2-FINAL §7.4.

---

## 3. Version check mechanism

### 3.1 Local version source (ESM-safe — round-1 ESM fix)

Silo is `"type": "module"` (ESM). All Phase 2.3 code MUST use ESM-compatible patterns:

```js
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const CURRENT_VERSION = packageJson.version;  // e.g., "0.1.0-m1"

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

(Alternative if avoiding `createRequire`: `JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url)))`.)

**Acceptance test:** running any CLI command must NOT throw `ReferenceError: require is not defined` or `ReferenceError: __dirname is not defined`. Verify in clean ESM checkout.

### 3.2 GitHub API query

```
GET https://api.github.com/repos/Studioscale/Silo/releases/latest
```

- Plain HTTPS via Node's built-in `https` module (no new deps)
- 5-second timeout
- User-Agent: `Silo` (no version — avoids IP+version fingerprinting)
- Unauthenticated (60 req/hr limit, comfortably above our 1/deployment/24h rate)

### 3.3 Version comparator (intentionally simple)

```js
function compareVersions(a, b) {
  const parse = (v) => v
    .replace(/^v/, '')
    .split('+')[0]                            // strip build metadata FIRST (fixes round-1 ChatGPT F4)
    .split(/[.-]/)
    .map(p => /^\d+$/.test(p) ? parseInt(p, 10) : p);
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (typeof x === typeof y) {
      if (x < y) return -1;
      if (x > y) return 1;
    } else {
      return typeof x === 'number' ? 1 : -1;  // numeric > string (0.1.0 > 0.1.0-rc1)
    }
  }
  return 0;
}
```

**Required tests:**
- `compareVersions('0.1.0', '0.1.0-rc1') === 1`
- `compareVersions('0.1.0-m1', '0.1.0-m2') === -1`
- `compareVersions('0.2.0', '0.1.99') === 1`
- `compareVersions('0.1.0+build1', '0.1.0+build2') === 0` (build metadata stripped)

**Documented limitations:** pre-release counters >9 compare lexicographically (`m10 < m2`). Workaround: pad to `m02`/`m10` if double-digit milestones reached. Acceptable for current scale.

### 3.4 Cache file (path + atomic write)

**Path: `<silo-dir>/update-status.json`** where `<silo-dir>` is the Silo data directory (same `--silo-dir` flag the CLI uses; default `process.env.SILO_DIR || '.silo'`).

**Atomic write — multi-process safe** (round-1 ChatGPT F3 fix):

```js
const finalPath = join(siloDir, 'update-status.json');
const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
await fs.writeFile(tmp, content, 'utf8');
await fs.rename(tmp, finalPath);
```

Unique tmp filename per worker prevents tmp collisions between concurrent detached workers. Mirrors the spirit of `atomicWrite()` in `src/projection/index.js:20-27` but extends it for multi-writer safety.

**Note:** `atomicWrite()` in `src/projection/index.js` is currently module-private. Either export it for reuse, OR Phase 2.3 inlines the 4-line pattern locally (cleaner).

**Schema (extended per round-1 ChatGPT F5 + Claude C3):**

```json
{
  "schema_version": 1,
  "last_checked_at": "2026-05-18T05:00:00Z",
  "last_successful_check_at": "2026-05-15T05:00:00Z",
  "last_successful_latest_version": "0.1.0-m1",
  "current_version": "0.1.0-m1",
  "latest_version": "0.1.0-m2",
  "tag_url": "https://github.com/Studioscale/Silo/releases/tag/v0.1.0-m2",
  "released_at": "2026-05-17T14:00:00Z",
  "update_available": true,
  "last_check_status": "ok",
  "last_error": null,
  "consecutive_failures": 0
}
```

**Fold rules:**
- On success: set `last_checked_at` = `last_successful_check_at` = now; update `last_successful_latest_version`; reset `consecutive_failures = 0`.
- On failure: update `last_checked_at`, `last_check_status`, `last_error`; increment `consecutive_failures`; PRESERVE last-success fields.

### 3.5 Throttling + detached execution

Critical correctness mechanism: version check is fired from a detached child process so it survives the parent CLI exiting in <100ms:

```js
function maybeFireUpdateCheck(siloDir) {
  if (isOptOut()) return;
  const cache = readCacheIfExists(siloDir);
  if (cache && Date.now() - Date.parse(cache.last_checked_at) < 86400000) return;

  // Detach so the check survives a fast `silo write` exiting
  const checker = join(__dirname, '../util/update-check-worker.js');
  spawn(
    process.execPath,
    [checker, '--silo-dir', siloDir],
    { detached: true, stdio: 'ignore' }
  ).unref();
}
```

`src/util/update-check-worker.js` (new): standalone script — fetches GitHub, writes cache via §3.4 unique-tmp path, exits. ~50 LOC.

**Worker-side concurrency safety** (round-1 ChatGPT F3 mitigation): at startup, the worker re-reads the cache. If `last_checked_at` is now fresh (<24h, another worker just wrote it), the worker exits without fetching. Prevents redundant GitHub calls when multiple CLI invocations fire workers in quick succession.

**Throttle predicate:** check fires only if `(now - last_checked_at) > 24h` OR cache file is missing.

### 3.6 Opt-out env var

Disabled when `process.env.SILO_DISABLE_UPDATE_CHECK` is one of `1`, `true`, `yes`, `on` (case-insensitive). Enabled otherwise. `SILO_DISABLE_UPDATE_CHECK=0` keeps the check enabled (matches Node convention).

**Round-1 ChatGPT F6 fix — opt-out also suppresses stale cached notices:** the MCP server checks the env var. When opt-out is active, the MCP server does NOT emit `update_available` or `update_check_unhealthy` notices even if the cache says so. This means setting `SILO_DISABLE_UPDATE_CHECK=1` immediately stops all update-related UX, not just future checks.

`silo doctor` displays cache state regardless of opt-out (for diagnosis), but adds a line: "Update checks are disabled (SILO_DISABLE_UPDATE_CHECK=1)."

`silo doctor --check-updates` honors opt-out by default; user can override with `--force` (or refuses with a clear message — implementer's choice).

### 3.7 Failure handling

| Status | Behavior |
|---|---|
| `ok` | Cache populated normally; `consecutive_failures` reset to 0 |
| Transient (network_error, rate_limited, parse_error) | Increment `consecutive_failures`. Silent UNTIL counter ≥7, then surface `update_check_unhealthy` notice |
| `repo_not_found` (404) | Increment `consecutive_failures`. Surface notice immediately (operator-actionable — repo moved/renamed) |

`update_check_unhealthy` notice shape (both threshold AND immediate-404 cases):

```json
{
  "kind": "update_check_unhealthy",
  "last_error": "ETIMEDOUT",
  "last_successful_check_at": "2026-05-10T05:00:00Z",
  "consecutive_failures": 7,
  "message": "Silo update check has failed 7 consecutive runs. Run `silo doctor` for diagnosis."
}
```

For 404 specifically: `consecutive_failures` may still be 1; notice says `"Silo update check found 404 — repository may have moved. Run `silo doctor` for details."`

---

## 4. CLI surface

### 4.1 `cmdDoctor` (new) — registered in dispatcher

`silo doctor [--check-updates] [--force]`

**Registration:** add `case 'doctor': return cmdDoctor(args);` to the main dispatcher in `src/cli/silo.js` `main()` (around line 698-780 per source). (Round-1 Claude C5 fix.)

Reads cache; prints status. No fresh check, no network call by default.

Sample output (cache present, no update):
```
$ silo doctor
Silo v0.1.0-m1 (latest)

Update check: last ran 2026-05-18 05:00 UTC
  Status: ok
  Latest available: v0.1.0-m1
  No upgrade needed.

Operation log: <silo-dir>/operation-log/
  Last seq: 1602
  Last write: 2026-05-18 10:23 UTC

Cache file: <silo-dir>/update-status.json
  Exists: yes
  Last update: 2026-05-18 05:00 UTC
```

When update available:
```
$ silo doctor
Silo v0.1.0-m1 (installed)

Update check: last ran 2026-05-18 05:00 UTC
  Status: ok
  Latest available: v0.1.0-m2 (released 2026-05-17)
  Upgrade: run `git pull && npm install` in this repo's clone
...
```

When check is failing:
```
Update check: last ran 2026-05-18 05:00 UTC
  Status: network_error (ETIMEDOUT)
  Consecutive failures: 3
  Last successful check: 2026-05-15 05:00 UTC (saw v0.1.0-m1 as latest)
  Retry: run `silo doctor --check-updates` to force a fresh check.
```

When opt-out is active:
```
Update checks are disabled (SILO_DISABLE_UPDATE_CHECK=1)
Cached state (last refreshed 2026-05-18 05:00 UTC):
  ...
```

### 4.2 `silo doctor --check-updates`

Forces immediate fetch ignoring throttle. Synchronous (not detached) so user sees the result. Writes cache. Prints result. Honors opt-out unless `--force` is also passed.

### 4.3 Implicit check on CLI entry

All CLI commands EXCEPT `silo doctor` call `maybeFireUpdateCheck()` at top of entry. Detached child process per §3.5; no impact on CLI command latency.

---

## 5. MCP server integration

**Round-1 ChatGPT F2 fix — explicit SILO_DIR constant.** The current MCP server (`silo-mcp/server.js` on VPS) has projection-tree constants (`SILO_BASE = '/root/clawd-v3'`) but no Silo data-dir constant. Phase 2.3 adds one:

```js
const SILO_DIR = process.env.SILO_DIR || '/root/.silo';
const UPDATE_STATUS_PATH = join(SILO_DIR, 'update-status.json');
```

`UPDATE_STATUS_PATH` is used by:
- The notice-injection layer in `read_index`, `search`, `list_handoffs` response builders
- mtime-cached read pattern (mirrors the existing `loadTopicIndex` pattern in `silo-mcp-server.js:102-138`)

**Acceptance test:** after a forced check writes `/root/.silo/update-status.json`, calling MCP `read_index` surfaces `update_available` in `_silo_notices` without any file copied into `/root/clawd-v3/`.

**Opt-out check:** MCP also checks `SILO_DISABLE_UPDATE_CHECK` env var (per §3.6). When set, MCP omits both `update_available` and `update_check_unhealthy` notices regardless of cache contents.

**Missing file:** treat as no notice (cache absent → no `update_available` surface).
**Malformed file:** log warning, treat as missing.

---

## 6. New code surface

| File | Purpose | Est. LOC |
|---|---|---|
| `src/util/update-check.js` (new) | `compareVersions`, `readCache`, `writeCache`, `maybeFireUpdateCheck`, `isOptOut` | 80 |
| `src/util/update-check-worker.js` (new) | Standalone background script — fetch GitHub, worker-side cache re-read, write cache | 60 |
| `src/cli/silo.js` (extension) | `cmdDoctor` + register in dispatcher + auto-check at entry | 70 |
| `silo-mcp/server.js` (extension) | `SILO_DIR` constant + `_silo_notices` array injection + opt-out check | 50 |
| Tests | Unit tests for version compare, cache I/O, throttling, failure modes, env-var parsing, ESM imports | ~150 |
| **Total source** | | **~260** |

(Slightly larger than initial ~210 estimate due to round-1 fixes: SILO_DIR constant in MCP server, worker-side cache re-read, expanded schema, opt-out check in MCP.)

1-2 implementation sessions.

---

## 7. Acceptance criteria

**Core functionality:**
- [ ] `silo doctor` registered in CLI dispatcher; runs without error
- [ ] `silo doctor` prints local version + cached check status + latest available
- [ ] `silo doctor --check-updates` forces fresh fetch synchronously; updates cache; prints result
- [ ] `silo doctor --check-updates --force` overrides opt-out
- [ ] All commands except `silo doctor` fire detached `maybeFireUpdateCheck()` on entry
- [ ] Auto-check completes and writes cache even when host CLI command finishes in <100ms (detach mechanism verified)
- [ ] Within 24h of last check, no network call; cache is read and surfaced
- [ ] First run (cache absent) fires check
- [ ] **ESM imports work** — no `ReferenceError: require is not defined`, no `ReferenceError: __dirname is not defined`
- [ ] Worker re-reads cache at startup; exits without fetching if another worker just wrote a fresh cache
- [ ] Cache file path is `<silo-dir>/update-status.json` (same `--silo-dir` flag as the rest of the CLI)
- [ ] Cache written atomically via unique `${pid}.${ts}.tmp` + `fs.rename`

**MCP integration:**
- [ ] MCP `SILO_DIR` constant defaults to `/root/.silo` (env-override: `process.env.SILO_DIR`)
- [ ] MCP reads `update-status.json` from `SILO_DIR`, not from `SILO_BASE` (projection target)
- [ ] After forced CLI check writes `/root/.silo/update-status.json`, MCP `read_index` response surfaces `update_available` in `_silo_notices`
- [ ] `_silo_notices` is absent when no notices apply (not empty array, not null — aligned with Phase 2.2-FINAL §7.4)
- [ ] Each notice in the array has a `kind` discriminator
- [ ] `update_available` notice coexists with `pending_topic_suggestions` (both in same array)

**Opt-out:**
- [ ] `SILO_DISABLE_UPDATE_CHECK=1|true|yes|on` (case-insensitive) disables detached worker AND MCP notices
- [ ] `SILO_DISABLE_UPDATE_CHECK=0` keeps check enabled (matches Node convention)
- [ ] When opt-out is active, stale cached `update_available` notices are SUPPRESSED in MCP output
- [ ] `silo doctor` displays cache state even when opt-out (for diagnostics) but adds "checks are disabled" line

**Failure modes:**
- [ ] Network timeout / rate limit / parse error → `consecutive_failures` increments; status logged; no user-visible notice until counter ≥7
- [ ] `consecutive_failures >= 7` → `_silo_notices` carries `update_check_unhealthy` kind
- [ ] HTTP 404 (repo not found) → notice surfaced immediately (no threshold)
- [ ] Successful check resets `consecutive_failures` to 0
- [ ] On failure, `last_successful_check_at` and `last_successful_latest_version` preserved (NOT overwritten)

**Version comparator:**
- [ ] `0.1.0 > 0.1.0-rc1` (numeric > string)
- [ ] `0.1.0-m1 < 0.1.0-m2` (lexicographic prerelease compare)
- [ ] `0.2.0 > 0.1.99` (numeric per-position)
- [ ] `0.1.0+build1 === 0.1.0+build2` (build metadata stripped during parse)
- [ ] Documented limitation: `m10 < m2` (lexicographic on counter strings) — accepted

**Privacy / telemetry:**
- [ ] GitHub fetch is the only outbound network call from Silo
- [ ] User-Agent is `Silo` (no version)
- [ ] No other telemetry, no IP/timezone/locale leak

---

## 8. Risks (post-round-1)

| Risk | Severity post-mitigation |
|---|---|
| Auto-check killed by CLI exit before fetch completes | LOW — detached + unref |
| ESM/CommonJS mismatch crashes CLI | LOW — explicit ESM imports per §3.1 |
| MCP reads wrong cache path | LOW — explicit `SILO_DIR` constant per §5 |
| Silent persistent failures hide misconfiguration | LOW — consecutive-failure counter + immediate 404 surface |
| Comparator misbehavior on prerelease counters >9 | LOW — documented; workaround = pad counter |
| Env-var parsing ambiguity | LOW — explicit predicate |
| Cache file location ambiguity | LOW — pinned to `<silo-dir>/update-status.json` |
| GitHub API rate limit | LOW — 1 req/24h per deployment |
| Privacy fingerprinting via User-Agent | LOW — UA stripped to `Silo` |
| Concurrent worker tmp file collision | LOW — unique `${pid}.${ts}.tmp` |
| Stale cached notice after opt-out | LOW — MCP also checks env var |
| Cache file corruption | LOW — atomic write; parse error treated as missing |

---

## 9. Out of scope

- Auto-upgrade (user runs `git pull && npm install` manually)
- Pre-release / beta channel selection (always `releases/latest`)
- Custom GitHub repo URL (hardcoded `Studioscale/Silo`)
- Webhook / push notifications
- Telemetry beyond version check
- Anonymous usage metrics

---

## 10. Implementation order

1. Phase 2.2 (topic proposal) per `phase-2.2-FINAL.md` — 9-13 sessions
2. Phase 2.3 (this spec) — 1-2 sessions
3. Future phases (matrix admission gate, etc.) — TBD when prioritized

Numerical order per Helder's preference. Phase 2.3 implementation needs Phase 2.2 implemented first because the `_silo_notices` array exists in code only after Phase 2.2 ships.

---

## 11. Audit trail

- **Internal pre-flight pass:** 1 round, 10 findings (0 critical, 0 major, 8 minor, 2 question). All folded into v1 of this FINAL.
- **External audit:** 1 round, 3 reviewers. Findings:
  - ChatGPT: 6 (0 crit, 2 major, 4 minor, 0 q) — Approve with minor changes
  - Gemini: 1 (1 critical: ESM mismatch) — Approve with minor changes
  - Fresh Claude: 8 (0 crit, 0 major, 6 minor, 2 q) — Approve with minor changes
- **Convergent critical findings:** ESM/CommonJS mismatch (all 3 reviewers); MCP cache path mismatch (ChatGPT + Claude).
- All external findings folded into THIS revision. Implementation-ready.
- History preserved in `archive/phase-2.3-history/`.

---

*End of Phase 2.3 FINAL. Implementation-ready.*
