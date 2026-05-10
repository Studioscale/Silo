/**
 * Anthropic Messages API client used by `silo extract` / `silo curate`.
 * Mirrors OpenAIClient's `.complete(system, user)` shape so the calling code
 * is provider-agnostic. Same raw-https transport pattern, no SDK dependency,
 * matching the deliberate "tiny on purpose" choice in openai-client.js.
 *
 * Usage:
 *   const client = new AnthropicClient({ apiKey, model: 'claude-haiku-4-5' });
 *   await client.complete(systemPrompt, userPrompt);  // → { content, usage }
 */

import https from 'node:https';

const DEFAULT_HOST = 'api.anthropic.com';
const DEFAULT_PATH = '/v1/messages';
const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 60_000;

export class AnthropicClient {
  constructor({
    apiKey,
    model = 'claude-sonnet-4-6',
    host = DEFAULT_HOST,
    path = DEFAULT_PATH,
    apiVersion = DEFAULT_VERSION,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTokens = 1000,
  } = {}) {
    if (!apiKey) throw new Error('AnthropicClient: apiKey required');
    this.apiKey = apiKey;
    this.model = model;
    this.host = host;
    this.path = path;
    this.apiVersion = apiVersion;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
  }

  async complete(systemPrompt, userPrompt) {
    // Anthropic's Messages API takes `system` as a top-level field and
    // user/assistant content under `messages`. Thinking is left off by
    // default — curate and extract are classification/summarization tasks,
    // not deep reasoning. If a topic ever needs it, flip it on per-call.
    const payload = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    };
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.host,
          path: this.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': this.apiVersion,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode && res.statusCode >= 400) {
                const msg = parsed.error?.message ?? data;
                reject(new Error(`Anthropic ${res.statusCode}: ${msg}`));
                return;
              }
              // Concatenate text blocks (typical responses have one, but the
              // API permits multiple; preserve all of them).
              const text = (parsed.content || [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('')
                .trim();
              // Synthesize total_tokens for compatibility with OpenAI usage
              // shape (callers read response.usage.total_tokens).
              const usage = parsed.usage
                ? {
                    ...parsed.usage,
                    total_tokens:
                      (parsed.usage.input_tokens || 0) +
                      (parsed.usage.output_tokens || 0),
                  }
                : null;
              resolve({ content: text || null, usage });
            } catch (err) {
              reject(new Error(`Anthropic parse error: ${err.message}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error('Anthropic request timed out'));
      });
      req.write(body);
      req.end();
    });
  }
}
