import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import {
  parseEventLine,
  importEventLogFile,
  importEventLogDirectory,
} from '../src/import-jarvis/events.js';
import { importDirectory } from '../src/import-jarvis/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_FIXTURE = join(__dirname, 'fixtures', 'jarvis-events-sample');
const TOPICS_FIXTURE = join(__dirname, 'fixtures', 'jarvis-sample');

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-evt-'));
  const writer = new LogWriter(dir);
  await writer.init();
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

// ─── parseEventLine ──────────────────────────────────────────────────────────

test('parseEventLine: blank line returns null', () => {
  assert.equal(parseEventLine(''), null);
  assert.equal(parseEventLine('   '), null);
});

test('parseEventLine: plain tag', () => {
  const r = parseEventLine('[FACT] project-alpha: chose supplier X');
  assert.equal(r.kind, 'event');
  assert.equal(r.tag, 'FACT');
  assert.equal(r.auto_extracted, false);
  assert.equal(r.confidence, null);
  assert.equal(r.slug, 'project-alpha');
  assert.equal(r.principal, null);
  assert.equal(r.content, 'chose supplier X');
});

test('parseEventLine: tag with confidence', () => {
  const r = parseEventLine('[FACT:CONFIRMED] shopping: ordered tungsten');
  assert.equal(r.tag, 'FACT');
  assert.equal(r.confidence, 'CONFIRMED');
  assert.equal(r.auto_extracted, false);
});

test('parseEventLine: AUTO- prefix + confidence', () => {
  const r = parseEventLine('[AUTO-DECISION:TENTATIVE] project-alpha: reimburse customer');
  assert.equal(r.tag, 'DECISION');
  assert.equal(r.auto_extracted, true);
  assert.equal(r.confidence, 'TENTATIVE');
});

test('parseEventLine: [principal] prefix extracted from content', () => {
  const r = parseEventLine('[EVENT] shopping: [helder] went to Leroy');
  assert.equal(r.principal, 'helder');
  assert.equal(r.content, 'went to Leroy');
});

test('parseEventLine: [principal] with dots and dashes', () => {
  const r = parseEventLine('[EVENT] shopping: [desktop-claude] logged fact via MCP');
  assert.equal(r.principal, 'desktop-claude');
});

test('parseEventLine: HTML comment returns kind=comment', () => {
  const r = parseEventLine('<!-- auto-extracted: 2026-03-15T23:10:00Z -->');
  assert.equal(r.kind, 'comment');
  assert.equal(r.comment, 'auto-extracted: 2026-03-15T23:10:00Z');
});

test('parseEventLine: markdown heading returns kind=header (not unrecognized)', () => {
  const r = parseEventLine('# Event Log — 2026-04-04');
  assert.equal(r.kind, 'header');
  const r2 = parseEventLine('## Summary');
  assert.equal(r2.kind, 'header');
});

test('parseEventLine: malformed line returns unrecognized', () => {
  const r = parseEventLine('malformed line without tag');
  assert.equal(r.kind, 'unrecognized');
  assert.equal(r.raw, 'malformed line without tag');
});

test('parseEventLine: invalid slug (uppercase) is unrecognized', () => {
  const r = parseEventLine('[FACT] BadSlug: content');
  assert.equal(r.kind, 'unrecognized');
});

test('parseEventLine: invalid slug (starts with dash) is unrecognized', () => {
  const r = parseEventLine('[FACT] -leading: content');
  assert.equal(r.kind, 'unrecognized');
});

test('parseEventLine: all 8 tag types recognized', () => {
  const tags = ['EVENT', 'FACT', 'DECISION', 'CHANGED', 'TODO', 'PROCEDURE', 'CURATION', 'SECURITY'];
  for (const tag of tags) {
    const r = parseEventLine(`[${tag}] slug-x: content for ${tag}`);
    assert.equal(r.kind, 'event', `expected event for tag ${tag}`);
    assert.equal(r.tag, tag);
  }
});

// ─── importEventLogFile ──────────────────────────────────────────────────────

test('importEventLogFile: imports all events from a fixture file', async () => {
  const { writer } = await freshSilo();
  const result = await importEventLogFile({
    path: join(EVENTS_FIXTURE, '2026-03-15.md'),
    writer,
    defaultPrincipal: 'helder',
  });
  assert.equal(result.date, '2026-03-15');
  assert.equal(result.eventCount, 8);
  // "# Events — 2026-03-15" is a header (skipped, not unrecognized).
  // Unrecognized = "malformed line without tag" + "[EVENT] bad-slug!: ..."
  assert.equal(result.unrecognizedCount, 2);
});

test('importEventLogFile: [principal] prefix overrides defaultPrincipal', async () => {
  const { writer } = await freshSilo();
  await importEventLogFile({
    path: join(EVENTS_FIXTURE, '2026-03-15.md'),
    writer,
    defaultPrincipal: 'operator',
  });
  const state = await interpret(writer);
  const shopping = state.topic_content.get('shopping');
  assert.ok(shopping);
  const helderEvents = shopping.filter((e) => e.principal === 'helder');
  assert.ok(helderEvents.length > 0, 'expected a shopping event with principal=helder from [helder] prefix');
});

test('importEventLogFile: skips non-date filenames', async () => {
  const { writer } = await freshSilo();
  const result = await importEventLogFile({
    path: join(EVENTS_FIXTURE, 'README.md'),
    writer,
    defaultPrincipal: 'helder',
  });
  assert.equal(result.skipped, true);
});

test('importEventLogFile: emits within-day monotonic timestamps (by seq)', async () => {
  const { writer } = await freshSilo();
  await importEventLogFile({
    path: join(EVENTS_FIXTURE, '2026-03-15.md'),
    writer,
    defaultPrincipal: 'helder',
  });
  // Read raw entries in log order and check ts is monotonic for the imported day
  const imported = [];
  for await (const { entry } of writer.readAll()) {
    if (entry.type !== 'write_event') continue;
    if (!entry.ts.startsWith('2026-03-15')) continue;
    imported.push(entry);
  }
  assert.equal(imported.length, 8);
  for (let i = 1; i < imported.length; i++) {
    assert.ok(
      imported[i].ts >= imported[i - 1].ts,
      `expected monotonic ts at index ${i} (${imported[i - 1].ts} → ${imported[i].ts})`,
    );
  }
});

test('importEventLogFile: confidence tier + auto_extracted flag land in payload', async () => {
  const { writer } = await freshSilo();
  await importEventLogFile({
    path: join(EVENTS_FIXTURE, '2026-03-15.md'),
    writer,
    defaultPrincipal: 'helder',
  });

  // Read back via readAll and look for the AUTO-FACT:TENTATIVE entry
  let foundTentative = false;
  let foundAutoExtracted = false;
  for await (const { entry } of writer.readAll()) {
    if (entry.type !== 'write_event') continue;
    if (entry.payload.confidence === 'TENTATIVE') foundTentative = true;
    if (entry.payload.imported?.auto_extracted === true) foundAutoExtracted = true;
  }
  assert.ok(foundTentative, 'expected at least one event with TENTATIVE confidence');
  assert.ok(foundAutoExtracted, 'expected at least one event with auto_extracted=true');
});

test('importEventLogFile: context_comment attached to following auto-extracted events', async () => {
  const { writer } = await freshSilo();
  await importEventLogFile({
    path: join(EVENTS_FIXTURE, '2026-03-15.md'),
    writer,
    defaultPrincipal: 'helder',
  });
  // Scan for any entry whose imported.context_comment includes the ISO timestamp
  let found = false;
  for await (const { entry } of writer.readAll()) {
    if (entry.type !== 'write_event') continue;
    if (entry.payload.imported?.context_comment?.includes('auto-extracted:')) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'expected context_comment to persist on at least one event');
});

// ─── importEventLogDirectory ─────────────────────────────────────────────────

test('importEventLogDirectory: processes all YYYY-MM-DD.md files', async () => {
  const { writer } = await freshSilo();
  const result = await importEventLogDirectory({
    fromDir: EVENTS_FIXTURE,
    writer,
    defaultPrincipal: 'helder',
  });
  assert.equal(result.filesProcessed, 2); // 2026-03-15.md, 2026-03-28.md (README.md excluded)
  assert.equal(result.totalEvents, 8 + 4); // 8 from day 1, 4 from day 2
});

test('importEventLogDirectory: events span multiple dates', async () => {
  const { writer } = await freshSilo();
  await importEventLogDirectory({
    fromDir: EVENTS_FIXTURE,
    writer,
    defaultPrincipal: 'helder',
  });
  const state = await interpret(writer);
  const alpha = state.topic_content.get('project-alpha') ?? [];
  const dates = new Set(alpha.map((e) => e.ts.slice(0, 10)));
  assert.ok(dates.has('2026-03-15'));
  assert.ok(dates.has('2026-03-28'));
});

// ─── importDirectory auto-detect layout ──────────────────────────────────────

test('importDirectory: auto-detects topics/+events/ layout and imports both', async () => {
  // Build a composite Jarvis-shaped dir with topics/ and events/ subdirs
  const root = await fs.mkdtemp(join(tmpdir(), 'silo-layout-'));
  await fs.mkdir(join(root, 'topics'));
  await fs.mkdir(join(root, 'events'));
  for (const f of ['project-alpha.md', 'shopping.md', 'health.md']) {
    await fs.copyFile(join(TOPICS_FIXTURE, f), join(root, 'topics', f));
  }
  for (const f of ['2026-03-15.md', '2026-03-28.md']) {
    await fs.copyFile(join(EVENTS_FIXTURE, f), join(root, 'events', f));
  }

  const { writer } = await freshSilo();
  const result = await importDirectory({ fromDir: root, writer, principal: 'helder' });

  assert.equal(result.topicsImported, 3);
  assert.ok(result.events, 'expected event log import result to be attached');
  assert.equal(result.events.filesProcessed, 2);
  assert.equal(result.events.totalEvents, 12);
  // Topic events + event log events
  assert.ok(result.eventsEmitted > 12);
});

test('importDirectory: legacy flat layout still works (backward compat)', async () => {
  const { writer } = await freshSilo();
  const result = await importDirectory({
    fromDir: TOPICS_FIXTURE, // flat dir, just topic files
    writer,
    principal: 'helder',
  });
  assert.equal(result.topicsImported, 3);
  assert.equal(result.events, undefined);
});
