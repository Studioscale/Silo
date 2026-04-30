import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { retrieve } from '../src/retrieval/index.js';
import {
  parseTopicFile,
  parseSourceBlocks,
  parseCuratedSections,
  importDirectory,
} from '../src/import-jarvis/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'jarvis-sample');

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-imp-'));
  const writer = new LogWriter(dir);
  await writer.init();
  // Seed operator + helder principals for the imports to write under
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    isStateBearing: true,
    intentId: 'i:op1',
    principal: 'bootstrap',
    payload: { principal: 'helder', class: 'human' },
    ts: '2026-04-22T00:00:00Z',
  });
  await writer.append({
    type: 'PRINCIPAL_ACCESS_ENABLED',
    isStateBearing: true,
    intentId: 'i:op2',
    principal: 'bootstrap',
    payload: { principal: 'helder' },
    ts: '2026-04-22T00:00:01Z',
  });
  return { dir, writer };
}

test('parseTopicFile: extracts frontmatter, curated, source', async () => {
  const text = await fs.readFile(join(FIXTURE_DIR, 'project-alpha.md'), 'utf8');
  const { frontmatter, curated, source, slug } = parseTopicFile(text, 'project-alpha.md');
  assert.equal(slug, 'project-alpha');
  assert.equal(frontmatter.type, 'project');
  assert.deepEqual(frontmatter.tags, ['motorcycle', 'supplier', 'coating']);
  assert.ok(curated.includes('Current State'));
  assert.ok(source.includes('Coating defect discussion'));
});

test('parseTopicFile: missing frontmatter throws', () => {
  assert.throws(() => parseTopicFile('no frontmatter here', 'bad.md'), /no YAML frontmatter/);
});

test('parseSourceBlocks: extracts date + title + content from mini-headers', () => {
  const source = `### 2026-03-28 — Coating defect discussion
> some summary
content body line 1
content body line 2

### 2026-03-15 — Supplier decision
> summary
more content`;
  const blocks = parseSourceBlocks(source);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].date, '2026-03-28');
  assert.equal(blocks[0].title, 'Coating defect discussion');
  assert.ok(blocks[0].content.includes('content body line 1'));
  assert.equal(blocks[1].title, 'Supplier decision');
});

test('parseCuratedSections: splits on ## headers', () => {
  const curated = `## Current State

- item 1

## Decisions

- decision 1

## Open Issues

- issue 1`;
  const sections = parseCuratedSections(curated);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].heading, 'Current State');
  assert.ok(sections[0].content.includes('item 1'));
});

test('importDirectory: full jarvis-sample fixture imports end-to-end', async () => {
  const { writer } = await freshSilo();
  const result = await importDirectory({
    fromDir: FIXTURE_DIR,
    writer,
    principal: 'helder',
  });
  assert.equal(result.topicsImported, 3);
  assert.ok(result.eventsEmitted > 3);

  // Interpret + verify
  const state = await interpret(writer);
  assert.ok(state.topic_index.has('project-alpha'));
  assert.ok(state.topic_index.has('shopping'));
  assert.ok(state.topic_index.has('health'));

  // Tags preserved
  assert.ok(state.topic_index.get('project-alpha').tags.has('FACT'));
  assert.ok(state.topic_index.get('project-alpha').tags.has('CURATED'));
  assert.ok(state.topic_index.get('project-alpha').tags.has('SOURCE'));

  // Health is private → ACL restricted
  const healthAcl = state.acl_table.get('health');
  assert.ok(healthAcl.has('helder'));
  assert.ok(healthAcl.has('operator'));
});

test('importDirectory: search finds imported content end-to-end', async () => {
  const { writer } = await freshSilo();
  await importDirectory({ fromDir: FIXTURE_DIR, writer, principal: 'helder' });
  const state = await interpret(writer);

  const result = retrieve({
    state,
    query: 'supplier',
    mode: 'context_retrieval',
    principal: 'helder',
  });
  assert.ok(result.results.some((r) => r.slug === 'project-alpha'));

  const health = retrieve({
    state,
    query: 'metformin',
    mode: 'context_retrieval',
    principal: 'helder',
  });
  // helder is a reader of health (private sensitivity sealed to helder+operator)
  assert.ok(health.results.some((r) => r.slug === 'health'));
});

test('importDirectory: private topic blocks unauthorized principal', async () => {
  const { writer } = await freshSilo();
  await importDirectory({ fromDir: FIXTURE_DIR, writer, principal: 'helder' });
  const state = await interpret(writer);

  // bob is not in health's ACL
  const bobResult = retrieve({
    state,
    query: 'metformin',
    mode: 'context_retrieval',
    principal: 'bob',
  });
  assert.equal(bobResult.results.length, 0);
});
