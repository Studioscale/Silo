/**
 * Persist distilled `silo extract` entries through the LogWriter — with the
 * reactive slug-existence reroute (v0.2.5 §4.8 / build-note #3).
 *
 * `silo extract` distills memory entries from a session transcript; the LLM is
 * prompted to only use slugs from the topic index (and `general` otherwise),
 * but it can still hallucinate a novel slug. The slug-existence guard rejects a
 * write_event to a slug that was never created. Rather than fail the whole
 * extract (or silently drop the entry), we reactively RE-ROUTE that one entry
 * to `general` and surface it — visible, never a silent coercion (NG3).
 *
 * Critically (build-note #3): branch ONLY on `SLUG_NOT_ADMITTED` and RE-RAISE
 * everything else. A catch-all would silently reroute LOG_TAIL_NOT_INTERPRETABLE
 * or matrix refusals to `general`, breaking fail-loud.
 *
 * Each entry is its own locked append (extract is per-entry, NOT batched — the
 * per-entry reroute needs per-entry granularity; build-note #4).
 */

import { v7 as uuidv7 } from 'uuid';

/**
 * @param {import('../log/append.js').LogWriter} writer
 * @param {Array<{slug,tag,content,confidence}>} entries - distilled entries
 * @param {string} principal
 * @returns {Promise<{written:number, rerouted:Array<{from,tag,content}>}>}
 */
export async function persistDistilledEntries(writer, entries, principal) {
  let written = 0;
  const rerouted = [];
  for (const entry of entries) {
    const payload = {
      slug: entry.slug,
      tag: entry.tag,
      content: entry.content,
      confidence: entry.confidence,
      auto_extracted: true,
      source: 'session-extract',
    };
    try {
      await writer.append({
        type: 'write_event',
        isStateBearing: true,
        intentId: `intent:${uuidv7()}`,
        principal,
        payload,
      });
      written += 1;
    } catch (err) {
      // ONLY a non-existent slug is reroutable. Re-raise everything else
      // (tail-safety, matrix refusal, payload error) so extract fails loud.
      if (err?.code !== 'SLUG_NOT_ADMITTED') throw err;
      await writer.append({
        type: 'write_event',
        isStateBearing: true,
        intentId: `intent:${uuidv7()}`,
        principal,
        payload: { ...payload, slug: 'general' },
      });
      written += 1;
      rerouted.push({ from: entry.slug, tag: entry.tag, content: entry.content });
    }
  }
  return { written, rerouted };
}
