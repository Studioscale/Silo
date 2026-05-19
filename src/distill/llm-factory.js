/**
 * Provider-agnostic LLM client factory used by `silo extract` and `silo curate`.
 *
 * Resolution order:
 *   1. If --model starts with `claude-`  → AnthropicClient (requires ANTHROPIC_API_KEY).
 *   2. If --model starts with `gpt-`/`o<digit>`/`chatgpt-` → OpenAIClient (requires OPENAI_API_KEY).
 *   3. No --model: prefer Anthropic when ANTHROPIC_API_KEY is set, else fall
 *      back to OpenAI when OPENAI_API_KEY is set. Anthropic is preferred
 *      because OpenAI billing has been fragile for this deployment.
 *
 * Returns { client, providerName, error } — caller decides how to surface a
 * missing-key condition (e.g. dry-run paths skip the LLM entirely).
 */

import { OpenAIClient } from './openai-client.js';
import { AnthropicClient } from './anthropic-client.js';
import { RetryingLlmClient } from './retry-llm-client.js';

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
// gpt-5.4 is the OpenAI flagship equivalent of Sonnet-4-6 for curation /
// extraction quality. gpt-4o (the previous default) still works but loses
// anti-bundling + retire-detection nuance at the smaller-model tier — use
// gpt-4o only as a budget fallback. Curation prompts target flagship-tier
// reasoning, not the 4o family.
const DEFAULT_OPENAI_MODEL = 'gpt-5.4';

/**
 * Wrap the raw provider client in retry-with-backoff for transient errors
 * (rate limit, 5xx, timeouts, network blips). Auth / quota / bad-request
 * errors fail fast — see retry-llm-client.js. Wrapping is unconditional;
 * the retry policy is a runtime safety net, not a feature flag.
 *
 * The onRetry callback logs to stderr so cron operators (silo-curate.sh,
 * silo-detect.sh) see what's happening in their log files.
 */
function wrapWithRetry(client) {
  return new RetryingLlmClient(client, {
    onRetry: ({ attempt, delayMs, err, classification, maxAttempts }) => {
      const reason = classification.code === 'rate_limited'
        ? 'rate limit'
        : classification.code === 'server_error'
        ? `${classification.provider ?? 'provider'} ${classification.statusCode}`
        : classification.code === 'request_timeout'
        ? 'timeout'
        : classification.code;
      const seconds = Math.round(delayMs / 1000);
      console.error(`silo: LLM ${reason} — retrying in ${seconds}s (attempt ${attempt}/${maxAttempts - 1} of ${maxAttempts - 1} retries)`);
    },
  });
}

export function pickLlmClient({ model } = {}) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Explicit model name pins the provider by prefix.
  if (model && model.startsWith('claude-')) {
    if (!anthropicKey) {
      return { client: null, providerName: null, error: 'ANTHROPIC_API_KEY required for Claude models' };
    }
    return {
      client: wrapWithRetry(new AnthropicClient({ apiKey: anthropicKey, model })),
      providerName: 'anthropic',
      error: null,
    };
  }
  if (model && /^(gpt-|o\d|chatgpt-)/.test(model)) {
    if (!openaiKey) {
      return { client: null, providerName: null, error: 'OPENAI_API_KEY required for OpenAI models' };
    }
    return {
      client: wrapWithRetry(new OpenAIClient({ apiKey: openaiKey, model })),
      providerName: 'openai',
      error: null,
    };
  }

  // No explicit model → prefer Anthropic, fall back to OpenAI.
  if (anthropicKey) {
    return {
      client: wrapWithRetry(new AnthropicClient({ apiKey: anthropicKey, model: model || DEFAULT_ANTHROPIC_MODEL })),
      providerName: 'anthropic',
      error: null,
    };
  }
  if (openaiKey) {
    return {
      client: wrapWithRetry(new OpenAIClient({ apiKey: openaiKey, model: model || DEFAULT_OPENAI_MODEL })),
      providerName: 'openai',
      error: null,
    };
  }
  return {
    client: null,
    providerName: null,
    error: 'ANTHROPIC_API_KEY or OPENAI_API_KEY required',
  };
}
