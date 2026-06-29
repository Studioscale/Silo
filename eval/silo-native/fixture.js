/**
 * Track 2 — Silo-native eval fixture (hybrid-search §5).
 *
 * A tiny, hand-built corpus + query set exercising the cases LongMemEval cannot:
 * trust tiers, retirement, ACL, PT↔EN, long blobs, and the adversarial
 * "confidently-wrong lower tier vs terse-correct curated" conjunction that the
 * answer-level over-trust gate scores. Deterministic; runs offline with the mock
 * embedder. Real numbers come from running this with the installed model.
 *
 * writes:  [slug, tag, content]   (CURATED→curated tier, SOURCE→source, else note)
 * seals:   [slug, [readers]]
 * retire:  [slug, contentSubstring]  (retire the curated bullet matching substring)
 * queries: { id, query, principal, scope, gold:[{slug}], case, over_trust? }
 *   over_trust: { correct_slug, wrong_tier } — a lower tier confidently contradicts
 *               the curated truth; a contract-following assistant must refuse it.
 */

export const fixture = {
  principals: ['helder', 'alice'],
  writes: [
    // stale-vs-corrected: curated has the CORRECT supplier; a note is stale/wrong.
    ['suppliers', 'CURATED', 'current primary coating supplier is Ferro Brasil since 2026'],
    ['suppliers', 'FACT', 'coating supplier is Tinta Velha'], // stale note (wrong now)

    // retired bullet — must NOT surface in normal search (reachable via history).
    ['pricing', 'CURATED', 'standard markup is 35 percent on fabrication'],
    ['pricing', 'CURATED', 'standard markup is 28 percent on fabrication'], // will be retired

    // raw-uncurated-relevant: only a SOURCE blob answers this.
    ['invoices', 'SOURCE', 'Invoice 8841 line item: galvanized sheet 2mm, quantity 40, delivered 2026-05-03'],

    // noisy-large-raw vs terse-curated-correct (same query target).
    ['welding', 'CURATED', 'use ER70S-6 wire for mild steel'],
    ['welding', 'SOURCE', 'forum dump: people argue about ER70S-6 vs ER70S-3 vs flux core for hours ' +
      'and mention mild steel stainless aluminum mig tig stick in a long rambling unstructured thread'],

    // PT↔EN: query in EN, content in PT.
    ['producao', 'CURATED', 'o prazo de entrega padrão é de 15 dias úteis'],

    // ACL-hidden: alice-only sealed curated unit.
    ['alice-private', 'CURATED', 'alice salary review scheduled next quarter'],

    // semantic false-positive bait: lexically/again unrelated curated line.
    ['weather', 'CURATED', 'the workshop roof leaks when it rains heavily'],
  ],
  seals: [
    ['alice-private', ['alice', 'operator']],
  ],
  retire: [
    ['pricing', '28 percent'], // retire the superseded markup bullet
  ],
  queries: [
    {
      id: 'q-supplier', query: 'who is our coating supplier', principal: 'helder', scope: 'all',
      gold: [{ slug: 'suppliers', tier: 'curated' }], case: 'stale-vs-corrected',
      over_trust: { correct_slug: 'suppliers', wrong_tier: 'note' },
    },
    {
      id: 'q-markup', query: 'what is the standard markup', principal: 'helder', scope: 'curated',
      gold: [{ slug: 'pricing', tier: 'curated' }], case: 'retired-excluded',
      forbidden_content: '28 percent',
    },
    {
      id: 'q-invoice', query: 'galvanized sheet delivery quantity', principal: 'helder', scope: 'all',
      gold: [{ slug: 'invoices', tier: 'source' }], case: 'raw-uncurated-relevant',
    },
    {
      id: 'q-welding', query: 'which welding wire for mild steel', principal: 'helder', scope: 'curated',
      gold: [{ slug: 'welding', tier: 'curated' }], case: 'noisy-raw-vs-terse-curated',
    },
    {
      id: 'q-prazo', query: 'standard delivery deadline', principal: 'helder', scope: 'curated',
      gold: [{ slug: 'producao', tier: 'curated' }], case: 'pt-en',
    },
    {
      id: 'q-acl-helder', query: 'alice salary review', principal: 'helder', scope: 'all',
      gold: [], case: 'acl-hidden', forbidden_slug: 'alice-private',
    },
    {
      id: 'q-acl-alice', query: 'alice salary review', principal: 'alice', scope: 'all',
      gold: [{ slug: 'alice-private', tier: 'curated' }], case: 'acl-visible',
    },
  ],
};
