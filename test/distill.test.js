import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, jaccardSimilarity, isDuplicate } from '../src/distill/tokenize.js';
import { parseExtractedEntry, parseExtractedBatch } from '../src/distill/parse.js';
import { parseSessionDelta, transcriptBody } from '../src/distill/transcript.js';
import { distill, entriesToWriteEvents } from '../src/distill/distill.js';

// ─── tokenize / jaccard ──────────────────────────────────────────────────────

test('tokenize: drops pt+en stopwords and short tokens', () => {
  const t = tokenize('We decided to go with supplier X for the coating');
  assert.ok(t.includes('decided'));
  assert.ok(t.includes('supplier'));
  assert.ok(t.includes('coating'));
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('to'));
  assert.ok(!t.includes('we'));
});

test('tokenize: handles portuguese accents', () => {
  const t = tokenize('Decidimos trocar para fornecedor X por causa da qualidade');
  assert.ok(t.some((tok) => tok.includes('decidimos') || tok.includes('fornecedor')));
});

test('tokenize: empty/null safely returns []', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

test('jaccardSimilarity: identical → 1.0', () => {
  const a = tokenize('supplier X was chosen after review');
  assert.equal(jaccardSimilarity(a, a), 1);
});

test('jaccardSimilarity: disjoint → 0', () => {
  const a = tokenize('completely different subject entirely');
  const b = tokenize('unrelated topic about motorcycles');
  assert.equal(jaccardSimilarity(a, b), 0);
});

test('jaccardSimilarity: partial overlap scales', () => {
  const a = tokenize('supplier X chosen after review');
  const b = tokenize('supplier X chosen after inspection');
  const sim = jaccardSimilarity(a, b);
  assert.ok(sim > 0.4 && sim < 1);
});

test('isDuplicate: above threshold returns true', () => {
  const existing = [tokenize('We chose supplier X for coating after tests')];
  const candidate = tokenize('chose supplier X coating tests review');
  assert.equal(isDuplicate(candidate, existing, 0.4), true);
});

test('isDuplicate: below threshold returns false', () => {
  const existing = [tokenize('Motorcycle coating supplier chosen')];
  const candidate = tokenize('Completely unrelated subject about databases');
  assert.equal(isDuplicate(candidate, existing, 0.4), false);
});

// ─── parseExtractedEntry / Batch ────────────────────────────────────────────

test('parseExtractedEntry: valid line parses all fields', () => {
  const e = parseExtractedEntry('[AUTO-DECISION:CONFIRMED] project-alpha: chose supplier X for coating');
  assert.equal(e.tag, 'DECISION');
  assert.equal(e.confidence, 'CONFIRMED');
  assert.equal(e.slug, 'project-alpha');
  assert.equal(e.content, 'chose supplier X for coating');
});

test('parseExtractedEntry: rejects missing AUTO- prefix', () => {
  assert.equal(parseExtractedEntry('[DECISION:CONFIRMED] project-alpha: content'), null);
});

test('parseExtractedEntry: rejects invalid tag', () => {
  assert.equal(parseExtractedEntry('[AUTO-RANDOM:CONFIRMED] project-alpha: content'), null);
});

test('parseExtractedEntry: rejects invalid confidence', () => {
  assert.equal(parseExtractedEntry('[AUTO-FACT:MAYBE] project-alpha: content'), null);
});

test('parseExtractedEntry: rejects invalid slug (uppercase)', () => {
  assert.equal(parseExtractedEntry('[AUTO-FACT:CONFIRMED] ProjectAlpha: content'), null);
});

test('parseExtractedEntry: null on blank/empty', () => {
  assert.equal(parseExtractedEntry(''), null);
  assert.equal(parseExtractedEntry('   '), null);
  assert.equal(parseExtractedEntry(null), null);
});

test('parseExtractedBatch: NOTHING_TO_EXTRACT → []', () => {
  assert.deepEqual(parseExtractedBatch('NOTHING_TO_EXTRACT'), []);
});

test('parseExtractedBatch: mixes valid and invalid, keeps valid only', () => {
  const text = [
    '[AUTO-FACT:CONFIRMED] a-slug: fact one',
    'garbage line',
    '[AUTO-DECISION:TENTATIVE] b-slug: decision two',
    '',
    '[BAD-TAG:CONFIRMED] c-slug: skipped',
  ].join('\n');
  const entries = parseExtractedBatch(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].slug, 'a-slug');
  assert.equal(entries[1].slug, 'b-slug');
});

// ─── parseSessionDelta ───────────────────────────────────────────────────────

function jsonlMessage(role, text) {
  return JSON.stringify({ type: 'message', message: { role, content: text } });
}

test('parseSessionDelta: filters tool and slash-command noise', () => {
  const lines = [
    jsonlMessage('user', '/help'),
    jsonlMessage('user', '<tool_call>read_file</tool_call>'),
    jsonlMessage('assistant', 'Real response about supplier X decision'),
    jsonlMessage('user', 'Follow-up question'),
    jsonlMessage('user', '<tool_result>...</tool_result>'),
  ].join('\n');
  const { messages, totalLines } = parseSessionDelta(lines);
  assert.equal(totalLines, 5);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'assistant');
});

test('parseSessionDelta: lastProcessedLine skips already-seen lines', () => {
  const lines = [
    jsonlMessage('user', 'First turn'),
    jsonlMessage('assistant', 'First reply'),
    jsonlMessage('user', 'Second turn with new info'),
  ].join('\n');
  const { messages } = parseSessionDelta(lines, 2);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'Second turn with new info');
});

test('parseSessionDelta: truncates oversized messages', () => {
  const bigText = 'word '.repeat(1000); // 5000 chars
  const lines = jsonlMessage('user', bigText);
  const { messages } = parseSessionDelta(lines);
  assert.ok(messages[0].text.endsWith('[truncated]'));
  assert.ok(messages[0].text.length < 2100);
});

test('parseSessionDelta: estimates dialogue tokens', () => {
  const lines = [jsonlMessage('user', 'one two three four five six seven eight')].join('\n');
  const { dialogueTokenEstimate } = parseSessionDelta(lines);
  assert.ok(dialogueTokenEstimate > 0);
});

test('transcriptBody: joins role-labeled turns', () => {
  const body = transcriptBody([
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'world' },
  ]);
  assert.ok(body.includes('user: hello'));
  assert.ok(body.includes('assistant: world'));
});

// ─── distill pipeline (with mock LLM) ────────────────────────────────────────

function mockLLM(responseText, usage = null) {
  return {
    calls: [],
    async complete(system, user) {
      this.calls.push({ system, user });
      return { content: responseText, usage };
    },
  };
}

test('distill: LLM returns valid entries and they pass through', async () => {
  const llm = mockLLM(
    [
      '[AUTO-DECISION:CONFIRMED] project-alpha: chose supplier X for coating',
      '[AUTO-FACT:TENTATIVE] health: blood pressure ~128/82 this morning',
    ].join('\n'),
    { prompt_tokens: 100, completion_tokens: 40 },
  );
  const result = await distill({
    messages: [{ role: 'user', text: 'decided on supplier X for coating' }],
    topicIndex: 'project-alpha | project | ...\nhealth | personal | ...',
    llm,
  });
  assert.equal(result.entries.length, 2);
  assert.equal(result.candidates, 2);
  assert.equal(result.deduped, 0);
  assert.equal(result.usage.prompt_tokens, 100);
  assert.equal(llm.calls.length, 1);
  assert.ok(llm.calls[0].user.includes('decided on supplier X'));
});

test('distill: candidates that match recentTokens are deduped', async () => {
  const llm = mockLLM('[AUTO-FACT:CONFIRMED] project-alpha: chose supplier X for coating after tests');
  const recent = [tokenize('chose supplier X coating after tests review')];
  const result = await distill({
    messages: [{ role: 'user', text: 'chat' }],
    llm,
    recentTokens: recent,
    threshold: 0.4,
  });
  assert.equal(result.candidates, 1);
  assert.equal(result.entries.length, 0);
  assert.equal(result.deduped, 1);
});

test('distill: candidates dedup against each other within a batch', async () => {
  // Two near-duplicate lines in one LLM response — second should be dropped
  const llm = mockLLM(
    [
      '[AUTO-FACT:CONFIRMED] project-alpha: supplier X chosen for motorcycle coating decision',
      '[AUTO-FACT:CONFIRMED] project-alpha: chose supplier X for motorcycle coating',
    ].join('\n'),
  );
  const result = await distill({
    messages: [{ role: 'user', text: 'chat' }],
    llm,
    threshold: 0.5,
  });
  assert.equal(result.candidates, 2);
  assert.equal(result.entries.length, 1);
  assert.equal(result.deduped, 1);
});

test('distill: NOTHING_TO_EXTRACT → empty result', async () => {
  const llm = mockLLM('NOTHING_TO_EXTRACT');
  const result = await distill({ messages: [{ role: 'user', text: 'hi' }], llm });
  assert.deepEqual(result.entries, []);
  assert.equal(result.candidates, 0);
});

test('distill: no messages → no LLM call', async () => {
  const llm = mockLLM('should not be called');
  const result = await distill({ messages: [], llm });
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(result.entries, []);
});

test('distill: missing LLM client throws', async () => {
  await assert.rejects(
    async () => distill({ messages: [{ role: 'user', text: 'x' }] }),
    /llm client/,
  );
});

test('distill: malformed LLM output yields 0 entries without throwing', async () => {
  const llm = mockLLM('this is free-form text with no structured entries at all');
  const result = await distill({ messages: [{ role: 'user', text: 'x' }], llm });
  assert.deepEqual(result.entries, []);
  assert.equal(result.candidates, 0);
});

test('entriesToWriteEvents: maps entries to log-shaped inputs', () => {
  const entries = [
    { tag: 'FACT', confidence: 'CONFIRMED', slug: 'a-slug', content: 'fact body' },
    { tag: 'DECISION', confidence: 'TENTATIVE', slug: 'b-slug', content: 'decision body' },
  ];
  const writeEvents = entriesToWriteEvents(entries, { principal: 'helder' });
  assert.equal(writeEvents.length, 2);
  assert.equal(writeEvents[0].type, 'write_event');
  assert.equal(writeEvents[0].principal, 'helder');
  assert.equal(writeEvents[0].payload.slug, 'a-slug');
  assert.equal(writeEvents[0].payload.tag, 'FACT');
  assert.equal(writeEvents[0].payload.confidence, 'CONFIRMED');
  assert.equal(writeEvents[0].payload.auto_extracted, true);
});

test('entriesToWriteEvents: requires principal', () => {
  assert.throws(
    () => entriesToWriteEvents([{ tag: 'FACT', confidence: 'CONFIRMED', slug: 's', content: 'c' }]),
    /principal required/,
  );
});

// ─── End-to-end: distill → LogWriter → interpret → retrieve ──────────────────

test('distill integration: entries land in state via LogWriter + interpret', async () => {
  const { promises: fs } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { v7: uuidv7 } = await import('uuid');
  const { LogWriter } = await import('../src/log/append.js');
  const { interpret } = await import('../src/interpret/index.js');

  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-distill-e2e-'));
  const writer = new LogWriter(dir);
  await writer.init();
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    isStateBearing: true,
    intentId: 'i:p1',
    principal: 'bootstrap',
    payload: { principal: 'helder', class: 'human' },
    ts: '2026-04-22T00:00:00Z',
  });
  await writer.append({
    type: 'PRINCIPAL_ACCESS_ENABLED',
    isStateBearing: true,
    intentId: 'i:p2',
    principal: 'bootstrap',
    payload: { principal: 'helder' },
    ts: '2026-04-22T00:00:01Z',
  });

  const llm = mockLLM(
    [
      '[AUTO-DECISION:CONFIRMED] project-alpha: chose supplier X for coating after tests',
      '[AUTO-FACT:TENTATIVE] health: blood pressure 128/82 this morning, check tomorrow',
    ].join('\n'),
  );

  const result = await distill({
    messages: [
      { role: 'user', text: 'decided supplier X for coating after tests' },
      { role: 'user', text: 'also noted bp 128/82 need to check tomorrow' },
    ],
    llm,
  });

  // Append entries through the real LogWriter so admission/hashing runs
  for (const entry of result.entries) {
    await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `intent:${uuidv7()}`,
      principal: 'helder',
      payload: {
        slug: entry.slug,
        tag: entry.tag,
        content: entry.content,
        confidence: entry.confidence,
        auto_extracted: true,
      },
    });
  }

  const state = await interpret(writer);
  assert.ok(state.topic_index.has('project-alpha'));
  assert.ok(state.topic_index.has('health'));
  assert.equal(state.topic_content.get('project-alpha').length, 1);
  assert.equal(state.topic_content.get('health').length, 1);
  assert.ok(state.topic_content.get('project-alpha')[0].content.includes('supplier X'));
});
