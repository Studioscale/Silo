/**
 * `silo topic create` — deterministic, deliberate topic creation (v0.2.5,
 * proposals/slug-existence-guard.md §4.6).
 *
 * The slug-existence guard rejects a write_event to a slug that was never
 * created. Topics are born only via a TOPIC_METADATA_SET that sets a
 * `topic_type`. Alongside `accept_suggestion` and import, this is the third
 * creation path — a direct CLI verb for "I know this topic should exist".
 *
 * Emits a TOPIC_METADATA_SET (type, default 'reference'; status 'active') so
 * the slug becomes write-admissible. Runs under the LOCKED public write path
 * (withAppendLock → _appendBatchUnlocked) — never the unlocked primitive
 * standalone. Reuses suggestion-ops' collision guard + detect's cooldown helper
 * (shared, not duplicated).
 *
 * Behaviour:
 *   - SLUG_COLLISION       if the slug already carries a topic_type.
 *   - PENDING_SUGGESTION_EXISTS if a pending TOPIC_SUGGESTED has the same
 *     NORMALIZED slug — unless `dismissPending`, which dismisses ALL matches
 *     (cooldown_days=1) in the SAME locked batch, before the TOPIC_METADATA_SET.
 *   - COOLDOWN_ACTIVE      if a dismissal cooldown is active for the normalized
 *     slug — unless `overrideCooldown`.
 */

import { v7 as uuidv7 } from 'uuid';
import { isValidSlug, normalizeSlugKey } from '../admission/slug.js';
import { isCooldownActive } from './detect.js';
import { SuggestionOpError, assertSlugHasNoTopic, DEFAULT_PRINCIPAL } from './suggestion-ops.js';

/**
 * @param {import('../log/append.js').LogWriter} writer
 * @param {Object} input
 * @param {string} input.slug
 * @param {string} [input.type='reference']
 * @param {string} [input.status='active']
 * @param {string} [input.summary]
 * @param {Array<string>} [input.tags]
 * @param {string} [input.principal]
 * @param {boolean} [input.dismissPending]   - dismiss colliding pending suggestions
 * @param {boolean} [input.overrideCooldown] - proceed despite an active cooldown
 * @returns {Promise<{created:true, slug, type, metadata_seq, dismissed_suggestion_seqs:number[]}>}
 */
export async function createTopic(writer, input) {
  const slug = input.slug;
  if (!isValidSlug(slug)) {
    throw new SuggestionOpError('INVALID_SLUG', `slug "${slug}" fails regex/length validation`);
  }
  const type = input.type ?? 'reference';
  const status = input.status ?? 'active';
  const principal = input.principal ?? DEFAULT_PRINCIPAL;
  const normalized = normalizeSlugKey(slug);

  let result;
  await writer.withAppendLock(async ({ writer: w, freshState, admissionContext }) => {
    // 1. Collision — slug already has a topic_type (shared with acceptSuggestion).
    assertSlugHasNoTopic(freshState, slug);

    // 2. Pending suggestion(s) with the same NORMALIZED slug.
    const pendingMatches = [];
    for (const seq of freshState.pending_topic_suggestion_seqs) {
      const sug = freshState.topic_suggestions.get(seq);
      if (sug && normalizeSlugKey(sug.slug) === normalized) pendingMatches.push(seq);
    }
    pendingMatches.sort((a, b) => a - b);
    if (pendingMatches.length > 0 && !input.dismissPending) {
      throw new SuggestionOpError('PENDING_SUGGESTION_EXISTS',
        `a pending suggestion for "${slug}" exists (seq ${pendingMatches.join(', ')}); `
        + 'accept it (silo suggest --accept) or pass --dismiss-pending',
        { pending_seqs: pendingMatches });
    }

    // 3. Active dismissal cooldown (shared cooldown helper).
    const cd = freshState.cooldowns_by_normalized_slug.get(normalized);
    if (isCooldownActive(cd) && !input.overrideCooldown) {
      throw new SuggestionOpError('COOLDOWN_ACTIVE',
        `slug "${slug}" is under an active dismissal cooldown (until `
        + `${new Date(cd.until_ts).toISOString()}); pass --override-cooldown to proceed`,
        { until_ts: cd.until_ts });
    }

    // 4. Build the batch: dismiss colliding pending suggestions FIRST (so the
    //    detector won't immediately re-suggest), then create the topic. One
    //    atomic locked batch through the public path.
    const entries = [];
    if (pendingMatches.length > 0) {
      entries.push({
        type: 'TOPIC_SUGGESTION_DISMISSED',
        isStateBearing: true,
        intentId: `intent:topic-create-dismiss:${uuidv7()}`,
        principal,
        payload: {
          suggestion_seqs: pendingMatches,
          cooldown_days: 1,
          reason: 'superseded by silo topic create',
        },
      });
    }
    const metadataPayload = { topic: slug, type, status };
    if (input.summary !== undefined) metadataPayload.summary = input.summary;
    if (input.tags !== undefined) metadataPayload.tags = input.tags;
    entries.push({
      type: 'TOPIC_METADATA_SET',
      isStateBearing: true,
      intentId: `intent:topic-create:${uuidv7()}`,
      principal,
      payload: metadataPayload,
    });

    const appended = await w._appendBatchUnlocked(entries, admissionContext);
    result = {
      created: true,
      slug,
      type,
      metadata_seq: appended[appended.length - 1].seq,
      dismissed_suggestion_seqs: pendingMatches,
    };
  });

  return result;
}
