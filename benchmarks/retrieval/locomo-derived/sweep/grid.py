#!/usr/bin/env python3
"""P7 stage-1 grid (declared before any arm runs): first-call retrieval knobs, no model call.
usage: grid.py [stage1|stage2 <picks.json>] > arms.json   ->  [[name, flag, {env}], ...]
Every arm: LITSAN_DERIVED_FACT_RETRIEVAL=semantic, RAW_EVIDENCE=always, CONTEXT_LEAN=1, MAX=48 (so bytes bind).
"""
import json, sys

BASE_ENV = {"LITSAN_DERIVED_RAW_EVIDENCE": "always", "LITSAN_CONTEXT_LEAN": "1"}
BYTES = [3000, 4200, 6000, 8000, 11000, 16000]
ORDERS = ["cited_first", "fused", "interleave"]
LEADS = [4, 8, 16]


def arm(name, **kw):
    env = dict(BASE_ENV)
    env["LITSAN_DERIVED_RAW_EVIDENCE_MAX"] = str(kw.get("max", 48))
    env["LITSAN_DERIVED_RAW_EVIDENCE_BYTES"] = str(kw["bytes"])
    if kw.get("order"):
        env["LITSAN_DERIVED_RAW_EVIDENCE_ORDER"] = kw["order"]
        env["LITSAN_DERIVED_RAW_EVIDENCE_SEMANTIC_LEAD"] = str(kw["lead"])
    if kw.get("facts"):
        env["LITSAN_DERIVED_FACTS_MAX"] = str(kw["facts"])
    if kw.get("ratio"):
        env["LITSAN_DERIVED_RAW_EVIDENCE_MIN_RATIO"] = str(kw["ratio"])
    return [name, "semantic", env]


def stage1():
    arms = [["N4200", "semantic", {**BASE_ENV, "LITSAN_DERIVED_RAW_EVIDENCE_MAX": "16", "LITSAN_DERIVED_RAW_EVIDENCE_BYTES": "4200",
                                    "LITSAN_DERIVED_RAW_EVIDENCE_ORDER": "cited_first", "LITSAN_DERIVED_RAW_EVIDENCE_SEMANTIC_LEAD": "8"}]]
    for b in BYTES:
        arms.append(arm(f"u-b{b}", bytes=b))
        for o in ORDERS:
            for l in LEADS:
                arms.append(arm(f"{o[:2]}{l}-b{b}", bytes=b, order=o, lead=l))
    return arms


def stage2(picks):
    return [arm(f"{p['name']}-r{r}", bytes=p["bytes"], order=p.get("order"), lead=p.get("lead"), ratio=r) for p in picks for r in (0.3, 0.5)]


def stage_a1(score):
    """Amendment A1 (written after stage-1 results, before any A1 arm ran): facts lane 18/24 on the three stage-1 picks; lead 1/2."""
    arms = []
    for label, p in score["picks"].items():
        name = p["arm"]
        order = {"ci": "cited_first", "fu": "fused", "in": "interleave"}.get(name[:2])
        lead = int(name.split("-")[0][2:]) if order else None
        for f in (18, 24):
            arms.append(arm(f"{name}-f{f}", bytes=p["budget"] and int(name.split("-b")[1]), order=order, lead=lead, facts=f))
    for o in ("fused", "interleave"):
        for l in (1, 2):
            for b in (4200, 6000, 8000):
                arms.append(arm(f"{o[:2]}{l}-b{b}", bytes=b, order=o, lead=l))
    return arms


if __name__ == "__main__":
    out = stage_a1(json.load(open(sys.argv[2]))) if len(sys.argv) > 2 and sys.argv[1] == "a1" else stage2(json.load(open(sys.argv[2]))) if len(sys.argv) > 2 and sys.argv[1] == "stage2" else stage1()
    json.dump(out, sys.stdout, indent=1)
