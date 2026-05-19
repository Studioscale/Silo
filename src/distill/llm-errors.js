/**
 * LLM-error classifier — Phase 2.4 follow-up.
 *
 * Both anthropic-client.js and openai-client.js throw `Error("Anthropic
 * ${statusCode}: ${msg}")` / `Error("OpenAI ${statusCode}: ${msg}")` shapes.
 * This module pattern-matches that error text to produce:
 *   - a code (auth_invalid, quota_exceeded, rate_limited, model_invalid,
 *     server_error, network_error, request_timeout, unknown)
 *   - isRetryable: whether a retry has a chance (rate limits, 5xx,
 *     network blips). Quota/auth/bad-model errors are not retryable —
 *     retrying just wastes another HTTP roundtrip.
 *   - hint: short actionable text for the operator.
 *
 * Pure — no I/O, no provider lookup. Tested independently.
 */

const ANTHROPIC_BILLING_URL = 'https://console.anthropic.com/settings/billing';
const OPENAI_BILLING_URL = 'https://platform.openai.com/settings/organization/billing';

/**
 * @param {Error|string} err - the thrown error or its message
 * @returns {{code: string, provider: string|null, statusCode: number|null,
 *            isRetryable: boolean, hint: string}}
 */
export function classifyLlmError(err) {
  const message = typeof err === 'string' ? err : (err?.message ?? String(err));
  const lower = message.toLowerCase();

  // Identify provider + status from the standard error prefix.
  let provider = null;
  let statusCode = null;
  const m = message.match(/^(Anthropic|OpenAI)\s+(\d{3}):/);
  if (m) {
    provider = m[1].toLowerCase();
    statusCode = parseInt(m[2], 10);
  }

  const billingUrl = provider === 'openai' ? OPENAI_BILLING_URL : ANTHROPIC_BILLING_URL;

  // Timeout — from the client's own timeout handler.
  if (lower.includes('timed out') || lower.includes('etimedout')) {
    return {
      code: 'request_timeout',
      provider,
      statusCode: null,
      isRetryable: true,
      hint: 'Provider took too long to respond. Often transient; retrying.',
    };
  }

  // Network-level: ECONNRESET, ENOTFOUND, ECONNREFUSED, EAI_AGAIN.
  if (/econnreset|enotfound|econnrefused|eai_again|getaddrinfo/i.test(message)) {
    return {
      code: 'network_error',
      provider,
      statusCode: null,
      isRetryable: true,
      hint: 'Network error reaching the provider. Often transient; retrying.',
    };
  }

  // Auth — bad / missing / revoked key.
  if (statusCode === 401 || /invalid x-api-key|incorrect api key|authentication/i.test(message)) {
    const envVar = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    return {
      code: 'auth_invalid',
      provider,
      statusCode,
      isRetryable: false,
      hint: `Authentication failed. Check ${envVar} is set to a valid key.`,
    };
  }

  // Quota / credit — explicit "out of credit" / "quota" / "billing" / 402.
  // Anthropic returns 400 with "Your credit balance is too low to access the
  // Anthropic API"; OpenAI returns 429 with "You exceeded your current quota".
  const isQuotaMsg = /credit balance|quota|insufficient_quota|insufficient.*credit|billing|payment required/i.test(message);
  if (statusCode === 402 || isQuotaMsg) {
    return {
      code: 'quota_exceeded',
      provider,
      statusCode,
      isRetryable: false,
      hint: `Account out of credit / over quota. Top up at ${billingUrl} — or pass --model=<other-provider-model> to fail over if you have the other provider's key set.`,
    };
  }

  // Plain rate limit — 429 not flagged as quota.
  if (statusCode === 429) {
    return {
      code: 'rate_limited',
      provider,
      statusCode,
      isRetryable: true,
      hint: 'Hit the per-minute rate limit. Backing off and retrying.',
    };
  }

  // Bad request — model not found, payload schema mismatch, etc.
  if (statusCode === 400 || statusCode === 404) {
    return {
      code: 'request_invalid',
      provider,
      statusCode,
      isRetryable: false,
      hint: 'Provider rejected the request (bad model name? unsupported feature?). Try `silo doctor` to verify your default model + key are valid.',
    };
  }

  // 5xx — provider-side outage.
  if (statusCode != null && statusCode >= 500) {
    return {
      code: 'server_error',
      provider,
      statusCode,
      isRetryable: true,
      hint: `${provider ?? 'Provider'} returned ${statusCode}. Usually transient; retrying.`,
    };
  }

  return {
    code: 'unknown',
    provider,
    statusCode,
    isRetryable: false,
    hint: 'Unrecognized provider error. See the raw message above and check provider status pages.',
  };
}

/**
 * Format an LLM error for CLI output. Called from main()'s catch in
 * cli/silo.js when an error message matches the LLM-error shape.
 *
 * @param {Error|string} err
 * @param {string} cmd - 'curate' | 'extract' | 'suggest' | ...
 * @returns {string} multi-line CLI message
 */
export function formatLlmErrorForCli(err, cmd) {
  const c = classifyLlmError(err);
  const raw = typeof err === 'string' ? err : (err?.message ?? String(err));
  const lines = [
    `silo ${cmd}: LLM call failed (${c.code}${c.statusCode ? ` / HTTP ${c.statusCode}` : ''}).`,
    `  ${c.hint}`,
    `  Raw: ${raw}`,
  ];
  return lines.join('\n');
}

/** True iff the error looks like one of our LLM-client throws. */
export function looksLikeLlmError(err) {
  const message = typeof err === 'string' ? err : (err?.message ?? '');
  return /^(Anthropic|OpenAI)\s+\d{3}:/.test(message)
    || /Anthropic request timed out|Anthropic parse error|OpenAI request timed out|OpenAI parse error/.test(message);
}
