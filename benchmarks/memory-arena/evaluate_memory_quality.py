#!/usr/bin/env python3
"""Memory Arena Memory Quality evaluator.

Primary purpose: evaluate the memory layer separately from answer generation.
The evaluator consumes LoCoMo gold evidence turn IDs plus search artifacts.

Historical search artifacts that only contain formatted context can be scored
for context-level strict evidence coverage, semantic evidence similarity,
context footprint, latency and failures. Rank-sensitive Recall@K / Hit@K / MRR
are emitted only when ordered structured items are available.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import re
import statistics
import unicodedata
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

CATEGORY_NAMES = {
    1: "multi_hop",
    2: "temporal",
    3: "open_domain",
    4: "single_hop",
    5: "adversarial",
}
DEFAULT_KS = (1, 5, 10, 20)
EVALUATOR_VERSION = "memory-quality-v1-draft-20261024"


def canonical_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", str(value or "")).lower()
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())


def normalize_evidence_id(value: str) -> list[str]:
    """Extract LoCoMo dia IDs, including known compound/zero-padded forms.

    Examples:
      D8:6; D9:17 -> [D8:6, D9:17]
      D:11:26     -> [D11:26]
      D30:05      -> [D30:5]
    """
    text = str(value or "").replace("D:", "D")
    refs: list[str] = []
    for session, turn in re.findall(r"D(\d+):(\d+)", text):
        refs.append(f"D{int(session)}:{int(turn)}")
    return refs


def evidence_session_ids(values: Any) -> list[int]:
    """Return sorted LoCoMo session numbers referenced by evidence IDs.

    This supports supplementary session-level provenance diagnostics only.
    It does not turn a session hit into a source-turn hit.
    """
    if values is None:
        return []
    if isinstance(values, (str, int, float)):
        values = [values]
    sessions: set[int] = set()
    for raw in values:
        for ref in normalize_evidence_id(str(raw)):
            match = re.fullmatch(r"D(\d+):\d+", ref)
            if match:
                sessions.add(int(match.group(1)))
    return sorted(sessions)


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    xs = sorted(values)
    if len(xs) == 1:
        return float(xs[0])
    idx = (len(xs) - 1) * q
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return float(xs[lo])
    frac = idx - lo
    return float(xs[lo] * (1 - frac) + xs[hi] * frac)


def stats(values: Iterable[float]) -> dict[str, float | None]:
    xs = [float(x) for x in values]
    if not xs:
        return {"mean": None, "p50": None, "p95": None, "max": None}
    return {
        "mean": float(statistics.fmean(xs)),
        "p50": percentile(xs, 0.50),
        "p95": percentile(xs, 0.95),
        "max": float(max(xs)),
    }


class TokenCounter:
    def __init__(self) -> None:
        self.name = "fallback_whitespace_plus_char4"
        self._enc = None
        try:
            import tiktoken  # type: ignore
            self._enc = tiktoken.get_encoding("cl100k_base")
            self.name = "cl100k_base"
        except Exception:
            pass

    def count(self, text: str) -> int:
        if self._enc is not None:
            return len(self._enc.encode(text or ""))
        text = text or ""
        words = len(re.findall(r"\S+", text))
        return max(words, math.ceil(len(text) / 4)) if text else 0


@dataclass
class GoldTurn:
    evidence_id: str
    text: str
    speaker: str | None


@dataclass
class QuestionGold:
    group_id: str
    category: int
    category_name: str
    question: str
    answer: str
    evidence_ids: list[str]
    evidence_turns: list[GoldTurn]
    unresolved_refs: list[str]


def build_gold(dataset: list[dict[str, Any]]) -> tuple[dict[str, list[QuestionGold]], dict[str, Any]]:
    grouped: dict[str, list[QuestionGold]] = {}
    unresolved: list[dict[str, Any]] = []
    no_resolvable_gold = 0

    for group_idx, row in enumerate(dataset):
        group_id = f"locomo_exp_user_{group_idx}"
        turn_map: dict[str, GoldTurn] = {}
        conversation = row.get("conversation") or {}
        for key, value in conversation.items():
            if not (str(key).startswith("session_") and not str(key).endswith("date_time")):
                continue
            if not isinstance(value, list):
                continue
            for message in value:
                if not isinstance(message, dict):
                    continue
                raw_id = str(message.get("dia_id") or "")
                match = re.fullmatch(r"D(\d+):(\d+)", raw_id)
                if not match:
                    continue
                evidence_id = f"D{int(match.group(1))}:{int(match.group(2))}"
                turn_map[evidence_id] = GoldTurn(
                    evidence_id=evidence_id,
                    text=str(message.get("text") or ""),
                    speaker=(str(message.get("speaker")) if message.get("speaker") is not None else None),
                )

        questions: list[QuestionGold] = []
        for qa in row.get("qa") or []:
            category = int(qa.get("category") or 0)
            if category == 5:
                continue
            evidence_ids: list[str] = []
            for raw_ref in qa.get("evidence") or []:
                for ref in normalize_evidence_id(raw_ref):
                    if ref not in evidence_ids:
                        evidence_ids.append(ref)
            turns = [turn_map[ref] for ref in evidence_ids if ref in turn_map]
            missing = [ref for ref in evidence_ids if ref not in turn_map]
            if missing:
                unresolved.append({
                    "group_id": group_id,
                    "question": str(qa.get("question") or ""),
                    "refs": missing,
                })
            if not turns:
                no_resolvable_gold += 1
            questions.append(QuestionGold(
                group_id=group_id,
                category=category,
                category_name=CATEGORY_NAMES.get(category, f"category_{category}"),
                question=str(qa.get("question") or ""),
                answer=str(qa.get("answer") or ""),
                evidence_ids=evidence_ids,
                evidence_turns=turns,
                unresolved_refs=missing,
            ))
        grouped[group_id] = questions

    return grouped, {
        "groups": len(grouped),
        "questions": sum(len(v) for v in grouped.values()),
        "unresolved_gold_refs": unresolved,
        "no_resolvable_gold_questions": no_resolvable_gold,
    }


def load_grouped_records(path: Path) -> dict[str, list[dict[str, Any]]]:
    data = json.loads(path.read_text())
    if isinstance(data, dict) and isinstance(data.get("groups"), dict):
        data = data["groups"]
    if isinstance(data, dict):
        out: dict[str, list[dict[str, Any]]] = {}
        for key, value in data.items():
            if isinstance(value, list):
                out[str(key)] = [x for x in value if isinstance(x, dict)]
        return out
    raise ValueError(f"Expected grouped search-result JSON object in {path}")


def records_by_query(records: list[dict[str, Any]]) -> dict[str, collections.deque[dict[str, Any]]]:
    out: dict[str, collections.deque[dict[str, Any]]] = collections.defaultdict(collections.deque)
    for record in records:
        out[str(record.get("query") or "")].append(record)
    return out


def context_from_record(record: dict[str, Any]) -> str:
    context = str(record.get("context") or record.get("raw_context") or "")
    if context:
        return context
    lanes = structured_lanes(record)
    if lanes:
        parts: list[str] = []
        for lane, items in lanes.items():
            parts.append(f"[{lane}]")
            parts.extend(item_content(item) for item in items if item_content(item))
        return "\n".join(parts)
    return ""


def structured_lanes(record: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    lanes = record.get("lanes")
    if isinstance(lanes, dict):
        out: dict[str, list[dict[str, Any]]] = {}
        for lane, value in lanes.items():
            if isinstance(value, list):
                out[str(lane)] = [x for x in value if isinstance(x, dict)]
        if out:
            return out
    for key in ("items", "memories", "results", "search_results"):
        value = record.get(key)
        if isinstance(value, list):
            return {"global": [x for x in value if isinstance(x, dict)]}
    return {}


def structured_items(record: dict[str, Any]) -> list[dict[str, Any]]:
    lanes = structured_lanes(record)
    return [item for lane_items in lanes.values() for item in lane_items]


def item_content(item: dict[str, Any]) -> str:
    for key in ("content", "memory", "text", "fact", "atomic_fact"):
        value = item.get(key)
        if value is not None:
            return str(value)
    return ""


def item_session_number(item: dict[str, Any]) -> int | None:
    """Extract a native source-session number when a structured hit exposes one."""
    value = item.get("session_id")
    if value is None:
        return None
    match = re.search(r"(?:^|_)session_(\d+)$", str(value))
    if not match:
        return None
    return int(match.group(1))


def item_refs(item: dict[str, Any]) -> list[str]:
    values: list[Any] = []
    for key in ("evidence_refs", "source_refs", "evidence_ref", "source_ref", "dia_ids", "dia_id"):
        value = item.get(key)
        if isinstance(value, list):
            values.extend(value)
        elif value is not None:
            values.append(value)
    refs: list[str] = []
    for value in values:
        for ref in normalize_evidence_id(str(value)):
            if ref not in refs:
                refs.append(ref)
    return refs


def fragment_context(context: str, max_chars: int = 1200) -> list[str]:
    """Deterministic fragments for semantic diagnostics on context-only runs.

    This is NOT used for provenance Recall@K/MRR. It only keeps long formatted
    context blobs within the embedding model's practical input range.
    """
    text = context.replace("\r\n", "\n")
    text = re.sub(r"(?m)^\s*[-•]\s+", "\n", text)
    text = text.replace("[Memory Arena ingestion boundary]", "\n")
    blocks = [b.strip() for b in re.split(r"\n\s*\n|\n(?=(?:User|Assistant|user|assistant):)", text) if b.strip()]
    fragments: list[str] = []
    for block in blocks:
        if len(block) <= max_chars:
            fragments.append(block)
            continue
        # Prefer line/sentence boundaries, then hard-wrap deterministically.
        pieces = [p.strip() for p in re.split(r"(?<=[.!?])\s+|\n+", block) if p.strip()]
        buf = ""
        for piece in pieces:
            if len(piece) > max_chars:
                if buf:
                    fragments.append(buf)
                    buf = ""
                for start in range(0, len(piece), max_chars):
                    fragments.append(piece[start:start + max_chars])
                continue
            if buf and len(buf) + 1 + len(piece) > max_chars:
                fragments.append(buf)
                buf = piece
            else:
                buf = f"{buf} {piece}".strip()
        if buf:
            fragments.append(buf)
    return fragments or ([context] if context else [])


class LocalOpenAIEmbedder:
    def __init__(self, base_url: str, model: str, batch_size: int = 64) -> None:
        self.url = base_url.rstrip("/") + "/embeddings"
        self.model = model
        self.batch_size = batch_size
        self.cache: dict[str, list[float]] = {}

    def embed_many(self, texts: list[str]) -> list[list[float]]:
        missing = [t for t in dict.fromkeys(texts) if t not in self.cache]
        for start in range(0, len(missing), self.batch_size):
            batch = missing[start:start + self.batch_size]
            payload = json.dumps({"model": self.model, "input": batch}).encode()
            req = urllib.request.Request(self.url, data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as response:
                body = json.loads(response.read().decode())
            vectors = [row["embedding"] for row in sorted(body["data"], key=lambda x: x["index"])]
            if len(vectors) != len(batch):
                raise RuntimeError(f"Embedding response length mismatch: {len(vectors)} != {len(batch)}")
            for text, vector in zip(batch, vectors):
                self.cache[text] = [float(x) for x in vector]
        return [self.cache[t] for t in texts]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if not na or not nb:
        return 0.0
    return dot / (na * nb)


def semantic_scores(embedder: LocalOpenAIEmbedder, gold_texts: list[str], candidate_texts: list[str]) -> list[float]:
    if not gold_texts or not candidate_texts:
        return []
    gold_vecs = embedder.embed_many(gold_texts)
    candidate_vecs = embedder.embed_many(candidate_texts)
    return [max(cosine(g, c) for c in candidate_vecs) for g in gold_vecs]


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    dataset = json.loads(Path(args.dataset).read_text())
    gold_by_group, gold_meta = build_gold(dataset)
    records_by_group = load_grouped_records(Path(args.search_results))
    token_counter = TokenCounter()
    embedder = None
    if args.embedding_base_url:
        embedder = LocalOpenAIEmbedder(args.embedding_base_url, args.embedding_model, args.embedding_batch_size)

    per_query: list[dict[str, Any]] = []
    missing_search: list[dict[str, str]] = []

    for group_id, questions in gold_by_group.items():
        available = records_by_query(records_by_group.get(group_id, []))
        for gold in questions:
            queue = available.get(gold.question)
            if not queue:
                missing_search.append({"group_id": group_id, "question": gold.question})
                record: dict[str, Any] = {"query": gold.question, "context": "", "status": "missing"}
            else:
                record = queue.popleft()

            context = context_from_record(record)
            canon_context = canonical_text(context)
            evidence_hits: list[bool] = []
            for turn in gold.evidence_turns:
                canon_turn = canonical_text(turn.text)
                evidence_hits.append(bool(canon_turn and canon_turn in canon_context))

            answer_canon = canonical_text(gold.answer)
            answer_present = bool(answer_canon and answer_canon in canon_context)
            items = structured_items(record)
            if items:
                fragments = []
                for item in items:
                    content = item_content(item)
                    if content:
                        fragments.extend(fragment_context(content))
            else:
                fragments = fragment_context(context)
            semantic = semantic_scores(embedder, [t.text for t in gold.evidence_turns], fragments) if embedder else []

            trace: dict[str, Any] = {}
            lanes = structured_lanes(record)
            if items and gold.evidence_ids:
                provenance_available = any(item_refs(item) for item in items)
                lane_strict_matches: dict[str, list[set[str]]] = {}
                for lane, lane_items in lanes.items():
                    matches: list[set[str]] = []
                    for item in lane_items:
                        c = canonical_text(item_content(item))
                        matches.append({
                            turn.evidence_id for turn in gold.evidence_turns
                            if canonical_text(turn.text) and canonical_text(turn.text) in c
                        })
                    lane_strict_matches[lane] = matches

                if provenance_available:
                    covered_at: dict[str, float] = {}
                    hit_at: dict[str, float] = {}
                    first_rank = None
                    for k in args.ks:
                        refs = set()
                        for lane_items in lanes.values():
                            for item in lane_items[:k]:
                                refs.update(item_refs(item))
                        hit_gold = set(gold.evidence_ids) & refs
                        covered_at[str(k)] = len(hit_gold) / len(gold.evidence_ids)
                        hit_at[str(k)] = 1.0 if hit_gold else 0.0
                    lane_first_ranks = []
                    for lane_items in lanes.values():
                        for rank, item in enumerate(lane_items, start=1):
                            if set(item_refs(item)) & set(gold.evidence_ids):
                                lane_first_ranks.append(rank)
                                break
                    if lane_first_ranks:
                        first_rank = min(lane_first_ranks)
                    rr = (1.0 / first_rank) if first_rank else 0.0
                    trace["provenance"] = {
                        "available": True,
                        "rank_semantics": "per_lane_union" if len(lanes) > 1 else "global",
                        "recall_at_k": covered_at,
                        "hit_at_k": hit_at,
                        "first_hit_rank": first_rank,
                        "reciprocal_rank": rr,
                    }
                else:
                    trace["provenance"] = {"available": False}

                strict_recall_at = {}
                strict_hit_at = {}
                for k in args.ks:
                    hit_ids: set[str] = set()
                    for matches in lane_strict_matches.values():
                        for hitset in matches[:k]:
                            hit_ids.update(hitset)
                    strict_recall_at[str(k)] = len(hit_ids) / len(gold.evidence_ids)
                    strict_hit_at[str(k)] = 1.0 if hit_ids else 0.0
                trace["strict_content"] = {
                    "rank_semantics": "per_lane_union" if len(lanes) > 1 else "global",
                    "recall_at_k": strict_recall_at,
                    "hit_at_k": strict_hit_at,
                }

            gold_sessions = evidence_session_ids(gold.evidence_ids)
            if gold_sessions and lanes:
                session_available = any(
                    item_session_number(item) is not None
                    for lane_items in lanes.values()
                    for item in lane_items
                )
                if session_available:
                    session_recall_at: dict[str, float] = {}
                    session_hit_at: dict[str, float] = {}
                    for k in args.ks:
                        recovered_sessions: set[int] = set()
                        for lane_items in lanes.values():
                            for item in lane_items[:k]:
                                session_no = item_session_number(item)
                                if session_no is not None:
                                    recovered_sessions.add(session_no)
                        session_hits = set(gold_sessions) & recovered_sessions
                        session_recall_at[str(k)] = len(session_hits) / len(gold_sessions)
                        session_hit_at[str(k)] = 1.0 if session_hits else 0.0
                    lane_session_first_ranks: list[int] = []
                    for lane_items in lanes.values():
                        for rank, item in enumerate(lane_items, start=1):
                            session_no = item_session_number(item)
                            if session_no in gold_sessions:
                                lane_session_first_ranks.append(rank)
                                break
                    session_first_rank = min(lane_session_first_ranks) if lane_session_first_ranks else None
                    trace["session_provenance"] = {
                        "available": True,
                        "scope": "session",
                        "rank_semantics": "per_lane_union" if len(lanes) > 1 else "global",
                        "gold_sessions": gold_sessions,
                        "recall_at_k": session_recall_at,
                        "hit_at_k": session_hit_at,
                        "first_hit_rank": session_first_rank,
                        "mrr": (1.0 / session_first_rank) if session_first_rank else 0.0,
                        "warning": "Session provenance is weaker than exact source-turn provenance.",
                    }

            status = str(record.get("status") or "success")
            per_query.append({
                "group_id": group_id,
                "question": gold.question,
                "category": gold.category,
                "category_name": gold.category_name,
                "status": status,
                "gold_evidence_ids": gold.evidence_ids,
                "resolved_gold_evidence_ids": [t.evidence_id for t in gold.evidence_turns],
                "unresolved_gold_refs": gold.unresolved_refs,
                "strict_evidence_hits": evidence_hits,
                "strict_evidence_recall": (sum(evidence_hits) / len(evidence_hits)) if evidence_hits else None,
                "strict_any_evidence": (any(evidence_hits) if evidence_hits else None),
                "strict_all_evidence": (all(evidence_hits) if evidence_hits else None),
                "gold_answer_string_present": answer_present,
                "context_chars": len(context),
                "context_tokens": token_counter.count(context),
                "duration_ms": float(record.get("duration_ms") or 0.0),
                "semantic_gold_scores": semantic,
                "semantic_gold_mean": (statistics.fmean(semantic) if semantic else None),
                "semantic_fragment_count": len(fragments),
                "structured_item_count": len(items),
                "trace_metrics": trace,
            })

    def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
        with_gold = [r for r in rows if r["strict_evidence_recall"] is not None]
        evidence_hit_count = sum(sum(bool(x) for x in r["strict_evidence_hits"]) for r in with_gold)
        evidence_total = sum(len(r["strict_evidence_hits"]) for r in with_gold)
        token_total = sum(r["context_tokens"] for r in rows)
        statuses = collections.Counter(r["status"] for r in rows)
        summary: dict[str, Any] = {
            "questions": len(rows),
            "questions_with_resolvable_gold": len(with_gold),
            "gold_evidence_turns": evidence_total,
            "strict_evidence_turn_recall_micro": (evidence_hit_count / evidence_total) if evidence_total else None,
            "strict_evidence_recall_macro": (statistics.fmean(r["strict_evidence_recall"] for r in with_gold) if with_gold else None),
            "strict_any_evidence_rate": (statistics.fmean(1.0 if r["strict_any_evidence"] else 0.0 for r in with_gold) if with_gold else None),
            "strict_all_evidence_rate": (statistics.fmean(1.0 if r["strict_all_evidence"] else 0.0 for r in with_gold) if with_gold else None),
            "gold_answer_string_presence_rate": (statistics.fmean(1.0 if r["gold_answer_string_present"] else 0.0 for r in rows) if rows else None),
            "context_tokens": stats([r["context_tokens"] for r in rows]),
            "context_chars": stats([r["context_chars"] for r in rows]),
            "search_latency_ms": stats([r["duration_ms"] for r in rows]),
            "status_counts": dict(statuses),
            "empty_context_rate": (statistics.fmean(1.0 if r["context_tokens"] == 0 else 0.0 for r in rows) if rows else None),
            "failed_or_missing_rate": (statistics.fmean(1.0 if r["status"] in {"failed", "missing"} else 0.0 for r in rows) if rows else None),
            "strict_evidence_turns_per_1k_context_tokens": ((evidence_hit_count * 1000.0) / token_total) if token_total else None,
        }
        semantic_rows = [r for r in with_gold if r["semantic_gold_mean"] is not None]
        if semantic_rows:
            all_evidence_scores = [s for r in semantic_rows for s in r["semantic_gold_scores"]]
            summary["semantic_gold_evidence_similarity"] = {
                "query_macro_mean": statistics.fmean(r["semantic_gold_mean"] for r in semantic_rows),
                "evidence_micro_mean": statistics.fmean(all_evidence_scores) if all_evidence_scores else None,
                "evidence_p50": percentile(all_evidence_scores, 0.50),
                "evidence_p95": percentile(all_evidence_scores, 0.95),
                "scored_queries": len(semantic_rows),
            }
        else:
            summary["semantic_gold_evidence_similarity"] = None

        provenance_rows = [r for r in rows if r["trace_metrics"].get("provenance", {}).get("available")]
        if provenance_rows:
            summary["provenance_trace"] = {
                "questions": len(provenance_rows),
                "mrr": statistics.fmean(r["trace_metrics"]["provenance"]["reciprocal_rank"] for r in provenance_rows),
                "recall_at_k": {
                    str(k): statistics.fmean(r["trace_metrics"]["provenance"]["recall_at_k"][str(k)] for r in provenance_rows)
                    for k in args.ks
                },
                "hit_at_k": {
                    str(k): statistics.fmean(r["trace_metrics"]["provenance"]["hit_at_k"][str(k)] for r in provenance_rows)
                    for k in args.ks
                },
            }
        else:
            summary["provenance_trace"] = None

        session_trace_rows = [r for r in rows if r["trace_metrics"].get("session_provenance")]
        if session_trace_rows:
            summary["session_provenance"] = {
                "questions": len(session_trace_rows),
                "scope": "session",
                "recall_at_k": {
                    str(k): statistics.fmean(r["trace_metrics"]["session_provenance"]["recall_at_k"][str(k)] for r in session_trace_rows)
                    for k in args.ks
                },
                "hit_at_k": {
                    str(k): statistics.fmean(r["trace_metrics"]["session_provenance"]["hit_at_k"][str(k)] for r in session_trace_rows)
                    for k in args.ks
                },
                "mrr": statistics.fmean(r["trace_metrics"]["session_provenance"]["mrr"] for r in session_trace_rows),
                "rank_semantics": session_trace_rows[0]["trace_metrics"]["session_provenance"].get("rank_semantics"),
                "warning": "Session provenance is supplementary and weaker than source-turn provenance.",
            }
        else:
            summary["session_provenance"] = None

        strict_trace_rows = [r for r in rows if r["trace_metrics"].get("strict_content")]
        if strict_trace_rows:
            summary["strict_content_trace"] = {
                "questions": len(strict_trace_rows),
                "recall_at_k": {
                    str(k): statistics.fmean(r["trace_metrics"]["strict_content"]["recall_at_k"][str(k)] for r in strict_trace_rows)
                    for k in args.ks
                },
                "hit_at_k": {
                    str(k): statistics.fmean(r["trace_metrics"]["strict_content"]["hit_at_k"][str(k)] for r in strict_trace_rows)
                    for k in args.ks
                },
                "rank_semantics": strict_trace_rows[0]["trace_metrics"]["strict_content"].get("rank_semantics"),
            }
        else:
            summary["strict_content_trace"] = None
        return summary

    categories: dict[str, Any] = {}
    for category in sorted({r["category"] for r in per_query}):
        rows = [r for r in per_query if r["category"] == category]
        categories[CATEGORY_NAMES.get(category, str(category))] = summarize(rows)

    return {
        "schema": EVALUATOR_VERSION,
        "backend": args.backend,
        "dataset": str(args.dataset),
        "search_results": str(args.search_results),
        "scope": {
            "primary": "memory_quality_only",
            "excluded_from_primary": ["answer_generation", "llm_as_judge", "answer_bleu_f1"],
            "category_5_adversarial_excluded": True,
            "category_mapping": {str(k): v for k, v in CATEGORY_NAMES.items()},
        },
        "evaluation": {
            "tokenizer": token_counter.name,
            "semantic_evaluator": ({
                "model": args.embedding_model,
                "base_url": args.embedding_base_url,
                "metric": "max cosine per gold evidence turn over retrieved item/context fragments",
                "thresholded_recall": False,
                "context_fragment_max_chars": 1200,
            } if embedder else None),
            "ks": list(args.ks),
        },
        "gold": gold_meta,
        "missing_search_records": missing_search,
        "aggregate": summarize(per_query),
        "categories": categories,
        "queries": per_query if args.include_queries else None,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--search-results", required=True)
    parser.add_argument("--backend", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--embedding-base-url", default="")
    parser.add_argument("--embedding-model", default="BAAI/bge-small-en-v1.5")
    parser.add_argument("--embedding-batch-size", type=int, default=64)
    parser.add_argument("--ks", default="1,5,10,20")
    parser.add_argument("--include-queries", action="store_true")
    args = parser.parse_args()
    args.ks = tuple(int(x) for x in args.ks.split(",") if x.strip())
    return args


def main() -> None:
    args = parse_args()
    result = evaluate(args)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "output": str(output),
        "backend": result["backend"],
        "questions": result["aggregate"]["questions"],
        "strict_evidence_turn_recall_micro": result["aggregate"]["strict_evidence_turn_recall_micro"],
        "semantic": result["aggregate"]["semantic_gold_evidence_similarity"],
        "provenance_trace": result["aggregate"]["provenance_trace"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
