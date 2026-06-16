/**
 * TEST helper: create a topic so write_events to it are admissible (v0.2.5).
 *
 * The slug-existence guard (src/admission/slug-existence.js) rejects a
 * write_event to a slug that was never created. Production creates topics via
 * `accept_suggestion` / import / `silo topic create`, all of which emit a
 * TOPIC_METADATA_SET WITH a `topic_type`. This helper does the same through the
 * normal locked public write path — the create-then-write pattern tests use
 * before writing to a non-sink slug.
 *
 * Unlike `append-unsafe.js`, this is NOT a bypass: it goes through real
 * admission. It just spares every test from hand-rolling the metadata event.
 *
 * @param {import('../../src/log/append.js').LogWriter} writer
 * @param {string} slug
 * @param {Object} [opts]
 * @param {string} [opts.type='reference'] - a TOPIC_TYPES enum value.
 * @param {string} [opts.status='active']
 * @param {string} [opts.principal='operator']
 * @param {string} [opts.summary] - optional TOPIC_METADATA_SET summary.
 * @param {string} [opts.ts] - optional ISO timestamp.
 * @returns {Promise<{seq:number, hash:string, entry:Object}>}
 */
export async function seedTopic(writer, slug, opts = {}) {
  const {
    type = 'reference',
    status = 'active',
    principal = 'operator',
    summary,
    ts,
  } = opts;
  const payload = { topic: slug, type, status };
  if (summary !== undefined) payload.summary = summary;
  return writer.append({
    type: 'TOPIC_METADATA_SET',
    isStateBearing: true,
    intentId: `intent:seed-topic-${slug}-${Math.random()}`,
    principal,
    payload,
    ts,
  });
}
