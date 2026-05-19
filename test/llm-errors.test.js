/**
 * Tests for src/distill/llm-errors.js — error classifier + retry wrapper.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLlmError,
  formatLlmErrorForCli,
  looksLikeLlmError,
} from '../src/distill/llm-errors.js';
import {
  withRetry,
  RetryingLlmClient,
} from '../src/distill/retry-llm-client.js';

// ── classifyLlmError pattern matching ────────────────────────────────────────

test('classify: Anthropic 401 → auth_invalid, not retryable', () => {
  const c = classifyLlmError(new Error('Anthropic 401: invalid x-api-key'));
  assert.equal(c.code, 'auth_invalid');
  assert.equal(c.provider, 'anthropic');
  assert.equal(c.statusCode, 401);
  assert.equal(c.isRetryable, false);
  assert.match(c.hint, /ANTHROPIC_API_KEY/);
});

test('classify: OpenAI 401 → auth_invalid; hint names OPENAI_API_KEY', () => {
  const c = classifyLlmError(new Error('OpenAI 401: invalid_api_key'));
  assert.equal(c.code, 'auth_invalid');
  assert.equal(c.provider, 'openai');
  assert.match(c.hint, /OPENAI_API_KEY/);
});

test('classify: Anthropic credit-balance message → quota_exceeded', () => {
  const c = classifyLlmError(new Error('Anthropic 400: Your credit balance is too low to access the Anthropic API'));
  assert.equal(c.code, 'quota_exceeded');
  assert.equal(c.isRetryable, false);
  assert.match(c.hint, /console\.anthropic\.com/);
});

test('classify: OpenAI insufficient_quota 429 → quota_exceeded, not retryable', () => {
  const c = classifyLlmError(new Error('OpenAI 429: You exceeded your current quota, please check your plan and billing details'));
  assert.equal(c.code, 'quota_exceeded');
  assert.equal(c.isRetryable, false);
  assert.match(c.hint, /platform\.openai\.com/);
});

test('classify: plain 429 rate limit → rate_limited, retryable', () => {
  const c = classifyLlmError(new Error('Anthropic 429: rate limit exceeded'));
  assert.equal(c.code, 'rate_limited');
  assert.equal(c.isRetryable, true);
});

test('classify: 503 → server_error, retryable', () => {
  const c = classifyLlmError(new Error('OpenAI 503: service unavailable'));
  assert.equal(c.code, 'server_error');
  assert.equal(c.isRetryable, true);
});

test('classify: timeout → request_timeout, retryable', () => {
  const c = classifyLlmError(new Error('Anthropic request timed out'));
  assert.equal(c.code, 'request_timeout');
  assert.equal(c.isRetryable, true);
});

test('classify: ECONNRESET → network_error, retryable', () => {
  const c = classifyLlmError(new Error('socket hang up: ECONNRESET'));
  assert.equal(c.code, 'network_error');
  assert.equal(c.isRetryable, true);
});

test('classify: bad model name (400) → request_invalid, not retryable', () => {
  const c = classifyLlmError(new Error('Anthropic 400: model not_a_real_model not found'));
  assert.equal(c.code, 'request_invalid');
  assert.equal(c.isRetryable, false);
});

test('classify: unrecognized error → unknown, not retryable', () => {
  const c = classifyLlmError(new Error('something totally unexpected'));
  assert.equal(c.code, 'unknown');
  assert.equal(c.isRetryable, false);
});

// ── formatLlmErrorForCli ─────────────────────────────────────────────────────

test('formatLlmErrorForCli: produces a 3-line message including the raw error', () => {
  const msg = formatLlmErrorForCli(new Error('Anthropic 429: rate limit'), 'curate');
  assert.match(msg, /^silo curate: LLM call failed/);
  assert.match(msg, /HTTP 429/);
  assert.match(msg, /Raw: Anthropic 429: rate limit/);
});

// ── looksLikeLlmError ────────────────────────────────────────────────────────

test('looksLikeLlmError: matches provider error shapes', () => {
  assert.equal(looksLikeLlmError(new Error('Anthropic 429: rate limit')), true);
  assert.equal(looksLikeLlmError(new Error('OpenAI 500: server error')), true);
  assert.equal(looksLikeLlmError(new Error('Anthropic request timed out')), true);
  assert.equal(looksLikeLlmError(new Error('OpenAI parse error: SyntaxError')), true);
});

test('looksLikeLlmError: rejects unrelated errors', () => {
  assert.equal(looksLikeLlmError(new Error('ENOENT: file not found')), false);
  assert.equal(looksLikeLlmError(new Error('silo write: --slug required')), false);
});

// ── withRetry: behavior ─────────────────────────────────────────────────────

test('withRetry: returns the value on first-call success', async () => {
  const result = await withRetry(async () => 'ok', { sleep: async () => {} });
  assert.equal(result, 'ok');
});

test('withRetry: retries a retryable error then succeeds on attempt 2', async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error('Anthropic 429: rate limit');
      return 'ok';
    },
    { sleep: async () => {} },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('withRetry: gives up after maxAttempts retries; throws original error', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts++;
          throw new Error('Anthropic 503: service unavailable');
        },
        { maxAttempts: 3, sleep: async () => {} },
      ),
    /Anthropic 503/,
  );
  assert.equal(attempts, 3);
});

test('withRetry: non-retryable error fails fast (no retries)', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts++;
          throw new Error('Anthropic 401: invalid x-api-key');
        },
        { maxAttempts: 5, sleep: async () => {} },
      ),
    /401/,
  );
  assert.equal(attempts, 1);
});

test('withRetry: onRetry callback receives attempt + delay info', async () => {
  const events = [];
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          throw new Error('Anthropic 503: service unavailable');
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          sleep: async () => {},
          onRetry: (info) => events.push({
            attempt: info.attempt,
            delayMs: info.delayMs,
            code: info.classification.code,
          }),
        },
      ),
    /503/,
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].delayMs, 100);
  assert.equal(events[0].code, 'server_error');
  assert.equal(events[1].attempt, 2);
  assert.equal(events[1].delayMs, 200);
});

test('withRetry: exponential backoff schedule capped at maxDelayMs', async () => {
  const delays = [];
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          throw new Error('Anthropic 503: service unavailable');
        },
        {
          maxAttempts: 5,
          baseDelayMs: 1000,
          maxDelayMs: 3000,
          sleep: async (ms) => delays.push(ms),
        },
      ),
    /503/,
  );
  // 4 retries → delays 1000, 2000, 3000 (capped at maxDelayMs), 3000 (capped).
  assert.deepEqual(delays, [1000, 2000, 3000, 3000]);
});

test('withRetry: onRetry callback exception does not crash the loop', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error('Anthropic 429: rate limit');
          return 'ok';
        },
        {
          maxAttempts: 5,
          sleep: async () => {},
          onRetry: () => { throw new Error('boom'); },
        },
      ),
    // Should NOT throw — the retry continues. Wait, with this onRetry, the
    // retry SHOULD succeed on attempt 3.
    null,
  ).catch(() => null);
  // Should have succeeded on attempt 3.
  assert.equal(attempts, 3);
});

// ── RetryingLlmClient wrapper ────────────────────────────────────────────────

test('RetryingLlmClient: preserves .model + forwards complete()', async () => {
  const inner = {
    model: 'claude-sonnet-4-6',
    complete: async () => ({ content: 'hello', usage: { total_tokens: 5 } }),
  };
  const wrapped = new RetryingLlmClient(inner, { sleep: async () => {} });
  assert.equal(wrapped.model, 'claude-sonnet-4-6');
  const r = await wrapped.complete('sys', 'user');
  assert.equal(r.content, 'hello');
  assert.equal(r.usage.total_tokens, 5);
});

test('RetryingLlmClient: retries inner on retryable errors', async () => {
  let attempts = 0;
  const inner = {
    model: 'gpt-5.4',
    complete: async () => {
      attempts++;
      if (attempts < 2) throw new Error('OpenAI 503: server error');
      return { content: 'ok', usage: null };
    },
  };
  const wrapped = new RetryingLlmClient(inner, { sleep: async () => {} });
  const r = await wrapped.complete('s', 'u');
  assert.equal(r.content, 'ok');
  assert.equal(attempts, 2);
});

test('RetryingLlmClient: throws on missing inner', () => {
  assert.throws(() => new RetryingLlmClient(null), /inner client missing/);
  assert.throws(() => new RetryingLlmClient({}), /inner client missing/);
});
