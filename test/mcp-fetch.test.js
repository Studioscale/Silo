/**
 * Tests for silo-mcp/fetch.js — the new Stage 1 universal-client surface.
 *
 * Pure-fs helpers (parseFetchId, fetchTopic, enrichSearchResults) live in
 * silo-mcp/fetch.js with no MCP SDK imports, so they run in the silo
 * workspace test runner without silo-mcp/node_modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseFetchId,
  fetchTopic,
  enrichSearchResults,
} from '../silo-mcp/fetch.js';

// ── parseFetchId ────────────────────────────────────────────────────────────

test('parseFetchId: topic:<slug> → layer-2 default', () => {
  const d = parseFetchId('topic:hs-crm');
  assert.equal(d.kind, 'topic');
  assert.equal(d.slug, 'hs-crm');
  assert.equal(d.layer, 2);
});

test('parseFetchId: topic:<slug>#layer-1 → layer 1', () => {
  const d = parseFetchId('topic:pets#layer-1');
  assert.equal(d.kind, 'topic');
  assert.equal(d.slug, 'pets');
  assert.equal(d.layer, 1);
});

test('parseFetchId: topic:<slug>#layer-2 → layer 2 (explicit)', () => {
  const d = parseFetchId('topic:hs-precisao#layer-2');
  assert.equal(d.layer, 2);
});

test('parseFetchId: event:<date>:<seq> recognized (Stage 2 placeholder)', () => {
  const d = parseFetchId('event:2026-05-19:1543');
  assert.equal(d.kind, 'event');
  assert.equal(d.date, '2026-05-19');
  assert.equal(d.seq, 1543);
});

test('parseFetchId: handoff:<filename>.md recognized', () => {
  const d = parseFetchId('handoff:2026-05-19-hs-crm-refactor.md');
  assert.equal(d.kind, 'handoff');
  assert.equal(d.filename, '2026-05-19-hs-crm-refactor.md');
});

test('parseFetchId: rejects malformed IDs', () => {
  assert.equal(parseFetchId(''), null);
  assert.equal(parseFetchId('topic:Bad_Slug'), null);  // underscores
  assert.equal(parseFetchId('topic:PETS'), null);       // caps
  assert.equal(parseFetchId('topic:hs-crm#layer-9'), null);  // unknown layer
  assert.equal(parseFetchId('random-string'), null);
  assert.equal(parseFetchId(null), null);
  assert.equal(parseFetchId(42), null);
});

// ── fetchTopic ──────────────────────────────────────────────────────────────

async function freshTopicsDir() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-fetch-test-'));
  // Create a minimal topic file matching Silo's three-layer markdown shape.
  const fileContent = `---
topic: pets
type: hobby
tags: [rover, walks]
status: active
created: 2026-04-01
summary: >
  Rover loves walks. Daily routine + vet schedule.
---

<!-- CURATED_START -->

## Current State

- Daily 30-minute walks; morning + evening
- Vet appointment scheduled for 2026-06-15

## Routine

- Feed at 7am and 6pm

<!-- CURATED_END -->

<!-- SOURCE_START -->

### 2026-04-22 — Initial vet visit
> Rover got his annual checkup. All clear.

<!-- SOURCE_END -->
`;
  await fs.writeFile(join(dir, 'pets.md'), fileContent);
  return dir;
}

test('fetchTopic: topic:<slug> returns curated Layer 2 with metadata', async () => {
  const topicsDir = await freshTopicsDir();
  const knownSlugs = new Set(['pets']);
  const descriptor = parseFetchId('topic:pets');
  const out = await fetchTopic({ descriptor, topicsDir, knownSlugs });
  assert.equal(out.id, 'topic:pets#layer-2');
  assert.match(out.title, /pets/);
  assert.match(out.text, /Daily 30-minute walks/);
  assert.match(out.text, /Vet appointment/);
  // Layer 2 should NOT include the Layer 3 SOURCE content.
  assert.doesNotMatch(out.text, /Rover got his annual checkup/);
  assert.equal(out.metadata.source_type, 'topic');
  assert.equal(out.metadata.layer, 2);
  assert.equal(out.metadata.topic_slug, 'pets');
  assert.match(out.url, /^silo:\/\/topic\/pets/);
});

test('fetchTopic: topic:<slug>#layer-1 returns header fields', async () => {
  const topicsDir = await freshTopicsDir();
  const knownSlugs = new Set(['pets']);
  const descriptor = parseFetchId('topic:pets#layer-1');
  const out = await fetchTopic({ descriptor, topicsDir, knownSlugs });
  assert.equal(out.metadata.layer, 1);
  assert.match(out.text, /topic: pets/);
  assert.match(out.text, /type: hobby/);
  // Should NOT include the curated content.
  assert.doesNotMatch(out.text, /Daily 30-minute walks/);
});

test('fetchTopic: unknown slug → FETCH_NOT_FOUND', async () => {
  const topicsDir = await freshTopicsDir();
  const knownSlugs = new Set(['pets']);
  const descriptor = parseFetchId('topic:nonexistent');
  const out = await fetchTopic({ descriptor, topicsDir, knownSlugs });
  assert.ok(out.error);
  assert.equal(out.error.code, 'FETCH_NOT_FOUND');
});

test('fetchTopic: slug in index but file missing → FETCH_FILE_MISSING', async () => {
  const topicsDir = await fs.mkdtemp(join(tmpdir(), 'silo-fetch-test-'));
  // Don't create the file; just claim the slug exists in the index.
  const knownSlugs = new Set(['ghost']);
  const descriptor = parseFetchId('topic:ghost');
  const out = await fetchTopic({ descriptor, topicsDir, knownSlugs });
  assert.ok(out.error);
  assert.equal(out.error.code, 'FETCH_FILE_MISSING');
});

// ── enrichSearchResults ─────────────────────────────────────────────────────

test('enrichSearchResults: adds id/title/url; preserves score+text', () => {
  const raw = [
    { score: 4.2, text: 'Chose Flask/SQLite for the CRM backend. Django too heavy.' },
    { score: 2.1, text: 'Pipedrive sync via webhook; latency ~500ms.' },
  ];
  const enriched = enrichSearchResults(raw, 'CRM backend');
  assert.equal(enriched.length, 2);
  for (const r of enriched) {
    assert.match(r.id, /^search-result:[0-9a-f]{12}$/);
    assert.ok(r.title.length > 0);
    assert.match(r.url, /^silo:\/\/search-result\/[0-9a-f]{12}$/);
    assert.equal(r.metadata.source_type, 'search_result');
    assert.equal(r.metadata.query, 'CRM backend');
    assert.equal(typeof r.score, 'number');
    assert.equal(typeof r.text, 'string');
  }
});

test('enrichSearchResults: stable IDs across calls with same query+text', () => {
  const raw = [{ score: 1, text: 'stable test text' }];
  const a = enrichSearchResults(raw, 'query');
  const b = enrichSearchResults(raw, 'query');
  assert.equal(a[0].id, b[0].id);
});

test('enrichSearchResults: different query → different ID for same text', () => {
  const raw = [{ score: 1, text: 'same text' }];
  const a = enrichSearchResults(raw, 'query A');
  const b = enrichSearchResults(raw, 'query B');
  assert.notEqual(a[0].id, b[0].id);
});

test('enrichSearchResults: title truncates at word boundary with ellipsis', () => {
  const longText = 'This is a long search result text that exceeds the eighty character title limit and should be cut at a word boundary so it reads naturally without splitting mid-word';
  const enriched = enrichSearchResults([{ score: 1, text: longText }], 'q');
  assert.ok(enriched[0].title.length <= 81); // 80 + ellipsis
  assert.ok(enriched[0].title.endsWith('…'));
  // Title shouldn't end mid-word.
  assert.doesNotMatch(enriched[0].title.slice(0, -1), /[a-z]…$/);
});

test('enrichSearchResults: empty input → empty array', () => {
  assert.deepEqual(enrichSearchResults([], 'q'), []);
  assert.deepEqual(enrichSearchResults(null, 'q'), []);
});
