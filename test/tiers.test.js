import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTier, tierInScope,
  TIER_CURATED, TIER_NOTE, TIER_SOURCE, TIER_ORDER,
  AUTHORITATIVE_TIERS, ADVISORY_TIERS, MUST_NOT_WRITE_FROM_TIERS,
} from '../src/retrieval/tiers.js';

const ev = (seq, tag, extra = {}) => ({ type: 'write_event', seq, payload: { tag, ...extra } });

test('classifyTier: native CURATED (no imported hint) → curated', () => {
  assert.equal(classifyTier(ev(5, 'CURATED'), new Set()), TIER_CURATED);
});

test('classifyTier: retired CURATED seq → null (excluded from relevance search)', () => {
  assert.equal(classifyTier(ev(5, 'CURATED'), new Set([5])), null);
});

test('classifyTier: CURATED imported from a topic-file curated field → curated', () => {
  assert.equal(
    classifyTier(ev(5, 'CURATED', { imported: { field: 'curated' } }), new Set()),
    TIER_CURATED,
  );
});

test('classifyTier: CURATED-tagged but event-log-origin import → note (not curated)', () => {
  // mirrors buildLayer2 excluding imported.field!=='curated'
  assert.equal(
    classifyTier(ev(5, 'CURATED', { imported: { field: 'event_log', source_line: 3 } }), new Set()),
    TIER_NOTE,
  );
});

test('classifyTier: SOURCE → source; SOURCE imported elsewhere → note', () => {
  assert.equal(classifyTier(ev(7, 'SOURCE'), new Set()), TIER_SOURCE);
  assert.equal(
    classifyTier(ev(7, 'SOURCE', { imported: { field: 'curated' } }), new Set()),
    TIER_NOTE,
  );
});

test('classifyTier: event-log tags → note', () => {
  for (const tag of ['FACT', 'DECISION', 'CHANGED', 'PROCEDURE', 'TODO', 'EVENT']) {
    assert.equal(classifyTier(ev(9, tag), new Set()), TIER_NOTE, tag);
  }
});

test('classifyTier: non-write_event → null', () => {
  assert.equal(classifyTier({ type: 'TOPIC_METADATA_SET', seq: 1, payload: {} }, new Set()), null);
  assert.equal(classifyTier(null, new Set()), null);
});

test('tierInScope: curated scope keeps only curated; all keeps everything', () => {
  assert.equal(tierInScope(TIER_CURATED, 'curated'), true);
  assert.equal(tierInScope(TIER_NOTE, 'curated'), false);
  assert.equal(tierInScope(TIER_SOURCE, 'curated'), false);
  assert.equal(tierInScope(TIER_NOTE, 'all'), true);
  assert.equal(tierInScope(TIER_SOURCE, 'all'), true);
});

test('tiers: envelope tier-policy constants', () => {
  assert.deepEqual(TIER_ORDER, ['curated', 'note', 'source']);
  assert.deepEqual(AUTHORITATIVE_TIERS, ['curated']);
  assert.deepEqual(ADVISORY_TIERS, ['note', 'source']);
  assert.deepEqual(MUST_NOT_WRITE_FROM_TIERS, ['note', 'source']);
});
