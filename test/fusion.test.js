import test from 'node:test';
import assert from 'node:assert/strict';
import { rrf, RRF_K, LEXICAL_FUSION_WEIGHT, DEFAULT_ARM_WEIGHTS } from '../src/retrieval/fusion.js';

test('rrf: k=60, 1-based — single arm score is 1/(60+rank)', () => {
  const out = rrf({ L: ['a', 'b'] });
  assert.equal(RRF_K, 60);
  assert.equal(out[0].key, 'a');
  assert.ok(Math.abs(out[0].score - 1 / 61) < 1e-12);
  assert.ok(Math.abs(out[1].score - 1 / 62) < 1e-12);
  assert.equal(out[0].ranks.L, 1);
});

test('rrf: present in both arms → terms SUM', () => {
  const out = rrf({ L: ['x'], S: ['x'] });
  assert.ok(Math.abs(out[0].score - (1 / 61 + 1 / 61)) < 1e-12);
  assert.deepEqual(out[0].ranks, { L: 1, S: 1 });
});

test('rrf: absent arm is OMITTED (not rank-0, not a penalty)', () => {
  // u is only in S at rank 1; its score must be exactly 1/(60+1), NOT reduced
  // by any lexical "rank 0" or max-rank penalty.
  const out = rrf({ L: ['other'], S: ['u'] });
  const u = out.find((r) => r.key === 'u');
  assert.ok(Math.abs(u.score - 1 / 61) < 1e-12);
  assert.equal(u.ranks.L, undefined);
  assert.equal(u.ranks.S, 1);
});

test('rrf: a unit in both beats a unit in one (semantic-only does not auto-win)', () => {
  // a: L rank1 + S rank2; b: S rank1 only.
  const out = rrf({ L: ['a'], S: ['b', 'a'] });
  // a = 1/61 + 1/62 ≈ 0.0325 ; b = 1/61 ≈ 0.0164
  assert.equal(out[0].key, 'a');
  assert.equal(out[1].key, 'b');
});

test('rrf: deterministic tiebreak by key when scores equal', () => {
  const out = rrf({ L: ['b', 'a'] }); // different ranks → different scores; force a tie:
  const tie = rrf({ L: ['b'], S: ['a'] }); // both rank1 in distinct arms → equal score
  assert.equal(tie[0].key, 'a'); // 'a' < 'b'
  assert.ok(out); // sanity
});

test('rrf: per-arm weights scale each arm term (lexical down-weight)', () => {
  // a only in L (rank1), b only in S (rank1). With w_L=0.5, w_S=1, b outscores a.
  const out = rrf({ L: ['a'], S: ['b'] }, { weights: { L: 0.5, S: 1 } });
  assert.equal(out[0].key, 'b');
  assert.ok(Math.abs(out.find((r) => r.key === 'a').score - 0.5 / 61) < 1e-12);
  assert.ok(Math.abs(out.find((r) => r.key === 'b').score - 1 / 61) < 1e-12);
  // A unit in BOTH arms still accumulates both (weighted) terms — the lexical arm
  // refines rather than being discarded.
  const both = rrf({ L: ['x'], S: ['x'] }, { weights: { L: 0.5, S: 1 } });
  assert.ok(Math.abs(both[0].score - (0.5 / 61 + 1 / 61)) < 1e-12);
});

test('rrf: tuned default — lexical weighted at half the semantic arm', () => {
  assert.equal(LEXICAL_FUSION_WEIGHT, 0.5);
  assert.deepEqual(DEFAULT_ARM_WEIGHTS, { L: 0.5, S: 1 });
});
