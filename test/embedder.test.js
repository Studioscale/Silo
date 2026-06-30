import test from 'node:test';
import assert from 'node:assert/strict';
import {
  semanticEnabled, resolveModelKey, modelConfig, applyPrefix,
  MODEL_REGISTRY, getEmbedder, hasEmbedderSupport, _resetEmbedderForTests,
} from '../src/embedding/embedder.js';

test('semanticEnabled: off unless flag + model + install all hold', () => {
  // flag off → false even with a model
  assert.equal(semanticEnabled({ env: { SILO_SEMANTIC_MODEL: 'bge-small-en-v1.5' } }), false);
  // flag on but no model → false
  assert.equal(semanticEnabled({ env: { SILO_SEMANTIC: 'on' } }), false);
  // flag on + model via env escape hatch (stands in for the install marker) → true
  assert.equal(
    semanticEnabled({ env: { SILO_SEMANTIC: 'on', SILO_SEMANTIC_MODEL: 'bge-small-en-v1.5' } }),
    true,
  );
  // unknown model key → false
  assert.equal(
    semanticEnabled({ env: { SILO_SEMANTIC: 'on', SILO_SEMANTIC_MODEL: 'nope' } }),
    false,
  );
});

test('semanticEnabled: injected install record satisfies model+installed gates', () => {
  const install = { model: 'multilingual-e5-small', transformers_version: '2.0.0' };
  assert.equal(semanticEnabled({ env: { SILO_SEMANTIC: 'on' }, install }), true);
  assert.equal(semanticEnabled({ env: {}, install }), false); // flag still required
});

test('resolveModelKey: env override wins, else install record, else null', () => {
  assert.equal(resolveModelKey({ env: { SILO_SEMANTIC_MODEL: 'bge-small-en-v1.5' } }), 'bge-small-en-v1.5');
  assert.equal(resolveModelKey({ env: {}, install: { model: 'multilingual-e5-small' } }), 'multilingual-e5-small');
  assert.equal(resolveModelKey({ env: {} }), null);
});

test('modelConfig: pins + merges install engine versions; both models 384-dim q8', () => {
  for (const key of Object.keys(MODEL_REGISTRY)) {
    const cfg = modelConfig(key, { install: { model: key, transformers_version: '2.1.0', ort_version: '1.17.0' } });
    assert.equal(cfg.dims, 384);
    assert.equal(cfg.dtype, 'q8');
    assert.equal(cfg.pooling, 'mean');
    assert.equal(cfg.normalize, true);
    assert.equal(cfg.transformers_version, '2.1.0');
    assert.equal(cfg.ort_version, '1.17.0');
    assert.equal(cfg.model_id, MODEL_REGISTRY[key].transformers_id);
  }
});

test('applyPrefix: e5 symmetric prefixes; bge query-instruction + NO doc prefix', () => {
  assert.equal(applyPrefix('x', 'query', 'multilingual-e5-small'), 'query: x');
  assert.equal(applyPrefix('x', 'passage', 'multilingual-e5-small'), 'passage: x');
  assert.equal(
    applyPrefix('x', 'query', 'bge-small-en-v1.5'),
    'Represent this sentence for searching relevant passages: x',
  );
  assert.equal(applyPrefix('x', 'passage', 'bge-small-en-v1.5'), 'x'); // no doc prefix
});

test('getEmbedder: no model chosen → null (no native dep touched)', async () => {
  _resetEmbedderForTests();
  const emb = await getEmbedder({ env: {} });
  assert.equal(emb, null);
});

test('hasEmbedderSupport: returns a boolean without throwing', async () => {
  const ok = await hasEmbedderSupport();
  assert.equal(typeof ok, 'boolean');
});
