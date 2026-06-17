# LongMemEval retrieval eval (Track A)

Measures **Silo's retrieval engine** (MiniSearch / BM25-family lexical search,
the same engine `silo search` uses) on [LongMemEval](https://github.com/xiaowu0162/LongMemEval)'s
session-retrieval task: given a question and a haystack of past chat sessions,
does the engine surface the session(s) that contain the answer.

**Scope + honesty.** This benchmarks the *search layer only* — not Silo's
curation, topic organization, or audit trail (LongMemEval doesn't test those).
Retrieval recall is one narrow axis; it is not where Silo's value mainly sits.
Numbers from this harness are **internal until they've passed an adversarial
methodology review** — don't publish them raw.

## Data (not committed — it's ~3 GB; keep it off OneDrive)

From HuggingFace `xiaowu0162/longmemeval-cleaned`:
- `longmemeval_s_cleaned.json` (~277 MB, ~50 sessions/question — "easy")
- `longmemeval_m_cleaned.json` (~2.74 GB, 500 sessions/question — "hard")

The runner defaults to `C:/Users/studi/silo-eval-data/longmemeval/`; pass a path
to override.

## Run

```
# scorecard (our own recall_any/all@k computation)
node eval/longmemeval/run-longmemeval.js <dataset.json> --query=keywords

# levers: --chunk=session|turn  --query=raw|keywords
#   query=keywords feeds the query through Silo's real normalizeQuery (the
#   shipped fix); query=raw is the pre-fix baseline.

# official cross-check (LongMemEval's OWN evaluate_retrieval + print_retrieval_metrics.py):
node eval/longmemeval/run-longmemeval.js <dataset.json> --query=keywords --emit=<rankings.jsonl>
python eval/longmemeval/official_score.py <rankings.jsonl> --label NAME --repo <cloned-LongMemEval-repo>
```

## Metric notes (read before comparing to anyone)

- **`recall_any@k`** — any gold session in top-k. The metric memory *vendors*
  (e.g. MemPalace) report. Easier; more flattering.
- **`recall_all@k`** — ALL gold sessions in top-k. What LongMemEval's own
  `print_retrieval_metrics.py` reports at session level, i.e. the *paper's*
  convention. Stricter.
- Comparisons must match on **metric (any vs all)**, **variant (_S vs _M, a 10×
  haystack difference)**, and **granularity (session vs turn)**, and must not
  confuse retrieval recall with end-to-end QA accuracy. Getting any of these
  wrong is the standard way these numbers mislead.
