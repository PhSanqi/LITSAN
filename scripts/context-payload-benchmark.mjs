#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compactContextMetadata } from "../dist/context-capsule.js";
import { evaluateRetrievalBenchmark, compareRetrievalBenchmarks } from "../dist/evaluation-harness.js";
const paths=process.argv.slice(2);
if(!paths.length) throw Error("Usage: node scripts/context-payload-benchmark.mjs <frozen-context.json> [...]");
const lanes=["globalMemory","globalState","projectMemory","reusableSkills","projectArchitecture"];
const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const rows=[], cases=[], baseline=[], candidate=[];
for(const path of paths){
 const raw=await readFile(path,"utf8"), envelope=JSON.parse(raw);
 assert.equal(envelope.ok,true,path);
 const original=envelope.result;
 assert.ok(original.turnKnowledgePlan && original.resolvedProjectId);
 const compact=structuredClone(original);
 compactContextMetadata(compact);
 assert.deepEqual(compact.turnKnowledgePlan,original.turnKnowledgePlan,"TKP must be byte-equivalent");
 for(const lane of lanes) for(let i=0;i<original[lane].length;i++){
  const a=original[lane][i], b=compact[lane][i];
  const {provenance:pa,...ia}=a, {provenance:pb,...ib}=b;
  assert.deepEqual(ib,ia,"Content, ordering, authority, scope and exact identities must survive");
  for(const [k,v] of Object.entries(pa??{})){
   if(["tags","tagsTruncated","originalTagCount","source_evidence_refs"].includes(k)) continue;
   assert.deepEqual(pb[k],v,"Unexpected provenance change: "+k);
  }
 }
 const refs=p=>lanes.flatMap(l=>p[l].map(i=>i.evidenceRef??i.id));
 assert.deepEqual(refs(compact),refs(original));
 const required=refs(original);
 cases.push({id:path,query:"frozen response preservation",required_evidence:required,critical_evidence:required});
 const observation=p=>({selected_evidence:refs(p),context_bytes:bytes(p),hydrate_count:p.turnKnowledgePlan.coverage.hydrated_full_revisions});
 baseline.push(observation(original)); candidate.push(observation(compact));
 rows.push({path,sha256:createHash("sha256").update(raw).digest("hex"),before_bytes:bytes(original),after_bytes:bytes(compact),saved_bytes:bytes(original)-bytes(compact),reduction_percent:Math.round(10000*(1-bytes(compact)/bytes(original)))/100,exact_selection_and_plan_preserved:true});
}
const b=evaluateRetrievalBenchmark(cases,baseline), c=evaluateRetrievalBenchmark(cases,candidate);
console.log(JSON.stringify({version:"context-payload-ablation-v1",scope:"Frozen output replay; baseline-relative selection preservation, NOT independently labelled retrieval/answer quality. No latency or model-token claim.",model_calls:0,rows,selection_preservation:{selected_identity_retention:c.recall,critical_identity_retention:c.critical_recall,mean_before_bytes:b.context_bytes,mean_after_bytes:c.context_bytes,mean_saved_bytes:-compareRetrievalBenchmarks(b,c).context_bytes,hydrate_count_delta:c.hydrate_count-b.hydrate_count,quality_ground_truth:"not labelled",latency_ms:null,model_tokens:null}},null,2));
