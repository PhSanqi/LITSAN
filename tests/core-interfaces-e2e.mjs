import assert from "node:assert/strict";
import { RetrievalV1FusionRanker } from "../dist/core-interfaces.js";

const ranker = new RetrievalV1FusionRanker();
const hits = [
  { id: "semantic", kind: "profile", memoryLayer: "L3", status: "activated", snippet: "general architecture", score: 1.5, tags: [], source: "search" },
  { id: "lexical", kind: "profile", memoryLayer: "L3", status: "activated", snippet: "retrieval scope envelope exact contract", score: 0.4, tags: [], source: "search" }
];
const result = ranker.rank("retrieval scope envelope", hits, 2);
assert.equal(result.hits.length, 2);
assert.ok(result.diagnostics.decisions.length >= 2);
assert.equal(result.diagnostics.version, "retrieval-v1");
console.log("memhub-core-interfaces-e2e: ok");
