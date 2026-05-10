import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLlmClient } from '../src/distill/llm-factory.js';
import { AnthropicClient } from '../src/distill/anthropic-client.js';
import { OpenAIClient } from '../src/distill/openai-client.js';

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('pickLlmClient: explicit claude-* model picks Anthropic', () => {
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake' }, () => {
    const { client, providerName, error } = pickLlmClient({ model: 'claude-haiku-4-5' });
    assert.equal(error, null);
    assert.equal(providerName, 'anthropic');
    assert.ok(client instanceof AnthropicClient);
    assert.equal(client.model, 'claude-haiku-4-5');
  });
});

test('pickLlmClient: explicit claude-* model without ANTHROPIC_API_KEY errors', () => {
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: 'sk-fake' }, () => {
    const { client, error } = pickLlmClient({ model: 'claude-sonnet-4-6' });
    assert.equal(client, null);
    assert.match(error, /ANTHROPIC_API_KEY required/);
  });
});

test('pickLlmClient: explicit gpt-* model picks OpenAI', () => {
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake' }, () => {
    const { client, providerName } = pickLlmClient({ model: 'gpt-4o' });
    assert.equal(providerName, 'openai');
    assert.ok(client instanceof OpenAIClient);
  });
});

test('pickLlmClient: no model + only ANTHROPIC_API_KEY → Anthropic with default haiku', () => {
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: undefined }, () => {
    const { client, providerName } = pickLlmClient({});
    assert.equal(providerName, 'anthropic');
    assert.equal(client.model, 'claude-haiku-4-5');
  });
});

test('pickLlmClient: no model + only OPENAI_API_KEY → OpenAI with default gpt-4o', () => {
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: 'sk-fake' }, () => {
    const { client, providerName } = pickLlmClient({});
    assert.equal(providerName, 'openai');
    assert.equal(client.model, 'gpt-4o');
  });
});

test('pickLlmClient: no model + both keys set → prefer Anthropic', () => {
  // OpenAI billing has been fragile for this deployment, so when both are
  // available we route to Anthropic by default.
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake' }, () => {
    const { client, providerName } = pickLlmClient({});
    assert.equal(providerName, 'anthropic');
    assert.ok(client instanceof AnthropicClient);
  });
});

test('pickLlmClient: no keys at all returns descriptive error', () => {
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
    const { client, error } = pickLlmClient({});
    assert.equal(client, null);
    assert.match(error, /ANTHROPIC_API_KEY or OPENAI_API_KEY required/);
  });
});

test('AnthropicClient: throws on missing apiKey', () => {
  assert.throws(() => new AnthropicClient({}), /apiKey required/);
});
