# SPEC — Local hybrid (lexical ⊕ semantic) search for Silo — FINAL (build-ready)

**Status: consolidated build candidate.** Self-contained merge of v4 + the v5 confirmation
fold (supersedes all earlier drafts). Author: desktop-claude. 2026-06-22.
**Target version: v0.3.0.**
**Review lineage:** v2 full 3-seat gauntlet → v3 targeted 3-seat re-review → v4 final 3-seat
confirmation on the two novel sections — all folded (`SEMANTIC-SEARCH-review-*.md`,
`-rereview-*.md`, `-confirm-*.md`). On ratification this file is promoted to
`proposals/hybrid-search.md`.

> **Verification-ledger honesty:** every `src/…:NN` citation is author/source-verified this
> session; an implementer must re-confirm against the repo before building.

> **One-paragraph summary.** Add **local, optional** semantic search fused with the existing
> keyword engine (RRF). Strictly opt-in (manual install + flag + explicit model). Search is
> **read-only** and **provably feeds no write** (a tested call-graph invariant). Results are
> **tiered by trust at the chunk level** (curated > note > source; retired excluded from
> relevance search, reachable via history), **default `scope=curated`** — lower tiers are an
> explicit opt-in that auto-promotes only after an answer-level over-trust eval passes.
> Embeddings never enter the log or canonical hash; **log-replay determinism is preserved**,
> agent-trajectory determinism is not claimed (and never was).

---

## 0. Verification ledger
1. **Lexical is per-topic over all `topic_content` incl. retired — VERIFIED.** `buildIndex`
   (`src/retrieval/index.js:43-69`). (#17 + §4.3 change this to per-unit, non-retired.)
2. **`topic_content` = every write_event (all tags), `{seq,tag,content,principal,ts}`, no
   hash — VERIFIED.** `src/interpret/index.js:402-410`.
3. **Trust tiers are tag-derived — VERIFIED.** curated = `tag==='CURATED'` ∧ not retired ∧
   imported-field rule (`buildLayer2`, `regenerate-topic-file.js:138-163`); source =
   `tag==='SOURCE'` (`buildLayer3`, `:168-183`); retirement folds at `interpret/index.js:290`.
4. **Agents cannot write raw transcripts — VERIFIED.** The MCP bridge exposes only
   `write_event` (tag ∈ {DECISION,FACT,CHANGED,PROCEDURE,TODO,EVENT}, ≤500 chars) +
   `write_handoff`. CURATED/SOURCE arrive via CLI/curation/import, not agents
   (`payload-validators.js:94-105`). So the `note` tier = short distilled events; the
   `source` tier = mostly one-time imported Layer-3.
5. **Retrieval is read-only, single caller — VERIFIED.** `retrieve()` called once
   (`src/cli/silo.js:274`, `cmdSearch`, `console.log`s). §4.9 makes the no-write property a
   tested call-graph invariant rather than a snapshot.
6. **Escalation unconditional in M1 — VERIFIED.** `retrieval/index.js:185-196`
   (`evidence_topics.length<2` always true). §4.7 removes the inert margin branch.
7. **`canonicalHash` = sha256(JCS(NFC)) — VERIFIED.** `canonical.js:52-54`.
8. **Optional-dep degrade pattern — VERIFIED.** `file-lock.js:29-43` (copy degrade-on-missing,
   not auto-install).
9. **Auth-before-ranking — VERIFIED.** `authorize()` filters before top-k in every mode
   (`retrieval/index.js:75-91`).
10. **Models load + speed — EMPIRICAL (Hetzner 2-vCPU):** e5-small 4.4 ms warm query / 606 MB
    RSS / 113 MB; bge-small-en 3.8 ms / 234 MB / 33 MB; both 384-dim. Dep tree 686 MB
    (`onnxruntime-web`+`sharp` → prune).

## 1. Problem & motivation
Keyword-only retrieval (BM25) trails dense retrieval as history grows and on multi-evidence
questions (`recall_all@5` ≈ 46–48% on LongMemEval _M; the shipped query-normalization fix
`fe59bcf` helped easy single-fact recall but not the gap). Add **local, optional** semantic
search fused with the lexical engine, **tiered by trust** so recall rises without letting
stale/unverified content masquerade as truth. Local, not API (privacy). Gains are **measured**
(§5), not asserted.

## 2. Goals / Non-goals
### Goals
- Hybrid `context_retrieval` (lexical ⊕ semantic, RRF k=60) **when enabled**, returning
  **chunk-level results tiered by trust** (§4.3/§4.6/§4.12), **default `scope=curated`**.
- **Strictly opt-in:** `silo semantic install` + `SILO_SEMANTIC=on` + explicit model. Off/
  absent → keyword-only as today (modulo the standalone retired-exclusion #17).
- **Local, private, reproducible:** pinned model revision + dep versions; model downloaded
  once; offline-vendorable.
- **Search is read-only** (regenerate owns the cache) and **provably feeds no write** (§4.9,
  a tested call-graph invariant).
- **Tiered transparency:** every result chunk labeled with its trust tier + provenance;
  retired facts reachable via explicit history.
- **Provable:** LongMemEval (fusion delta) + a Silo-native fixture with a **pre-registered
  numeric bar incl. an answer-level over-trust gate** (§5).

### Non-goals
- No vector DB; no API embeddings; no at-rest `.silo/` encryption (ACL is API-layer; the log
  is already plaintext); no semantic in `exact_lookup`; no `orientation_view` change; no
  per-language auto-switch; no cross-encoder; no M2 cards; no write-time provenance sidecar
  (deferred, coupled to the no-write invariant §4.9); no superseded-note detection.
- **No agent-trajectory determinism claim** (see §4.9) — never guaranteed, lexical or semantic.

## 3. Design overview
```
  context_retrieval(query, principal, scope=curated|all)        [default scope=curated]
        │  semantic DISABLED (default) ─────────────► today's lexical path (modulo #17)
        ▼  semantic ENABLED (install + flag + model)
  units = liveSearchUnits(state)  →  {slug, seq, chunk_index, tier∈[curated,note,source], content}
        │     (retired EXCLUDED; scope=curated keeps only tier=curated; ACL-filter slug-set ONCE)
  ┌─ LEXICAL ARM (per-unit) ───────┐   ┌─ SEMANTIC ARM (per-unit) ───────────────┐
  │ MiniSearch over unit text → L  │   │ cosine query vs cached chunk vecs → S    │
  └───────────────┬─────────────────┘   └───────────────┬──────────────────────────┘
                  └───────────────┬──────┘
                                  ▼ RRF(L,S,k=60,1-based; absent arm OMITTED from sum)
                                  ▼ rank by FUSED relevance; tier = LABEL + bounded prior (never an absolute sort)
                                  ▼ payload chunk-isolated by tier; per-chunk tier; provenance; status envelope
              results: { fused_rank[], grouped_by_tier{} }  (scope=curated → curated group only)
  (any error in the semantic block → caught → pure lexical fallback)
```

## 4. Detailed design

### 4.1 Strictly opt-in (triple gate) + `silo semantic install`
Activates only when all hold: deps installed via **`silo semantic install`** (pins dep
versions + checksums + vendors the model offline), `SILO_SEMANTIC=on`, and a model explicitly
chosen. Enabled-but-unavailable is surfaced in `silo doctor` **and** the result envelope
(§4.12). Deps are NOT in `package.json`. `embedder.js`: `semanticEnabled()` (all three gates),
singleton `getEmbedder()` (`try import / catch → unavailable`), `hasEmbedderSupport()`.

### 4.2 Model registry — explicit choice, pinned
`silo semantic install` makes the user pick (no silent default): `multilingual-e5-small`
(384-dim, ~100 langs, 606 MB RSS) or `bge-small-en-v1.5` (384-dim, EN, 234 MB). Each pins id +
revision hash + prefix profile (e5: `query:`/`passage:`; bge: query-instruction, no doc
prefix — wrong prefix silently wrecks recall, test §8). Both q8, mean-pooled, L2-normalized.
Inference local; model downloaded once.

### 4.3 `liveSearchUnits` — chunk-level, tiered, `scope=curated` default
```
liveSearchUnits(state) -> [{ slug, seq, chunk_index, tier, content }]      // the rankable unit is the CHUNK
  for each write_event in topic_content:
    if seq ∈ retired_curated_seqs            -> EXCLUDE (audit-only; reachable via history mode)
    elif tag==CURATED and (no imported hint OR imported.field=='curated') -> tier='curated'  // excludes event-log-origin imports
    elif tag==SOURCE  (buildLayer3-eligible) -> tier='source'
    else (FACT/DECISION/…)                   -> tier='note'
  chunk each unit per §4.11 -> one entry per (seq, chunk_index), carrying its tier
```
- **Both arms rank these same chunk units.** `buildIndex` (lexical) now indexes per-unit, not
  per-topic. **Tier is a property of the chunk, never rolled up to the slug** — a topic with a
  curated chunk and a note chunk contributes one unit to each tier; they are never merged.
- **`scope` (default `curated`):** `curated` → only `tier=='curated'` units enter either arm.
  `all` → all live tiers, **explicit opt-in**; the default flips to `all` only after §5's
  over-trust eval passes. `scope=curated` is the safety valve; risk lives only in `all`.
- **Retired is not a tier** — excluded from relevance search; the explicit **history mode**
  deliberately includes retired (with retirement date + reason). The audit log is the
  authoritative "why did this change."
- **Known limitation:** `note`/`source` units have **no retirement mechanism** today
  (retirement tracks curated seqs only) — they accumulate. This bounds `scope=all`'s value
  until retirement is extended to all tags (future), and is an additional reason lower tiers
  are off by default.

### 4.4 Embedding cache — read-only, content-addressed, split manifest
- **Built by `silo regenerate`** as a **projection** (gated by `semanticEnabled()` — zero cost
  on disabled installs). The "post-write refresh" is the existing regenerate-after-write step,
  i.e. a **projection writer**, NOT code imported by the write modules and NOT the search ranker
  (see §4.9 — the cache builder embeds *corpus text* into vectors; it never calls `retrieve()`/
  the ranker, so it does not consume retrieval output and does not violate the no-write ban).
  Embedding on the write path runs only when semantic is enabled; with it disabled the hook is a
  no-op. **Search never writes the cache.** A missing chunk vector is simply absent from semantic
  candidates until the next regenerate. Cache writes use a **separate projection lock**, never the
  append-log lock.
- **Candidates derive ONLY from current `liveSearchUnits(state)`; the occurrence index is
  lookup-only** (for each current live `{slug,seq,chunk_index,tier}`, fetch its vector if
  present). The cache is never enumerated as a candidate source — so a seq retired after the
  last regenerate can never re-surface.
- **Two stores:** a **vector store** keyed by `vector_key = canonicalHash(normalized_chunk_text)`
  (dedup across identical text — the store is identity-homogeneous, since an identity-manifest
  mismatch rebuilds the whole store, so the model/config identity need not be in the per-vector
  key); an **occurrence index**
  `{slug, seq, chunk_index, tier}` → `vector_key` (carries per-occurrence tier). Retirement
  filters at the occurrence-index layer; **the shared vector is intentionally retained** (a
  co-occurring live chunk may need it) — do not prune the vector on retire.
- **Manifest, two field classes:** *identity* (mismatch ⇒ rebuild whole store):
  `schema_version, model_id, model_revision, tokenizer_hash, transformers_version, ort_version,
  dtype, pooling, normalize, doc_prefix, query_prefix, chunker_version, chunk_size,
  chunk_overlap, max_tokens`. *Freshness* (drift ⇒ **use cache as-is**, newest chunks simply
  absent, NO nuke): `log_head_seq, log_head_hash, created_at`.
- **Scale ceiling by measurement:** JSON until `embeddings.json` > 10 MB **or** parse RSS past
  a set budget, then a packed `Float32Array` + offset index. `silo doctor` reports file size +
  vector/chunk count.

### 4.5 Ranker + ACL (per-chunk tier)
```
hybridRank(state, query, principal, scope):
  units = liveSearchUnits(state) ∩ scope ∩ { slug : authorize(state,[slug],principal) }   // ACL once per slug
  L = lexical rank of units (MiniSearch over unit text)
  S = (getEmbedder() ? semantic rank: cosine query-vec vs each unit's cached vector : [])
  fused = RRF(L, S)                                  // §4.6
  return { fused_rank: units sorted by fused score,  // tier is a LABEL on each unit, not a sort key
           grouped_by_tier: group(units, by per-chunk tier) }
```
ACL authorized **once per slug**; candidate carries `{slug, seq, chunk_index, tier}` (bullet-
level ACL future-proofed). No `bestTier`-per-slug; each surfaced unit keeps its own tier.

### 4.6 Fusion (RRF) — tier is a label, not a sort key
- **Candidate caps (defined):** each arm contributes its top **`n_pre = 100`** units into RRF
  (generous vs Silo's scale; rarely binds; a recall/perf knob). The semantic arm drops any unit
  below **`similarity_floor = 0.30`** cosine before ranking (cuts obvious false positives; eval-
  tuned). Both are surfaced in provenance (§4.10).
- `rrf(u)=Σ_{arm where u present} 1/(k+rank_arm(u))`, **k=60, 1-based. An absent arm is OMITTED
  from the sum** (not rank-0, not a penalty) — standard RRF; asserted in mock tests. Whether
  semantic-only units need extra weight is an eval-tuning knob (§5).
- **Primary order = fused relevance. Tier never dominates rank** — it's a **label** plus a
  bounded prior whose **v1 cap is `bounded_prior_cap = 0`** (i.e. in v1 tier has **zero** effect
  on order — pure fused relevance; tier is purely a display label). §5 tuning may later raise the
  cap; it is surfaced in provenance and can never displace a unit by more than the cap. The
  response exposes both `fused_rank` (recall/debug) and `grouped_by_tier` (safety display), with a
  "lower-tier hit outranked by trust tier" marker when a high-fused note/source sits below curated
  in the grouped view.

### 4.7 Payload — chunk-isolated by tier, non-authoritative
Payload isolates tiers: curated chunks and note/source chunks are in **separate blocks** even
within one topic (so a topic's curated chunk never makes its note chunks look verified). A
semantic-only unit returns its matched snippet + seq, token-capped, **labeled with its own
tier**. The inert M1 escalation margin branch is **removed** (re-introduced + reviewed at M2).
Payload shape is non-authoritative (§4.9).

### 4.8 Graceful fallback
The **entire** semantic block (embed → cosine → fuse → tier) is wrapped in one `try/catch`; any
error → log + return the lexical `L` list + `semantic_status='degraded'` in the envelope.
Semantic can never crash a search.

### 4.9 Keystone — no-write invariant + honest determinism scope
- **Preserved — LOG-REPLAY determinism:** the operation log is the source of truth and replays
  to byte-identical State on any machine. Nothing semantic enters the log, State, canonical
  hash, or admission/ACL.
- **NOT claimed — AGENT-TRAJECTORY determinism:** re-running an agent on the same task is not
  guaranteed to produce the same writes. An LLM is non-deterministic and its reads (lexical or
  semantic) influence its writes — always true; enabling semantic does not change the log-replay
  guarantee. An agent reading a result and authoring a write produces an ordinary, explicit,
  auditable log entry.
- **What "the retrieval module" means here (precise, to avoid a false collision):** the ban
  targets the **search ranker** — the code that produces retrieval *results* (`retrieve()` /
  `semanticRank` in `src/retrieval/`). It does **not** target the **embedder primitive**
  (`src/embedding/`, the model pipeline) or the **cache-projection builder** (`src/projection/`,
  which embeds corpus text into the cache via `regenerate`). Those embed *corpus text* and never
  call the ranker, so the write→regenerate→embed-corpus chain is permitted; only "write path reads
  a search *result*" is forbidden.
- **The guard (structural, two layers):** (1) **call-graph/import ban** — `write_event`/curate/
  distill modules may not import or call the **search ranker** (`src/retrieval/`); an import-graph
  lint/test fails on violation. (2) **choke-point** — write-producing APIs accept only
  caller-constructed payloads, never a retrieval result object; curate/distill input builders
  reject retrieval-origin payloads. Tests: object passthrough, JSON roundtrip, stringified snippet,
  handoff summary, curate input, distill input, CLI pipe.
- **Honest scope:** the guard stops Silo's **automated** pipelines from MECHANICALLY consuming
  retrieval via code dataflow. It does **not** (and cannot) stop an agent/human reading a result
  and authoring a write — semantic influence across the LLM boundary, harmless to log-replay.
  **Invariant wording:** "no semantic retrieval output is **mechanically** consumed by automated
  write/curate/distill paths in v1; user/agent-authored writes after reading results are ordinary
  explicit writes and remain auditable."
- **Provenance is read-time only**, not an audit-safety mechanism. **M2 coupling is
  self-enforcing:** the call-graph guard fails the moment a write path reads retrieval, so
  shipping M2 fused escalation / AI-cited writes forces keeping the separation OR landing the
  write-time sidecar in the same release.
- **At-rest:** ACL is API-layer, not disk encryption; log + topic files are already plaintext;
  embeddings are sensitive derived data that inherit `.silo/` permissions + deletion (pruned on
  retire/delete). Multi-principal confidentiality = encrypt `.silo/` (out of scope).

### 4.10 Provenance (read-time; expanded)
Each result carries `provenance = { retriever, model_id, model_revision, engine:{transformers_
version, ort_version, dtype}, corpus:{log_head_seq, log_head_hash, cache_manifest_digest},
principal, retrieval_config:{rrf_k, n_pre, similarity_floor, tier_order, bounded_prior_cap,
chunker_version, chunk_size, chunk_overlap}, query_digest, per_result:{lexical_rank?,
semantic_rank?, fused_rank, tier}, matched:[{slug, seq, chunk_index, tier, span}] }`. Additive read
metadata; never logged. (No `rollup` field — tier is per-chunk, never rolled up to the slug; topic
grouping for display is best-chunk and carries each chunk's own tier.)

### 4.11 Chunking (per-`seq`, fixed-window only)
**1 `seq` = 1 unit.** Pinned v1 values: **`max_tokens=512`, `chunk_size=256`, `chunk_overlap=64`**
(window ≤ max_tokens). A unit ≤ `max_tokens` → one chunk (`chunk_index=0`). Only a **single** unit
exceeding `max_tokens` is split by the fixed 256/64 token window **inside that one `seq`** — never
across `seq` boundaries (no Frankenstein chunks). No "sentence-aware" path (determinism). These
three values + `chunker_version` are **identity-manifest** fields (changing any nukes + rebuilds
the store); provenance carries token/char spans.

### 4.12 Tiered result contract
Results carry per-unit `tier`; envelope carries `authoritative_tiers:["curated"]`,
`advisory_tiers:["note","source"]`, `must_not_write_from_tiers:["note","source"]`, plus
`semantic_status: disabled|ready|unavailable|degraded` and `cache_status: fresh|stale|partial|
missing`. Default `scope=curated` returns only the authoritative tier; `scope=all` adds advisory
tiers, clearly isolated.

**`semantic_status` derivation (first match wins):** gate off (`!semanticEnabled()`) → `disabled`;
embedder import/model-load failed → `unavailable`; a runtime exception was caught in the semantic
block this query (§4.8) → `degraded`; else → `ready`.

**`cache_status` derivation (first match wins):** no store on disk → `missing`; store present but
**identity**-manifest mismatch (vectors from a different model/config; unusable until rebuild) →
`stale`; identity OK but **freshness** drift (`log_head` moved) OR ≥1 current live chunk has no
vector → `partial`; identity OK, head matches, every current live chunk has a vector → `fresh`.
(`stale` outranks `partial`: a model mismatch makes the whole store unusable regardless of
freshness.) When `cache_status ∈ {missing, stale}` the semantic arm contributes nothing and search
degrades to lexical until `regenerate` runs. **Consumer contract (load-bearing for `scope=all`, hence off by default
until §5 proves it):** the assistant must treat advisory tiers as unverified, must not write from
them without citing `seq`/tier, and must prefer the authoritative tier.

## 5. Eval & validation (pre-registered)
- **Track 1 — LongMemEval** (`--retriever=lexical|semantic|hybrid`, same `embedder.js` + same
  `liveSearchUnits`): fix the 4 harness bugs (gold derivation; user-turns-only; full-haystack
  nDCG; `recall_all@5` headline); report lexical/semantic/hybrid side-by-side (fusion delta).
- **Track 2 — Silo-native fixture:** stale-vs-corrected; retired bullet (must NOT surface in
  normal search; MUST in history mode); raw-uncurated-relevant; **noisy-large-raw vs
  terse-curated-correct on one query** (the adversarial conjunction); strong-correct-lower-tier
  vs weak-curated-distractors; PT↔EN; ACL-hidden; long blob (answer after token 512); semantic
  false-positives. Metrics: recall, **precision@k per tier**, MRR/nDCG, latency, RAM, cache size.
- **Answer-level over-trust gate (the real backstop):** feed a tiered result + the consumer
  contract to a judge LLM on queries where a **confidently-INCORRECT** note/source conflicts with
  the curated truth; score whether the assistant **refuses to answer from the lower tier**.
- **Pre-registered bar (set now; changeable only before the first run):** `scope=all` becomes the
  default ONLY if, on a holdout: (a) hybrid beats lexical `recall_all@5` on `_M` by ≥5 pts; (b)
  note/source precision@5 ≥ a set floor; (c) answer-level trust-compliance ≥ 95%; (d) zero curated
  no-regression failures (no query where lexical returns the right curated topic in top-k but
  hybrid drops it). Until then, **`scope=curated` is the shipped default.** If hybrid doesn't beat
  lexical at all, ship keyword-only — a valid outcome.

## 6. Interaction with existing subsystems
> **Build note (resolved ambiguity):** this spec under-specified `buildIndex` granularity across the
> two retrieval modes. Resolved during implementation as **per-topic for `exact_lookup`** (its
> card-first "find this specific thing" semantics are unchanged) and **per-unit for
> `context_retrieval`** (the per-unit lexical arm lives in `semantic.js#lexicalRank`). **#17
> (retired-exclusion) applies to BOTH** — retired bullets surface in neither.

- **#17 — `buildIndex` excludes retired** and indexes per-unit. Shipped as its **own standalone,
  clearly-documented change** (retired = removed; shouldn't surface); confirm no consumer expects
  retired in keyword results.
- **Shared `liveSearchUnits()`** feeds lexical, semantic, and (its curated subset) `buildLayer2` —
  one definition, no drift.
- **Regeneration:** new cache projection, separate lock, orphan + retire/delete pruning (vectors
  pruned only when no live occurrence references them, preserving dedup).
- **`silo doctor`:** semantic status, model, cache size, vector/chunk + per-tier counts.

## 7. Failure modes
Zero live units for a slug → absent from S, reachable via L. Retired between regen & search →
excluded by `liveSearchUnits` (current State); cache lookup-only so no stale vector surfaces.
Cold/partial cache → missing chunks absent, no disk write on search. Long blob → per-seq fixed-
window chunked (no silent truncation loss). Duplicate text → one vector, many occurrences. Corrupt
/revision mismatch → unavailable + visible status. NaN/Inf → rejected at write; §4.8 catches the rest.

## 8. Test plan
Existing tests stay green **except ≥1 asserting retired-in-keyword-results, which updates for
#17** (say so). Mock embedder for logic tests:
- cosine; **RRF (k=60, 1-based, absent-arm OMITTED not rank-0)**; **per-chunk tiering** (a topic's
  curated + note chunks land in separate tiers; no topic-level inheritance); **tier-as-label**
  (fused rank primary; bounded prior capped); `scope=curated` excludes non-curated from BOTH arms;
  **candidates-from-state-only** (retired-after-build-no-regen never surfaces; cache lookup-only;
  duplicate text where one occurrence retired one live); per-seq chunking (no cross-`seq` bleed) +
  cache-hit on re-chunk; **identity-vs-freshness manifest** (identity bump rebuilds; log-head drift
  does NOT); ACL-once-per-slug + before-fusion; **off-path identity** (disabled → today, modulo
  #17); semantic-only snippet payload; **whole-path try/catch fallback**; **search writes nothing**;
  **no-write call-graph guard** (lint fails if a write module imports retrieval) + **choke-point**
  (write APIs reject a retrieval result across object/JSON/string/handoff/curate/distill/CLI);
  envelope `semantic_status`/`cache_status`/tier fields; provenance shape.
- Integration (gated on `hasEmbedderSupport()`): real encoder finds a paraphrase lexical misses;
  retired bullet absent from normal search but present in history mode.
- Eval: both tracks + the over-trust judge fixture run on tiny fixtures offline.

## 9. Out of scope (v1)
At-rest encryption; bullet-level ACL (future-proofed); write-time provenance sidecar (coupled to
§4.9); API embeddings; `exact_lookup` semantic; `orientation_view` ranking; per-language auto-
switch; cross-encoder; M2 cards; binary vector store (JSON below the §4.4 ceiling); superseded-
note detection; retirement of note/source tags (the path to promoting `scope=all`).

## 10. Files touched
**New (module split enforces the §4.9 ban):** `src/embedding/embedder.js` — the **primitive**
(triple-gate loader, registry+pins, prefix profiles, embed text→vector); shared, importable by the
cache builder. `src/projection/embed-cache.js` — the **cache-projection builder** (embeds corpus
units via `regenerate`, vector-store + occurrence-index + manifest; gated by `semanticEnabled()`);
imports the primitive, NOT the ranker. `src/retrieval/semantic.js` — the **search ranker**
(`liveSearchUnits`, `liveChunkVectors`, cosine, tiering); **write/curate/distill may not import
this**. `src/retrieval/fusion.js` (`rrf`, absent-arm omit); `tiers.js`; `provenance.js`; CLI `silo
semantic install`; the no-write call-graph lint + choke-point + tests. **Modified:** `retrieval/index.js` (hybrid-when-enabled + off-path + tiered
output + envelope); `buildIndex` (#17 + per-unit, standalone); `regenerate-topic-file.js` (shared
`liveSearchUnits`); regenerate entry (cache + separate lock + pruning); `eval/longmemeval/*`
(`--retriever` + 4 fixes + bar + over-trust fixture) + Silo-native fixture; `silo doctor`;
README/CHANGELOG. **`package.json` unchanged.** **Untouched core:** `log/*`, `canonical.js`,
`interpret/*`, `matrix/*`.

## 11. Rollout & versioning
- **v0.3.0.** Default install unchanged + keyword-only; semantic = triple gate. The one universal
  change is **#17 (retired no longer surfaces in keyword search), shipped as its own documented
  change** with its own test. Default `scope=curated`; `scope=all` opt-in until the §5 bar promotes it.
- **Hold all push/deploy for Helder's OK** (HEAD `fe59bcf` unpushed). Build order:
  `liveSearchUnits`+chunking+cache core → no-write call-graph guard → lexical-per-unit + RRF +
  tiering → eval tracks. Build → tests green (incl. the guard) → both eval tracks vs the
  pre-registered bar → then discuss deploy.

## 12. Implementation acceptance criteria
A build is done when: all existing tests pass (minus the documented #17 update); the no-write
call-graph lint + choke-point tests pass; `scope=curated` is default and returns only curated-tier
units; chunk-level tiering verified (no topic-level inheritance); the cache is read-only at search
time and identity/freshness-split; both eval tracks run and the pre-registered bar is computed; and
`silo doctor` reports semantic status honestly. Promotion of `scope=all` to default requires the §5
bar to pass on a holdout — a separate, logged decision.
