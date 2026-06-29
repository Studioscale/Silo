/**
 * No-write choke-point — hybrid-search spec §4.9 (keystone), layer 2.
 *
 * The structural keystone of the no-write invariant has two layers:
 *   (1) call-graph/import ban — write/curate/distill modules may not import the
 *       search ranker (src/retrieval/index.js + semantic.js). Enforced by a lint
 *       test (test/no-write-guard.test.js).
 *   (2) THIS choke-point — write-producing APIs reject a retrieval RESULT object
 *       so a result can never be MECHANICALLY fed into a write.
 *
 * This module lives in admission (NOT src/retrieval/) precisely so write/curate/
 * distill can call it without importing the ranker — calling the ranker is what
 * layer 1 forbids. The ranker imports `stampRetrievalOrigin` from here to brand
 * its envelope; the write path imports `rejectRetrievalOrigin` to refuse a branded
 * payload. (Ranker→admission is allowed; the ban is one-directional.)
 *
 * Detection survives object passthrough, JSON round-trip, AND stringification:
 * the marker is a literal key whose name also appears verbatim in any JSON dump,
 * so a stringified result is caught by substring. Honest scope (§4.9): this stops
 * MECHANICAL dataflow; it cannot stop an agent/human reading a snippet's prose and
 * authoring a write — that crosses the LLM boundary and stays an ordinary,
 * auditable, explicit write.
 */

export const RETRIEVAL_ORIGIN_MARKER = '__silo_retrieval_origin__';

/**
 * Brand a retrieval envelope (mutates + returns it) so a downstream mechanical
 * consumer is detectable. `digest` is the query/cache digest (informational).
 */
export function stampRetrievalOrigin(obj, digest = true) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    obj[RETRIEVAL_ORIGIN_MARKER] = digest;
  }
  return obj;
}

/**
 * True iff `payload` carries the retrieval-origin marker — as an object key
 * (deep), inside an array, or as a substring of any string (covers a JSON.stringify
 * of a result and a stringified snippet object).
 */
export function containsRetrievalOrigin(payload, seen = new Set()) {
  if (payload == null) return false;
  if (typeof payload === 'string') return payload.includes(RETRIEVAL_ORIGIN_MARKER);
  if (typeof payload !== 'object') return false;
  if (seen.has(payload)) return false;
  seen.add(payload);
  if (Array.isArray(payload)) return payload.some((v) => containsRetrievalOrigin(v, seen));
  for (const key of Object.keys(payload)) {
    if (key === RETRIEVAL_ORIGIN_MARKER) return true;
    if (containsRetrievalOrigin(payload[key], seen)) return true;
  }
  return false;
}

/**
 * Throw if `payload` is retrieval-origin. Called at every write-producing
 * choke-point (write_event admission covers native + curate + distill + import +
 * CLI, since they all funnel through one append path; handoff guards separately).
 *
 * @param {*} payload
 * @param {string} where - the operation, for the error message
 */
export function rejectRetrievalOrigin(payload, where = 'write') {
  if (containsRetrievalOrigin(payload)) {
    throw new Error(
      `silo no-write invariant (§4.9): refusing to ${where} a retrieval-origin ` +
        `payload. Search results must never be mechanically consumed by a write/` +
        `curate/distill path. Author the write explicitly from your own reasoning.`,
    );
  }
}
