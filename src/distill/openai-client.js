/**
 * OpenAI-compatible chat-completion client used by `silo extract`.
 * Kept tiny on purpose — same transport shape as Jarvis's session-extract.js
 * so behaviour is familiar and stable during cutover.
 *
 * Usage:
 *   const client = new OpenAIClient({ apiKey, model });
 *   await client.complete(systemPrompt, userPrompt);  // → { content, usage }
 *
 * Swap with any object that exposes `.complete(system, user)` — see the mockLLM
 * in test/distill.test.js for the contract.
 */

import https from 'node:https';

const DEFAULT_HOST = 'api.openai.com';
const DEFAULT_PATH = '/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAIClient {
  constructor({
    apiKey,
    model = 'gpt-4o',
    host = DEFAULT_HOST,
    path = DEFAULT_PATH,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    temperature = 0.0,
    maxTokens = 1000,
  } = {}) {
    if (!apiKey) throw new Error('OpenAIClient: apiKey required');
    this.apiKey = apiKey;
    this.model = model;
    this.host = host;
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  async complete(systemPrompt, userPrompt) {
    // gpt-5.x and o-series reasoning models reject `max_tokens` (require
    // `max_completion_tokens`) and reject custom `temperature` (only default
    // is allowed). gpt-4o accepts both shapes, so use the modern names
    // unconditionally and only include temperature for legacy models.
    const isLegacy = /^gpt-3\.5|^gpt-4(?!o)/.test(this.model);
    const payload = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_completion_tokens: this.maxTokens,
    };
    if (isLegacy) payload.temperature = this.temperature;
    const body = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.host,
          path: this.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
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
                reject(new Error(`OpenAI ${res.statusCode}: ${parsed.error?.message ?? data}`));
                return;
              }
              resolve({
                content: parsed.choices?.[0]?.message?.content?.trim() ?? null,
                usage: parsed.usage ?? null,
              });
            } catch (err) {
              reject(new Error(`OpenAI parse error: ${err.message}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error('OpenAI request timed out'));
      });
      req.write(body);
      req.end();
    });
  }
}
