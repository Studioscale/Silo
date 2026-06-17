#!/usr/bin/env python3
"""
Official cross-check for Silo's LongMemEval retrieval number.

Reads Silo's per-question rankings (emitted by `run-longmemeval.js --emit=...`)
and scores them with LongMemEval's OWN metric code
(src/retrieval/eval_utils.py -> evaluate_retrieval), excluding abstention
(`_abs`) questions exactly as the official src/evaluation/print_retrieval_metrics.py
does. It then also writes a print_retrieval_metrics-format log and runs that
official script, so the number carries the official stamp end-to-end (not our
re-implementation of the metric).

Usage:
  python official_score.py <rankings.jsonl> [--label NAME] [--repo PATH]
"""
import sys
import os
import json
import subprocess

argv = sys.argv[1:]
label = None
repo = r"C:\Users\studi\silo-eval-data\longmemeval\LongMemEval-repo"
pos = []
i = 0
while i < len(argv):
    if argv[i] == "--label":
        label = argv[i + 1]; i += 2
    elif argv[i] == "--repo":
        repo = argv[i + 1]; i += 2
    else:
        pos.append(argv[i]); i += 1
in_file = pos[0]
label = label or in_file

# numpy 2.x removed np.asfarray, which eval_utils.dcg() calls — shim it.
import numpy as np
if not hasattr(np, "asfarray"):
    np.asfarray = lambda x, dtype=np.float64: np.asarray(x, dtype=dtype)

sys.path.insert(0, os.path.join(repo, "src", "retrieval"))
from eval_utils import evaluate_retrieval  # LongMemEval's OWN metric code

KS = [1, 3, 5, 10]
rows = [json.loads(l) for l in open(in_file, encoding="utf-8") if l.strip()]
# Exclude abstention exactly as the official print_retrieval_metrics.py does.
kept = [r for r in rows if "_abs" not in r["question_id"]]

per_entry = []
agg = {k: {"any": [], "all": [], "ndcg": []} for k in KS}
for r in kept:
    ranked = r["ranked_session_ids"]
    gold = set(r["answer_session_ids"])
    rankings = list(range(len(ranked)))
    metrics = {}
    for k in KS:
        ra, rall, nd = evaluate_retrieval(rankings, gold, ranked, k=k)
        agg[k]["any"].append(ra)
        agg[k]["all"].append(rall)
        agg[k]["ndcg"].append(nd)
        metrics[f"recall_any@{k}"] = ra
        metrics[f"recall_all@{k}"] = rall
        metrics[f"ndcg_any@{k}"] = nd
    per_entry.append({"question_id": r["question_id"], "retrieval_results": {"metrics": {"session": metrics}}})


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


print(f"== Official LongMemEval scoring (eval_utils.evaluate_retrieval) — {label} ==")
print(f"questions scored: {len(kept)} (abstention _abs excluded, per official script; {len(rows)} total)")
print("session-level, computed by LongMemEval's own evaluate_retrieval:")
for k in KS:
    print(
        f"  recall_any@{k} = {mean(agg[k]['any'])*100:5.1f}%"
        f"   recall_all@{k} = {mean(agg[k]['all'])*100:5.1f}%"
        f"   ndcg@{k} = {mean(agg[k]['ndcg']):.3f}"
    )

# Also run the official print_retrieval_metrics.py on a log it accepts, for the
# literal official-script stamp (it prints session recall_all@5 / ndcg_any@5).
log_path = os.path.splitext(in_file)[0] + ".prm-log.jsonl"
with open(log_path, "w", encoding="utf-8") as f:
    for e in per_entry:
        f.write(json.dumps(e) + "\n")
script = os.path.join(repo, "src", "evaluation", "print_retrieval_metrics.py")
print("\n-- official print_retrieval_metrics.py output --")
try:
    out = subprocess.run([sys.executable, script, log_path], capture_output=True, text=True, timeout=120)
    print(out.stdout.strip() or "(no stdout)")
    if out.stderr.strip():
        print("stderr:", out.stderr.strip())
except Exception as e:  # noqa
    print(f"(could not run official script: {e})")
