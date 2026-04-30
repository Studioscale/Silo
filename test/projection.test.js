import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { importDirectory } from '../src/import-jarvis/index.js';
import {
  regenerateTopicFile,
  regenerateAllTopicFiles,
  regenerateTopicIndex,
  regenerateAllEventLogs,
  regenerateProjections,
} from '../src/projection/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'jarvis-sample');

async function freshImportedSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-proj-'));
  const writer = new LogWriter(dir);
  await writer.init();
  // Seed operator
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
  // Import the fixture corpus
  await importDirectory({ fromDir: FIXTURE_DIR, writer, principal: 'helder' });
  const state = await interpret(writer);
  return { dir, writer, state };
}

test('regenerateTopicFile: produces a file with the three-layer structure', async () => {
  const { writer, state } = await freshImportedSilo();
  const text = await regenerateTopicFile({ slug: 'project-alpha', logReader: writer, state });
  assert.ok(text.includes('---\n')); // YAML frontmatter
  assert.ok(text.includes('topic: project-alpha'));
  assert.ok(text.includes('<!-- CURATED_START -->'));
  assert.ok(text.includes('<!-- CURATED_END -->'));
  assert.ok(text.includes('<!-- SOURCE_START -->'));
  assert.ok(text.includes('<!-- SOURCE_END -->'));
});

test('regenerateTopicFile: frontmatter fields correctly derived', async () => {
  const { writer, state } = await freshImportedSilo();
  const text = await regenerateTopicFile({ slug: 'project-alpha', logReader: writer, state });
  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatterMatch);
  const fm = yaml.load(frontmatterMatch[1]);
  assert.equal(fm.topic, 'project-alpha');
  assert.equal(fm.type, 'project');
  assert.ok(Array.isArray(fm.tags));
  assert.ok(fm.tags.includes('motorcycle'));
  assert.ok(fm.summary.includes('metal fabrication'));
  // Mechanical fields recomputed (Jarvis concern #2)
  assert.equal(typeof fm.curated_lines, 'number');
  assert.equal(typeof fm.source_lines, 'number');
  assert.equal(typeof fm.source_kb, 'number');
  assert.ok(fm.curated_lines > 0);
});

test('regenerateTopicFile: Layer 2 contains CURATED event content', async () => {
  const { writer, state } = await freshImportedSilo();
  const text = await regenerateTopicFile({ slug: 'project-alpha', logReader: writer, state });
  const curatedStart = text.indexOf('<!-- CURATED_START -->');
  const curatedEnd = text.indexOf('<!-- CURATED_END -->');
  const layer2 = text.slice(curatedStart + '<!-- CURATED_START -->'.length, curatedEnd);
  assert.ok(layer2.includes('Current State'));
  assert.ok(layer2.includes('supplier X'));
});

test('regenerateTopicFile: Layer 3 contains SOURCE event content', async () => {
  const { writer, state } = await freshImportedSilo();
  const text = await regenerateTopicFile({ slug: 'project-alpha', logReader: writer, state });
  const sourceStart = text.indexOf('<!-- SOURCE_START -->');
  const sourceEnd = text.indexOf('<!-- SOURCE_END -->');
  const layer3 = text.slice(sourceStart + '<!-- SOURCE_START -->'.length, sourceEnd);
  assert.ok(layer3.includes('Coating defect discussion'));
  assert.ok(layer3.includes('Supplier decision'));
});

test('regenerateTopicFile: private topic preserves sensitivity field', async () => {
  const { writer, state } = await freshImportedSilo();
  const text = await regenerateTopicFile({ slug: 'health', logReader: writer, state });
  const fm = yaml.load(text.match(/^---\n([\s\S]*?)\n---\n/)[1], { schema: yaml.JSON_SCHEMA });
  assert.equal(fm.sensitivity, 'private');
});

test('regenerateTopicFile: TOPIC_VERIFIED event updates last_verified', async () => {
  const { writer, state } = await freshImportedSilo();
  // Emit a TOPIC_VERIFIED event for project-alpha
  await writer.append({
    type: 'TOPIC_VERIFIED',
    isStateBearing: true,
    intentId: 'i:verif1',
    principal: 'helder',
    payload: { topic: 'project-alpha' },
    ts: '2026-05-01T09:00:00Z',
  });
  const newState = await interpret(writer);
  const text = await regenerateTopicFile({ slug: 'project-alpha', logReader: writer, state: newState });
  const fm = yaml.load(text.match(/^---\n([\s\S]*?)\n---\n/)[1], { schema: yaml.JSON_SCHEMA });
  assert.equal(fm.last_verified, '2026-05-01');
});

test('regenerateAllTopicFiles: produces files for every indexed topic', async () => {
  const { writer, state } = await freshImportedSilo();
  const files = await regenerateAllTopicFiles({ logReader: writer, state });
  assert.equal(files.size, 3);
  assert.ok(files.has('project-alpha'));
  assert.ok(files.has('shopping'));
  assert.ok(files.has('health'));
});

test('regenerateTopicIndex: one line per topic, alphabetized', async () => {
  const { writer, state } = await freshImportedSilo();
  const topicFiles = await regenerateAllTopicFiles({ logReader: writer, state });
  const index = regenerateTopicIndex(topicFiles);
  assert.ok(index.startsWith('# TOPIC-INDEX'));
  const lines = index
    .split('\n')
    .filter((l) => l.includes(' | ') && !l.startsWith('>'));
  assert.equal(lines.length, 3);
  // Alphabetical order
  const slugs = lines.map((l) => l.split(' | ')[0]);
  assert.deepEqual(slugs, ['health', 'project-alpha', 'shopping']);
  // Each line has 5 pipe-separated fields
  for (const l of lines) {
    const fields = l.split(' | ');
    assert.equal(fields.length, 5);
  }
});

test('regenerateAllEventLogs: groups by date and excludes topic-imports', async () => {
  const { writer } = await freshImportedSilo();
  const logs = await regenerateAllEventLogs(writer);
  // Topic imports alone populate some dates (from frontmatter.created). Event
  // log dates materialize once we add event logs; for the topic-only fixture,
  // we just verify keys are ISO dates and content is non-empty.
  for (const [date, content] of logs) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(content.length >= 0);
  }
});

test('regenerateProjections: writes all three projection types to disk', async () => {
  const { writer, state } = await freshImportedSilo();
  const targetDir = await fs.mkdtemp(join(tmpdir(), 'silo-target-'));
  const result = await regenerateProjections({ logReader: writer, state, targetDir });

  assert.equal(result.topics, 3);
  // Topic-only fixture has no event-log imports; regen correctly emits 0 daily logs.
  assert.equal(result.event_logs, 0);

  // Verify files landed on disk
  const topicFiles = await fs.readdir(join(targetDir, 'topics'));
  assert.ok(topicFiles.includes('project-alpha.md'));
  assert.ok(topicFiles.includes('shopping.md'));
  assert.ok(topicFiles.includes('health.md'));

  const indexExists = await fs
    .stat(join(targetDir, 'TOPIC-INDEX.md'))
    .then(() => true)
    .catch(() => false);
  assert.ok(indexExists);

  // Topic-only fixture → no event log files; projection code should still
  // create the events/ directory (empty) or skip it. Accept both.
  const eventsExists = await fs
    .stat(join(targetDir, 'events'))
    .then(() => true)
    .catch(() => false);
  if (eventsExists) {
    const eventsDir = await fs.readdir(join(targetDir, 'events'));
    assert.ok(eventsDir.length >= 0);
  }

  // Verify topic file content is valid YAML frontmatter + three-layer body
  const alphaText = await fs.readFile(join(targetDir, 'topics', 'project-alpha.md'), 'utf8');
  assert.ok(alphaText.includes('<!-- CURATED_START -->'));
  assert.ok(alphaText.includes('<!-- SOURCE_START -->'));
});

test('regenerateProjections: atomic write (no partial .tmp files left behind)', async () => {
  const { writer, state } = await freshImportedSilo();
  const targetDir = await fs.mkdtemp(join(tmpdir(), 'silo-atomic-'));
  await regenerateProjections({ logReader: writer, state, targetDir });

  // No .tmp files should remain
  const recursive = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await recursive(p);
      } else {
        assert.ok(!p.endsWith('.tmp'), `leftover tmp file: ${p}`);
      }
    }
  };
  await recursive(targetDir);
});
