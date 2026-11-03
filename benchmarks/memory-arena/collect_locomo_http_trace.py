#!/usr/bin/env python3
"""Collect structured LoCoMo search traces from Memory Arena HTTP services.

The collector performs search only. It does not ingest, reset, answer, or judge.
It preserves LoCoMo's two-speaker search lanes explicitly.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


def post_json(url: str, payload: dict[str, Any], timeout: int) -> Any:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode())


def extract_items(response: Any) -> list[dict[str, Any]]:
    if isinstance(response, list):
        return [x for x in response if isinstance(x, dict)]
    if not isinstance(response, dict):
        return []
    for key in ("memories", "results", "items", "data"):
        value = response.get(key)
        if isinstance(value, list):
            return [x for x in value if isinstance(x, dict)]
    return []


def normalize_item(item: dict[str, Any], rank: int) -> dict[str, Any]:
    out = dict(item)
    out["rank"] = rank
    if "content" not in out:
        for key in ("memory", "text", "fact", "atomic_fact"):
            if out.get(key) is not None:
                out["content"] = str(out[key])
                break
    if "evidence_refs" not in out:
        if isinstance(out.get("evidence_ref"), str):
            out["evidence_refs"] = [out["evidence_ref"]]
        elif isinstance(out.get("source_refs"), list):
            out["evidence_refs"] = out["source_refs"]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--service-url", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--backend", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--top-k", type=int, default=20)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--timeout", type=int, default=60)
    args = ap.parse_args()

    dataset = json.loads(Path(args.dataset).read_text())
    service = args.service_url.rstrip("/")
    grouped: dict[str, list[dict[str, Any]]] = {}

    jobs: list[tuple[int, int, dict[str, Any], str, str]] = []
    for conv_idx, row in enumerate(dataset):
        conv = row.get("conversation") or {}
        speaker_a = str(conv.get("speaker_a") or "speaker_a")
        speaker_b = str(conv.get("speaker_b") or "speaker_b")
        for qa_idx, qa in enumerate(row.get("qa") or []):
            if int(qa.get("category") or 0) == 5:
                continue
            jobs.append((conv_idx, qa_idx, qa, speaker_a, speaker_b))

    def run(job: tuple[int, int, dict[str, Any], str, str]) -> tuple[int, int, dict[str, Any]]:
        conv_idx, qa_idx, qa, speaker_a, speaker_b = job
        query = str(qa.get("question") or "")
        lanes: dict[str, list[dict[str, Any]]] = {}
        lane_meta: dict[str, Any] = {}
        started = time.perf_counter()
        status = "success"
        error = None
        for lane, speaker in (("speaker_a", speaker_a), ("speaker_b", speaker_b)):
            user_id = f"locomo_exp_user_{conv_idx}_{lane}_{args.version}"
            lane_started = time.perf_counter()
            try:
                response = post_json(
                    service + "/search",
                    {"query": query, "user_id": user_id, "top_k": args.top_k},
                    args.timeout,
                )
                items = [normalize_item(item, rank) for rank, item in enumerate(extract_items(response), start=1)]
                lanes[lane] = items
                lane_meta[lane] = {
                    "speaker": speaker,
                    "user_id": user_id,
                    "duration_ms": (time.perf_counter() - lane_started) * 1000,
                    "returned_items": len(items),
                }
            except Exception as exc:  # audit the failure, do not silently drop it
                lanes[lane] = []
                lane_meta[lane] = {
                    "speaker": speaker,
                    "user_id": user_id,
                    "duration_ms": (time.perf_counter() - lane_started) * 1000,
                    "returned_items": 0,
                    "error": f"{type(exc).__name__}: {exc}",
                }
                status = "failed"
                error = lane_meta[lane]["error"]
        return conv_idx, qa_idx, {
            "query": query,
            "category": int(qa.get("category") or 0),
            "gold_evidence": qa.get("evidence") or [],
            "lanes": lanes,
            "lane_meta": lane_meta,
            "top_k_per_lane": args.top_k,
            "duration_ms": (time.perf_counter() - started) * 1000,
            "status": status,
            **({"error": error} if error else {}),
        }

    results: dict[tuple[int, int], dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        future_map = {pool.submit(run, job): (job[0], job[1]) for job in jobs}
        done = 0
        for future in as_completed(future_map):
            key = future_map[future]
            results[key] = future.result()[2]
            done += 1
            if done % 100 == 0:
                print(f"trace_progress={done}/{len(jobs)}", flush=True)

    for conv_idx, row in enumerate(dataset):
        group_id = f"locomo_exp_user_{conv_idx}"
        ordered = []
        for qa_idx, qa in enumerate(row.get("qa") or []):
            if int(qa.get("category") or 0) == 5:
                continue
            ordered.append(results[(conv_idx, qa_idx)])
        grouped[group_id] = ordered

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "memory-quality-trace-v1",
        "backend": args.backend,
        "version": args.version,
        "service_url": args.service_url,
        "top_k_per_lane": args.top_k,
        "search_only_replay": True,
        "groups": grouped,
    }
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    flat = [r for rows in grouped.values() for r in rows]
    print(json.dumps({
        "output": str(output),
        "questions": len(flat),
        "success": sum(r["status"] == "success" for r in flat),
        "failed": sum(r["status"] != "success" for r in flat),
        "mean_items_per_query": sum(sum(len(v) for v in r["lanes"].values()) for r in flat) / len(flat),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
