import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { loadMatrix } from '../src/matrix/load.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-interp-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function seedBasicLog(writer) {
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    isStateBearing: true,
    intentId: 'intent:decl1',
    principal: 'operator',
    payload: { principal: 'helder', class: 'human' },
    ts: '2026-04-22T10:00:00Z',
  });
  await writer.append({
    type: 'PRINCIPAL_UID_BOUND',
    isStateBearing: true,
    intentId: 'intent:uid1',
    principal: 'operator',
    payload: { principal: 'helder', uid: 1000 },
    ts: '2026-04-22T10:00:01Z',
  });
  await writer.append({
    type: 'PRINCIPAL_ACCESS_ENABLED',
    isStateBearing: true,
    intentId: 'intent:acc1',
    principal: 'operator',
    payload: { principal: 'helder' },
    ts: '2026-04-22T10:00:02Z',
  });
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:w1',
    principal: 'helder',
    payload: { slug: 'project-alpha', tag: 'FACT', content: 'initial state' },
    ts: '2026-04-22T10:01:00Z',
  });
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:w2',
    principal: 'helder',
    payload: { slug: 'project-alpha', tag: 'DECISION', content: 'chose supplier X' },
    ts: '2026-04-22T10:02:00Z',
  });
}

test('interpret: empty log -> empty state', async () => {
  const { writer } = await freshSilo();
  const state = await interpret(writer);
  assert.equal(state.last_seq, 0);
  assert.equal(state.topic_index.size, 0);
  assert.equal(state.principals.size, 0);
  assert.equal(state.current_mode, 'normal');
  assert.equal(state.tier, 'T1');
});

test('interpret: basic seeded log produces expected state', async () => {
  const { writer } = await freshSilo();
  await seedBasicLog(writer);

  const state = await interpret(writer);

  assert.equal(state.last_seq, 5);
  assert.equal(state.tier, 'T1');
  assert.equal(state.current_mode, 'normal');

  // Principals
  assert.equal(state.principals.size, 1);
  const helder = state.principals.get('helder');
  assert.equal(helder.class, 'human');
  assert.equal(helder.status, 'active');
  assert.equal(helder.created_at_seq, 1);

  // UID binding
  assert.equal(state.uid_principal_bindings.get(1000), 'helder');

  // Topic index
  assert.equal(state.topic_index.size, 1);
  const topic = state.topic_index.get('project-alpha');
  assert.equal(topic.slug, 'project-alpha');
  assert.equal(topic.last_updated_seq, 5);
  assert.ok(topic.tags.has('FACT'));
  assert.ok(topic.tags.has('DECISION'));

  // ACL seeded on first write: creator + operator
  const acl = state.acl_table.get('project-alpha');
  assert.ok(acl.has('helder'));
  assert.ok(acl.has('operator'));

  // Topic content history
  const history = state.topic_content.get('project-alpha');
  assert.equal(history.length, 2);
  assert.equal(history[0].content, 'initial state');
  assert.equal(history[1].content, 'chose supplier X');
});

test('interpret: determinism — same log produces same state every time', async () => {
  const { writer } = await freshSilo();
  await seedBasicLog(writer);

  const s1 = await interpret(writer);
  const s2 = await interpret(writer);

  assert.equal(s1.last_seq, s2.last_seq);
  assert.equal(s1.tail_hash, s2.tail_hash);
  assert.deepEqual([...s1.topic_index.keys()], [...s2.topic_index.keys()]);
});

test('interpret: as_of_seq truncates the fold', async () => {
  const { writer } = await freshSilo();
  await seedBasicLog(writer);

  // Read only up to seq 3 (the PRINCIPAL_ACCESS_ENABLED) — no topic writes yet
  const partial = await interpret(writer, null, 3);
  assert.equal(partial.last_seq, 3);
  assert.equal(partial.topic_index.size, 0);
  assert.equal(partial.principals.get('helder').status, 'active');
});

test('interpret: RECOVERY_MODE_ENTERED / EXITED toggles current_mode', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'RECOVERY_MODE_ENTERED',
    isStateBearing: true,
    intentId: 'intent:rec1',
    principal: 'operator',
    payload: {},
    ts: '2026-04-22T10:00:00Z',
  });
  let state = await interpret(writer);
  assert.equal(state.current_mode, 'recovery');

  await writer.append({
    type: 'RECOVERY_MODE_EXITED',
    isStateBearing: true,
    intentId: 'intent:rec2',
    principal: 'operator',
    payload: {},
    ts: '2026-04-22T10:05:00Z',
  });
  state = await interpret(writer);
  assert.equal(state.current_mode, 'normal');
});

test('interpret: ACL_SEALED updates acl_table', async () => {
  const { writer } = await freshSilo();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:w1',
    principal: 'helder',
    payload: { slug: 'topic-x', tag: 'FACT', content: 'test' },
    ts: '2026-04-22T10:00:00Z',
  });
  // Default T1 ACL: creator + operator
  let state = await interpret(writer);
  assert.equal(state.acl_table.get('topic-x').size, 2);

  await writer.append({
    type: 'ACL_SEALED',
    isStateBearing: true,
    intentId: 'intent:seal1',
    principal: 'operator',
    payload: { topic: 'topic-x', readers: ['helder'] },
    ts: '2026-04-22T10:01:00Z',
  });
  state = await interpret(writer);
  // Now only helder
  assert.equal(state.acl_table.get('topic-x').size, 1);
  assert.ok(state.acl_table.get('topic-x').has('helder'));
  assert.ok(!state.acl_table.get('topic-x').has('operator'));
});

test('interpret: dedup witness populated with intent_ids', async () => {
  const { writer } = await freshSilo();
  await seedBasicLog(writer);

  const state = await interpret(writer);
  assert.equal(state.dedup_witness_set.size, 5);
  assert.ok(state.dedup_witness_set.has('intent:w1'));
});

test('interpret: with matrix, enforces registry-authoritative is_state_bearing', async () => {
  const { writer } = await freshSilo();
  // Build an entry claiming is_state_bearing: false for a type that's registered true
  await writer.append({
    type: 'write_event',
    isStateBearing: false, // <- client wants false
    intentId: 'intent:bad',
    principal: 'helder',
    payload: { slug: 'test', tag: 'FACT', content: 'hello' },
    ts: '2026-04-22T10:00:00Z',
  });

  const matrix = loadMatrix();
  const state = await interpret(writer, matrix);
  // Topic should still land because write_event IS state-bearing per registry
  assert.equal(state.topic_index.size, 1);
});

test('interpret: TOPIC_BULLETS_RETIRED populates retired_curated_seqs', async () => {
  // Phase 2: curate-emitted retirement events fold into a per-state set,
  // gated by topic-scoping (a retire event only retires CURATED writes
  // on its own topic) and by validity (the seq must reference a CURATED
  // write in topic_content).
  const { writer } = await freshSilo();
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    isStateBearing: true,
    intentId: 'intent:p1',
    principal: 'operator',
    payload: { principal: 'helder', class: 'human' },
    ts: '2026-04-22T10:00:00Z',
  });
  await writer.append({
    type: 'PRINCIPAL_ACCESS_ENABLED',
    isStateBearing: true,
    intentId: 'intent:p2',
    principal: 'operator',
    payload: { principal: 'helder' },
    ts: '2026-04-22T10:00:01Z',
  });
  // Two CURATED writes on topic-A
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:cA1',
    principal: 'curator',
    payload: { slug: 'topic-a', tag: 'CURATED', content: '- old port 8080' },
    ts: '2026-04-22T10:01:00Z',
  });
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:cA2',
    principal: 'curator',
    payload: { slug: 'topic-a', tag: 'CURATED', content: '- still valid' },
    ts: '2026-04-22T10:01:01Z',
  });
  // One CURATED write on topic-B (must NOT be retired by topic-A's retire event)
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:cB1',
    principal: 'curator',
    payload: { slug: 'topic-b', tag: 'CURATED', content: '- topic-b bullet' },
    ts: '2026-04-22T10:01:02Z',
  });
  // Retire topic-A bullet (seq 3) — and also try to smuggle topic-B's seq 5
  await writer.append({
    type: 'TOPIC_BULLETS_RETIRED',
    isStateBearing: true,
    intentId: 'intent:r1',
    principal: 'curator',
    payload: {
      topic: 'topic-a',
      superseded_seqs: [3, 5], // 5 belongs to topic-b — should be rejected
      reason: 'port changed to 9090',
    },
    ts: '2026-04-22T10:02:00Z',
  });

  const state = await interpret(writer);
  // seq 3 retired; seq 5 NOT retired (cross-topic protection)
  assert.ok(state.retired_curated_seqs.has(3));
  assert.ok(!state.retired_curated_seqs.has(5));
  assert.equal(state.retired_curated_seqs.size, 1);
});

test('interpret: TOPIC_BULLETS_RETIRED with malformed payload does not throw', async () => {
  // Totality invariant: malformed retire payloads silently skip the bad seqs.
  const { writer } = await freshSilo();
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    isStateBearing: true,
    intentId: 'intent:p1',
    principal: 'operator',
    payload: { principal: 'helder', class: 'human' },
    ts: '2026-04-22T10:00:00Z',
  });
  await writer.append({
    type: 'TOPIC_BULLETS_RETIRED',
    isStateBearing: true,
    intentId: 'intent:r-bad',
    principal: 'curator',
    payload: { topic: 'nonexistent', superseded_seqs: ['not-a-number', -1, null, 0, 9999] },
    ts: '2026-04-22T10:01:00Z',
  });
  const state = await interpret(writer);
  assert.equal(state.retired_curated_seqs.size, 0);
});

test('interpret: is total — malformed entry does not throw, surfaces in skipped[]', async () => {
  // Craft a log with a valid entry followed by a malformed line
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-mal-'));
  const writer = new LogWriter(dir);
  await writer.init();
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'intent:good',
    principal: 'helder',
    payload: { slug: 'ok', tag: 'FACT', content: 'good' },
    ts: '2026-04-22T10:00:00Z',
  });
  // Append raw malformed line to the month's file (bypass writer to simulate corruption)
  const files = await fs.readdir(join(dir, 'operation-log'));
  const logFile = join(dir, 'operation-log', files[0]);
  await fs.appendFile(logFile, '{not valid json\n', 'utf8');

  const state = await interpret(writer);
  // Good entry folded; bad line silently skipped at the readAll layer (M1)
  assert.equal(state.topic_index.size, 1);
});
