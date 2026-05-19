/**
 * RetryingLlmClient — Phase 2.4 follow-up.
 *
 * Wraps any duck-typed LLM client (one with `.complete(system, user)` →
 * `{content, usage}`) in retry-with-exponential-backoff semantics for
 * transient errors. Non-retryable errors (auth, quota, bad-request)
 * bubble through immediately — no point burning attempts when the next
 * call has the same outcome.
 *
 * Retry policy:
 *   - maxAttempts: 3 (one initial + up to 2 retries)
 *   - baseDelayMs: 2000
 *   - maxDelayMs:  30000
 *   - schedule:    base * 2^(attempt-1), capped (so 2s, 4s, 8s …)
 *
 * Retryability is decided by classifyLlmError() in ./llm-errors.js:
 *   - rate_limited, server_error, request_timeout, network_error → retry
 *   - auth_invalid, quota_exceeded, request_invalid, unknown      → fail fast
 *
 * The retry attempts log to stderr so cron operators see what's happening:
 *
 *   silo curate: Anthropic 429 (rate limit) — retrying in 2s (attempt 1/3)
 *   silo curate: Anthropic 429 (rate limit) — retrying in 4s (attempt 2/3)
 */

import { classifyLlmError } from './llm-errors.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Generic retry helper. Tested independently of the LLM client wrapping.
 *
 * @param {() => Promise<any>} fn
 * @param {Object} [opts]
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.baseDelayMs]
 * @param {number} [opts.maxDelayMs]
 * @param {(err: any) => boolean} [opts.shouldRetry] - returns true if err is retryable
 * @param {(info: {attempt, delayMs, err, classification}) => void} [opts.onRetry]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - test seam
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    shouldRetry = (err) => classifyLlmError(err).isRetryable,
    onRetry = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const classification = classifyLlmError(err);
      const retryable = shouldRetry(err);
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      try {
        onRetry({ attempt, delayMs, err, classification, maxAttempts });
      } catch {
        // never let an onRetry callback crash the retry loop
      }
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * Wraps a duck-typed LLM client. The wrapped client preserves `.model` and
 * `.complete(system, user)`; the latter now retries transient errors.
 */
export class RetryingLlmClient {
  constructor(inner, opts = {}) {
    if (!inner || typeof inner.complete !== 'function') {
      throw new Error('RetryingLlmClient: inner client missing .complete()');
    }
    this.inner = inner;
    this.model = inner.model;
    this.opts = opts;
  }

  async complete(systemPrompt, userPrompt) {
    return withRetry(
      () => this.inner.complete(systemPrompt, userPrompt),
      this.opts,
    );
  }
}

export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
};
