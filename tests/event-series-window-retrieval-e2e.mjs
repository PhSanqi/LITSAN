import assert from "node:assert/strict";
import {readFile,rm} from "node:fs/promises";
import {createTestRoot,isolateTestEnvironment} from "./test-isolation.mjs";
import {extractDistilledFactMetadata} from "../dist/fact-metadata.js";
import {recordCompletedDistillationRevision} from "../dist/distillation-jobs.js";
import {retrieveDerivedRevisionEvidence} from "../dist/derived-fact-retrieval.js";
import { env } from "../dist/brand.mjs";
const {buildEventSeriesSidecar,expandEventSeries}=await import(env("TEMPORAL_TEST_MODULE") || "../dist/event-series.js");
const suite=JSON.parse(await readFile(new URL("../benchmarks/retrieval/temporal-retrieval-suite.json",import.meta.url),"utf8"));
const content="# Timeline\n"+suite.events.map(e=>"## "+e.id+"\nCanonical time: "+e.date+"\n- Atomic fact: "+e.text+" | Evidence: l1:"+e.id).join("\n");
const metadata=extractDistilledFactMetadata("l2",content);
const sidecar=buildEventSeriesSidecar({revisionId:"test",memoryId:"test",layer:"L2",factMetadata:metadata});
const rows=[];
for(const c of suite.cases){
 const result=expandEventSeries({query:c.query,sidecars:[sidecar],seeds:sidecar.members.map(m=>({fact_id:m.fact_id,score:0.99})),maxHits:8});
 const ids=[...new Set(result.hits.flatMap(h=>h.member.evidence_refs.map(r=>r.slice(3))))].sort();
 rows.push({id:c.id,expected:c.expected.slice().sort(),actual:ids,pass:JSON.stringify(ids)===JSON.stringify(c.expected.slice().sort())});
}
console.log(JSON.stringify({cases:rows.length,passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass)},null,2));
if(process.argv.includes("--report-only"))process.exit(0);
assert.equal(rows.filter(r=>!r.pass).length,0);
const root=await createTestRoot("temporal-merge-");
isolateTestEnvironment(root, root+"/architecture");
try{
 const job=await recordCompletedDistillationRevision({stateRoot:root,accountId:"acct",target:"l2",projectId:"pilot",resultId:"pilot-l2",content,committedAt:"2026-11-02T00:00:00Z",factMetadata:metadata,evidence:suite.events.map(e=>({ref:"l1:"+e.id,kind:"turn",layer:"L1",project_id:"pilot",timestamp:e.date+"T12:00:00Z",user_text:e.text}))});
 const revision={evidence_ref:"l2:pilot-l2:"+job.job_id,layer:"L2",memory_id:"pilot-l2",revision_id:job.job_id,project_id:"pilot",title:"Timeline",content,committed_at:job.result_committed_at,source_evidence_refs:job.evidence_refs,fact_metadata:metadata,estimated_tokens:300};
 for(const c of suite.cases.slice(0,12)){
  const result=await retrieveDerivedRevisionEvidence({stateRoot:root,accountId:"acct",query:c.query,revisions:[revision],mode:"lexical",maxFacts:12,expandEventSeries:true,maxSeriesFacts:8});
  const ids=[...new Set(result.facts.flatMap(f=>f.evidence_refs.filter(r=>r.startsWith("l1:")).map(r=>r.slice(3))))].sort();
  assert.deepEqual(ids,c.expected.slice().sort(),c.id+" derived merge");
 }
 console.log("derived merge: 12 bounded-window queries passed; no out-of-window seed reintroduction");
}finally{await rm(root,{recursive:true,force:true});}
