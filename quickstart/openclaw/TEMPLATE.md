# Topic File Template — JARVIS v3

> **For the Curator:** This file is the canonical template for all v3 topic files.
> When creating a new topic file, copy this template and fill in the fields.
> The validator script checks every topic file against this structure.
>
> **For Jarvis:** When a user says "create a topic file for X", copy this template
> to `topics/[slug].md`, fill in the header, and leave Layers 2 and 3 empty
> (with markers intact). Then run the topic-index-generator.

---

## How to Use

1. Copy this file to `topics/[slug].md` (slug = lowercase, hyphens, no spaces)
2. Fill in all **required** header fields
3. Remove the `<!-- INSTRUCTIONS: ... -->` comments from inside the layers
4. Add initial curated facts to Layer 2 if known, otherwise leave empty
5. Run the file validator to confirm structure is correct
6. Run the topic-index-generator to update TOPIC-INDEX.md

---

## Template

````markdown
---
topic: SLUG_HERE
type: TYPE_HERE
tags: [tag1, tag2, tag3]
entities: [Entity1, Entity2]
status: active
created: YYYY-MM-DD
last_verified: YYYY-MM-DD
last_curated: YYYY-MM-DD
curated_lines: 0
source_lines: 0
source_kb: 0
summary: >
  Two to three sentences describing what this file covers,
  written for search matching — include key terms someone
  might use when looking for this information.
---

<!-- CURATED_START -->

<!-- INSTRUCTIONS: Layer 2 — Curated Facts
  - Target: 50-150 lines of distilled knowledge
  - No narrative, no conversation — clean structured information
  - Updated IN PLACE when facts change
  - Every in-place change MUST have a changelog entry (see below)
  - Use markdown headers (##, ###) to organize sections
  - This is what Jarvis loads when the topic is relevant
-->

<!-- CURATED_END -->

<!-- SOURCE_START -->

<!-- INSTRUCTIONS: Layer 3 — Source Material
  - Raw conversation excerpts and detailed context
  - Main agent NEVER reads this directly
  - Searchable via BM25 (free) and semantic search (paid)
  - Each saved block MUST have a mini-header (see format below)
  - When this layer exceeds the archive threshold (~30 KB default),
    oldest material moves to [slug].archive.md
-->

<!-- SOURCE_END -->
````

---

## Field Reference

### Required Fields

| Field | Type | Rules | Example |
|-------|------|-------|---------|
| `topic` | string | Lowercase slug matching filename. No spaces, use hyphens. Event log entries reference this. | `z900rs` |
| `type` | enum | One of: `project`, `hobby`, `business`, `personal`, `reference` | `hobby` |
| `tags` | list | Keywords that help Jarvis decide whether to load this file. Seed manually at creation. Curation may propose additions. | `[motorcycle, kawasaki, z900rs]` |
| `entities` | list | People, companies, products, places mentioned in this file. For cross-referencing. | `[Wanderson, Euro Motors]` |
| `status` | enum | One of: `active`, `paused`, `archived`, `reference`. Archived files are excluded from the topic index. | `active` |
| `created` | date | When the file was first created. Set once, never changed. | `2025-08-14` |
| `last_verified` | date | When the curated facts were last confirmed accurate. Staleness check triggers at 30 days for `project`/`business` types, 60 days for `hobby`/`personal`/`reference` types. | `2026-03-28` |
| `last_curated` | date | When the curation cycle last processed this file. Set by the curation script, not by Jarvis or manually. | `2026-03-28` |
| `curated_lines` | int | Line count of Layer 2. Recalculated by the validator script. Do not set manually. | `47` |
| `source_lines` | int | Line count of Layer 3. Recalculated by the validator script. Do not set manually. | `312` |
| `source_kb` | float | Size of Layer 3 in KB. Recalculated by the validator script. Used for archive threshold. | `18.4` |
| `summary` | text | 2-3 sentences for search matching. Written at creation, updated by curation when content changes significantly. | See template above |

### Optional Fields

| Field | Type | Rules | Example |
|-------|------|-------|---------|
| `sensitivity` | enum | `private` = never loaded in group chats. Omit if not sensitive. | `private` |
| `archive_threshold` | int | Override the default ~30 KB threshold for this file. Omit to use default. | `50` |
| `related` | list | Links to related topic slugs. Deferred feature — include if useful, but no tooling reads it yet. | `[hs-db, hs-crm]` |

---

## Layer 2 — Curated Facts Format

Organize with markdown headers. Keep it factual and scannable.

```markdown
<!-- CURATED_START -->

## Current State

- Bike: 2024 Kawasaki Z900RS, bought 2024-06-15
- Mileage: ~4,200 km (as of 2026-03-28)
- Insurance: Porto Seguro, policy #12345, renews 2026-06

## Modifications

- Exhaust: stock (decision pending — see changelog)
- Bar-end mirrors: installed 2025-01-10

## Maintenance

- Last service: 2026-02-15, 3,800 km, oil + filter at Euro Motors
- Next service: ~6,000 km or 2026-08

## Changelog

- 2026-03-28: [mileage] 3,800 km -> ~4,200 km. Routine update.
- 2026-03-15: [exhaust] Narrowed to Akrapovic vs SC Project. Leaning Akrapovic. Was: "considering options."
- 2026-01-10: [mirrors] Added bar-end mirrors. Was: stock mirrors.

<!-- CURATED_END -->
```

### Changelog Rules

Every in-place update to Layer 2 MUST add a changelog entry:

```
- YYYY-MM-DD: [field-or-section] new value. Was: old value. Reason (if not obvious).
```

- The changelog lives at the **bottom** of Layer 2, inside the CURATED markers
- Entries are reverse-chronological (newest first)
- Include the old value — this is the safety net for in-place updates
- If the reason is obvious from context, it can be omitted
- Changelog entries are never deleted (they move to the archive with Layer 3 material if the file is ever restructured)

---

## Layer 3 — Source Material Format

Every saved block gets a mini-header:

```markdown
<!-- SOURCE_START -->

### 2026-04-01 — Exhaust options comparison
> Discussed Akrapovic vs SC Project pricing with Wanderson.
> Leaning toward Akrapovic based on sound and build quality.

Helder: What do you think about the Akrapovic for the Z900RS?
Wanderson: I've installed a few. The titanium one sounds amazing but
it's almost double the price of the SC Project...
(rest of conversation excerpt)

### 2026-03-15 — Bar-end mirror installation notes
> Installed Rizoma mirrors. Required adapter for Z900RS handlebar diameter.

(conversation or notes)

<!-- SOURCE_END -->
```

### Mini-Header Rules

- Format: `### YYYY-MM-DD — Short descriptive title`
- Followed by a blockquote summary (1-3 lines) — this is what BM25 search matches against
- Then the raw content (conversation, notes, whatever)
- Newest entries go at the **top** of Layer 3 (reverse-chronological, so archival removes from the bottom)

---

## Archive File Format

When Layer 3 exceeds the archive threshold, oldest blocks move to `topics/[slug].archive.md`:

```markdown
---
topic: z900rs
archive_of: topics/z900rs.md
date_range: 2025-08-14 to 2025-12-31
source_lines: 483
source_kb: 28.7
---

<!-- SOURCE_START -->

(moved blocks, preserving their mini-headers exactly as they were)

<!-- SOURCE_END -->
```

- Archive files are searchable via BM25 and semantic search
- Archive files are NEVER loaded by any agent directly
- Archive files are NEVER curated — they are frozen records
- If a second archive is needed, it becomes `[slug].archive-2.md` (with its own date range)

---

## Compressed Index Entry Format (for TOPIC-INDEX.md)

The topic-index-generator script reads the full header and produces one line:

```
SLUG | TYPE | tag1,tag2,tag3 | STATUS | summary (first sentence only)
```

Examples:
```
z900rs | hobby | motorcycle,kawasaki,z900rs,exhaust,maintenance | active | 2024 Kawasaki Z900RS mods and maintenance.
hs-crm | project | CRM,Jarvis,sales,pipeline,deals | active | Custom CRM system replacing Pipedrive.
health | personal | health,diet,meds,doctor | active | Health tracking and medical information.
```

Target: ~100-150 characters per entry. 20 files = 2-3 KB total in TOPIC-INDEX.md.

---

## Validator Checklist

The file-validator script checks every topic file against these rules:

1. File starts with `---` (YAML frontmatter opening)
2. All required fields are present and non-empty
3. `topic` slug matches the filename (e.g., `topic: z900rs` in file `z900rs.md`)
4. `type` is one of the allowed enum values
5. `status` is one of the allowed enum values
6. `<!-- CURATED_START -->` exists exactly once
7. `<!-- CURATED_END -->` exists exactly once
8. `<!-- SOURCE_START -->` exists exactly once
9. `<!-- SOURCE_END -->` exists exactly once
10. Markers appear in correct order: CURATED_START before CURATED_END before SOURCE_START before SOURCE_END
11. No content exists between CURATED_END and SOURCE_START (gap between layers must be empty or whitespace only)
12. `curated_lines` and `source_lines` match actual line counts (recalculated by validator)
13. `source_kb` matches actual Layer 3 size (recalculated by validator)
14. After recalculating and writing header updates, validator restores original file mtime via `touch -r`

Validation failures are logged to CURATION-LOG.md with the filename and which check(s) failed.
