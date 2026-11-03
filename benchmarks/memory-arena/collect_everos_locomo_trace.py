#!/usr/bin/env python3
"""Collect LoCoMo structured retrieval traces from local EverOS without answer/judge LLM calls."""
from __future__ import annotations
import argparse, json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
import requests


def normalize_items(payload: dict[str, Any], top_k: int) -> list[dict[str, Any]]:
    data = payload.get("data") or {}
    episodes = data.get("episodes") or []
    items: list[dict[str, Any]] = []
    for ep in episodes:
        if not isinstance(ep, dict):
            continue
        session_id = ep.get("session_id")
        facts = ep.get("atomic_facts") or []
        if facts:
            for fact in facts:
                if not isinstance(fact, dict):
                    continue
                content = str(fact.get("content") or fact.get("atomic_fact") or "").strip()
                if not content:
                    continue
                items.append({
                    "id": fact.get("id") or "",
                    "content": content,
                    "memory": content,
                    "score": fact.get("score", ep.get("score")),
                    "session_id": session_id,
                    "parent_episode_id": ep.get("id"),
                    "retrieval_type": "atomic_fact",
                })
        else:
            content = str(ep.get("episode") or ep.get("summary") or ep.get("subject") or "").strip()
            if not content:
                continue
            items.append({
                "id": ep.get("id") or "",
                "content": content,
                "memory": content,
                "score": ep.get("score"),
                "session_id": session_id,
                "retrieval_type": "episode",
            })
    def score(item: dict[str, Any]) -> float:
        try: return float(item.get("score"))
        except (TypeError, ValueError): return float("-inf")
    items.sort(key=score, reverse=True)
    for rank, item in enumerate(items[:top_k], 1):
        item["rank"] = rank
    return items[:top_k]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=".review-runtime/memory-arena/OmniMemEval/data/locomo/locomo10.json")
    ap.add_argument("--service", default="http://127.0.0.1:1995")
    ap.add_argument("--version", default="arena_chat_defer_20261024")
    ap.add_argument("--top-k", type=int, default=20)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    rows = json.loads(Path(args.dataset).read_text())
    session = requests.Session(); session.trust_env = False

    jobs = []
    for ci, row in enumerate(rows):
        conv = row["conversation"]
        qas = [q for q in row["qa"] if q.get("category") != 5]
        for qi, qa in enumerate(qas): jobs.append((ci, qi, conv, qa))

    def one(job):
        ci, qi, conv, qa = job
        query = str(qa.get("question") or "")
        lanes, meta = {}, {}
        status, error = "success", None
        for lane in ("speaker_a", "speaker_b"):
            suffix = "a" if lane == "speaker_a" else "b"
            uid = f"locomo_exp_user_{ci}_speaker_{suffix}_{args.version}"
            body = {
                "query": query, "user_id": uid,
                "app_id": "omnimemeval", "project_id": "memory-arena",
                "method": "hybrid", "top_k": args.top_k, "include_profile": False,
            }
            t0 = time.perf_counter()
            try:
                r = session.post(args.service + "/api/v1/memory/search", json=body, timeout=args.timeout)
                r.raise_for_status()
                items = normalize_items(r.json(), args.top_k)
                lanes[lane] = items
                meta[lane] = {"user_id": uid, "duration_ms": (time.perf_counter()-t0)*1000, "returned_items": len(items)}
            except Exception as exc:
                lanes[lane] = []
                meta[lane] = {"user_id": uid, "duration_ms": (time.perf_counter()-t0)*1000, "returned_items": 0, "error": f"{type(exc).__name__}: {exc}"}
                status, error = "failed", meta[lane]["error"]
        return ci, qi, {
            "query": query,
            "category": qa.get("category"),
            "gold_answer": qa.get("answer"),
            "gold_evidence": qa.get("evidence") or [],
            "lanes": lanes,
            "lane_meta": meta,
            "duration_ms": sum(float(v.get("duration_ms", 0.0)) for v in meta.values()),
            "status": status,
            **({"error": error} if error else {}),
        }

    grouped: dict[str, list[Any]] = {f"locomo_exp_user_{i}": [] for i in range(len(rows))}
    ordered: dict[tuple[int,int], dict[str,Any]] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(one, j) for j in jobs]
        done = 0
        for fut in as_completed(futs):
            ci, qi, rec = fut.result(); ordered[(ci,qi)] = rec; done += 1
            if done % 100 == 0: print(f"{done}/{len(jobs)}", flush=True)
    for ci, row in enumerate(rows):
        n = sum(1 for q in row["qa"] if q.get("category") != 5)
        grouped[f"locomo_exp_user_{ci}"] = [ordered[(ci,qi)] for qi in range(n)]
    flat=[x for v in grouped.values() for x in v]
    out={
        "schema":"locomo-memory-quality-trace-v1",
        "backend":"everos",
        "version":args.version,
        "service_url":args.service,
        "top_k_per_lane":args.top_k,
        "search_only_replay":True,
        "trace_semantics":"EverOS hybrid selected atomic facts flattened from parent episode DTOs and ordered by returned score; episode-only hits retained; profiles excluded",
        "groups":grouped,
    }
    Path(args.output).write_text(json.dumps(out,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps({"output":args.output,"questions":len(flat),"success":sum(r['status']=='success' for r in flat),"failed":sum(r['status']!='success' for r in flat),"mean_items_per_query":sum(sum(len(v) for v in r['lanes'].values()) for r in flat)/len(flat)},indent=2))
if __name__ == '__main__': main()
