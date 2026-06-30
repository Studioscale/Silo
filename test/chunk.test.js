import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkUnit, positionalTokens, estimateTokens,
  MAX_TOKENS, CHUNK_SIZE, CHUNK_OVERLAP, CHUNKER_VERSION,
} from '../src/retrieval/chunk.js';

test('chunk: short unit → single chunk_index=0 carrying whole text verbatim', () => {
  const text = 'chose supplier X after review of three candidates';
  const chunks = chunkUnit(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_index, 0);
  assert.equal(chunks[0].content, text);
  assert.equal(chunks[0].span.char_start, 0);
  assert.equal(chunks[0].span.char_end, text.length);
});

test('chunk: empty unit → one empty chunk (occurrence stays representable)', () => {
  const chunks = chunkUnit('');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, '');
  assert.equal(chunks[0].chunk_index, 0);
});

test('chunk: oversized unit splits by fixed window, never beyond its own text', () => {
  // Build a unit comfortably over MAX_TOKENS (512) tokens.
  const words = [];
  for (let i = 0; i < 700; i++) words.push(`w${i}`);
  const text = words.join(' ');
  const chunks = chunkUnit(text);
  assert.ok(chunks.length > 1, 'should split');
  // chunk_index is contiguous from 0
  chunks.forEach((c, i) => assert.equal(c.chunk_index, i));
  // first window is CHUNK_SIZE tokens
  assert.equal(chunks[0].span.token_end - chunks[0].span.token_start, CHUNK_SIZE);
  // overlap: window N starts CHUNK_SIZE-CHUNK_OVERLAP after window N-1
  const step = CHUNK_SIZE - CHUNK_OVERLAP;
  assert.equal(chunks[1].span.token_start - chunks[0].span.token_start, step);
  // last chunk ends exactly at the token count (no Frankenstein tail past text)
  const last = chunks[chunks.length - 1];
  assert.equal(last.span.token_end, estimateTokens(text));
  assert.ok(last.span.char_end <= text.length);
});

test('chunk: deterministic — same input, identical output', () => {
  const text = 'a '.repeat(600);
  assert.deepEqual(chunkUnit(text), chunkUnit(text));
});

test('chunk: positionalTokens carries char spans; punctuation is its own token', () => {
  const toks = positionalTokens('a, b!');
  assert.deepEqual(toks.map((t) => t.text), ['a', ',', 'b', '!']);
  assert.equal(toks[0].char_start, 0);
  assert.equal(toks[1].text, ',');
});

test('chunk: PT-BR accented words stay single tokens', () => {
  const toks = positionalTokens('produção orçamento');
  assert.deepEqual(toks.map((t) => t.text), ['produção', 'orçamento']);
});

test('chunk: pinned identity constants are the spec values', () => {
  assert.equal(MAX_TOKENS, 512);
  assert.equal(CHUNK_SIZE, 256);
  assert.equal(CHUNK_OVERLAP, 64);
  assert.equal(CHUNKER_VERSION, 'fixed-window-v1');
});
