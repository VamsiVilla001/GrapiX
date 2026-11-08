"""Run one decision set through Laya (local) and Jev (TypeSafe API) and compare.

Usage: python compare.py <decision.json> [--out answers.json]

decision.json: {"state": <object or string>, "questions": {name: {"type": "choice"|"noul"|"score",
"instructions": str, "criteria": {...} | [..] | null}}}

Both models take the same state and questions. The Jev call goes through the
Node SDK runner (jev_runner.mjs) so the key handling stays in one place; the
key is read from D:/Project KK/secrets/jev.txt by that runner and never printed.
"""
import argparse, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


def run_laya(state, questions):
    import laya  # the convaiinnovations/laya package, installed in ./venv
    model_id = os.environ.get("LAYA_MODEL", "convaiinnovations/laya-multilingual")
    t0 = time.perf_counter()
    model = laya.load(model_id)
    loaded = time.perf_counter() - t0
    laya_questions = {
        name: {k: v for k, v in q.items() if k in ("type", "instructions", "criteria")}
        for name, q in questions.items()
    }
    # The base checkpoint reads 512 tokens and truncates silently; laya-multilingual reads 8192.
    max_len = int(os.environ.get("LAYA_MAX_LEN", "8192" if "multilingual" in model_id else "512"))
    t1 = time.perf_counter()
    result = model.system_one(state, laya_questions, max_len=max_len)
    usage = result.get("usage", {})
    if usage.get("truncated"):
        raise SystemExit(f"Laya read only part of the state: {usage}")
    return {"model": model_id, "max_len": max_len, "state_tokens": usage.get("state_tokens"), "truncated": False,
            "load_s": round(loaded, 2), "predict_s": round(time.perf_counter() - t1, 3), "answers": result["answers"]}


def run_jev(state, questions):
    runner = os.path.join(HERE, "..", "typesafe-sdk", "jev_runner.mjs")
    payload = json.dumps({"state": state, "questions": questions})
    out = subprocess.run(["node", runner], input=payload.encode("utf-8"), capture_output=True, check=True)
    return json.loads(out.stdout.decode("utf-8"))


def pick(answer):
    """The chosen option / probability of an answer in either model's shape."""
    if not isinstance(answer, dict):
        return answer
    for key in ("choice", "score", "noul"):
        if key in answer:
            return answer[key]
    return answer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("decision")
    ap.add_argument("--out")
    ap.add_argument("--skip-jev", action="store_true")
    args = ap.parse_args()
    spec = json.load(open(args.decision, encoding="utf-8"))
    state, questions = spec["state"], spec["questions"]
    laya_out = run_laya(state, questions)
    jev_out = None if args.skip_jev else run_jev(state, questions)
    rows = []
    for name, q in questions.items():
        l = pick(laya_out["answers"].get(name))
        j = pick(jev_out["answers"].get(name)) if jev_out else None
        agree = None if jev_out is None else (l == j if q["type"] != "noul" else abs(float(l) - float(j)) < 0.25)
        rows.append({"question": name, "type": q["type"], "laya": l, "jev": j, "agree": agree,
                     "laya_detail": laya_out["answers"].get(name), "jev_detail": jev_out["answers"].get(name) if jev_out else None})
    report = {"laya": {k: v for k, v in laya_out.items() if k != "answers"}, "jev_model": jev_out and jev_out.get("model"), "rows": rows,
              "agreement": None if jev_out is None else sum(1 for r in rows if r["agree"]) / max(len(rows), 1)}
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(text)
    print(text)


if __name__ == "__main__":
    main()
