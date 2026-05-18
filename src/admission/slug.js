/**
 * Slug helpers — Phase 2.2 §9.5.
 *
 * Slug regex (`^[a-z0-9]+(-[a-z0-9]+)*$`) is enforced at admission for
 * TOPIC_SUGGESTED / TOPIC_SUGGESTION_ACCEPTED / TOPIC_METADATA_SET
 * payloads (see payload-validators.js). The functions here support
 * detection + cooldown logic that compares slugs across surface forms
 * (e.g., `pets` / `Pets` / `pet-s` all collapse to the same key).
 */

/**
 * Normalize a slug for collision/cooldown lookup. NOT the canonical form
 * that lands in the log payload — payloads keep the user's chosen slug
 * verbatim. This is the lookup key used by:
 *   - detection: cooldown-active check (`isCooldownActive(state.cooldowns_by_normalized_slug.get(norm))`)
 *   - state.dismissed_topic_suggestion_history keys
 *   - state.cooldowns_by_normalized_slug keys
 *
 * Pure, deterministic, replay-safe.
 *
 * @param {string} slug
 * @returns {string}
 */
export function normalizeSlugKey(slug) {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new TypeError(
      `normalizeSlugKey: expected non-empty string, got ${typeof slug}`,
    );
  }
  return slug.normalize('NFC').toLowerCase().replace(/-/g, '');
}

/** Regex enforced at admission. Exported so detection can pre-validate. */
export const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Returns true iff `slug` matches the canonical slug regex AND its
 * length is within [2, 40].
 */
export function isValidSlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 40) return false;
  return SLUG_REGEX.test(slug);
}
