import assert from "node:assert/strict";
import { selectLitsanCoreHits } from "../dist/litsan-core.js";
import { rankRecallHits, tokenizeRetrievalText } from "../dist/retrieval-ranker.js";

const hit = (id, score, snippet, title = "") => ({
  id,
  kind: "project_profile",
  memoryLayer: "L3",
  status: "active",
  title,
  snippet,
  score,
  tags: ["project:memhub"],
  source: "search"
});

{
  const ranked = rankRecallHits([
    hit("semantic", 1.8, "general memory architecture notes"),
    hit("lexical", 0.55, "BM25 keyword retrieval diagnostics and small top-k ranking")
  ], "BM25 keyword retrieval", 2);
  assert.equal(ranked.hits[0].hit.id, "lexical", "strong lexical fit should be able to beat broad semantic similarity");
  assert.ok(ranked.hits[0].lexicalScore > ranked.hits[1].lexicalScore);
  assert.equal(ranked.diagnostics.version, "retrieval-v1");
}

{
  const selected = selectLitsanCoreHits([
    hit("core-first", 1.8, "broad semantic memory"),
    hit("lexical-first", 0.55, "BM25 keyword retrieval diagnostics")
  ], "BM25 keyword retrieval", 2);
  assert.deepEqual(selected.hits.map((item) => item.hit.id), ["core-first", "lexical-first"]);
  assert.equal(selected.diagnostics.rankingMode, "memhub_core");
  assert.equal(selected.diagnostics.lexicalWeight, 0);
  assert.equal(selected.diagnostics.diversityPenalty, 0);
}

{
  const selected = selectLitsanCoreHits([
    hit("core-first", 0.92, "统一核心已经完成候选融合和多样性排序"),
    hit("core-second", 0.71, "第二候选")
  ], "统一核心候选融合", 1);
  assert.deepEqual(selected.hits.map((item) => item.hit.id), ["core-first"]);
  assert.equal(selected.diagnostics.rankingMode, "memhub_core");
  assert.equal(selected.diagnostics.semanticWeight, 0);
  assert.equal(selected.diagnostics.lexicalWeight, 0, "memhub_core must not apply a second BM25 fusion stage");
}

{
  const ranked = rankRecallHits([
    hit("a", 0.9, "same normalized content", "Duplicate"),
    hit("b", 0.8, "same   normalized content", "Duplicate"),
    hit("c", 0.7, "different evidence")
  ], "content evidence", 10);
  assert.equal(ranked.diagnostics.candidateCount, 3);
  assert.equal(ranked.diagnostics.dedupedCount, 2);
  assert.equal(ranked.hits.length, 2);
  assert.ok(ranked.diagnostics.decisions.some((decision) =>
    decision.id === "b" && decision.result === "dropped" && decision.reason === "duplicate_content"
  ));
}

{
  const terms = tokenizeRetrievalText("记忆检索系统 BM25 rerank");
  assert.ok(terms.includes("记忆"));
  assert.ok(terms.includes("检索"));
  assert.ok(terms.includes("bm25"));
  const ranked = rankRecallHits([
    hit("cn-hit", 0.5, "这里实现记忆检索系统与关键词排序"),
    hit("cn-miss", 0.7, "这里讨论网页设计和部署")
  ], "记忆检索", 2);
  assert.equal(ranked.hits[0].hit.id, "cn-hit");
}

{
  const ranked = rankRecallHits([
    hit("one", 0.9, "retrieval pipeline semantic keyword ranking diagnostics"),
    hit("two", 0.89, "retrieval pipeline semantic keyword ranking diagnostics extra"),
    hit("three", 0.82, "project current truth evidence governance")
  ], "retrieval pipeline project current truth", 3);
  assert.ok(ranked.hits.some((item) => item.diversityPenaltyApplied > 0));
  assert.deepEqual(ranked.hits.map((item) => item.rank), [1, 2, 3]);
}

{
  const ranked = rankRecallHits([
    hit("one", 0.9, "retrieval trace top k alpha"),
    hit("two", 0.8, "retrieval trace top k beta"),
    hit("three", 0.7, "retrieval trace top k gamma")
  ], "retrieval trace top k", 2);
  assert.equal(ranked.hits.length, 2);
  const dropped = ranked.diagnostics.decisions.find((decision) => decision.id === "three");
  assert.equal(dropped?.result, "dropped");
  assert.equal(dropped?.reason, "top_k");
  assert.equal(ranked.diagnostics.cutoff?.lastKeptRank, 2);
  assert.equal(ranked.diagnostics.cutoff?.firstDroppedRank, 3);
  assert.equal(typeof ranked.diagnostics.cutoff?.adjustedScoreGap, "number");
}

console.log("memhub-retrieval-ranker-e2e: ok");
