import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestRoot } from './test-isolation.mjs';
import { cardTools } from '../dist/shell/catalog/card.js';
import { submitDistillationControl } from '../dist/distillation-submit.js';
import { setDistillationConfig, getDistillationConfig, listDistillationJobs } from '../dist/distillation-jobs.js';

for (const kind of ['l3','l4']) test(`human review blocks ${kind} Core writes and returns a concrete proposal`, async t => {
 const stateRoot=await createTestRoot('promotion-review-'); t.after(()=>rm(stateRoot,{recursive:true,force:true}));
 await setDistillationConfig(stateRoot,{promotion_review_accounts:['review-account'],auto_enabled:true});
 await setDistillationConfig(stateRoot,{idle_minutes:35});
 assert.deepEqual((await getDistillationConfig(stateRoot)).promotion_review_accounts,['review-account']);
 let writes=0;
 const refs=kind==='l3'?['l2:timeline:rev']:['l3:project-a:rev-a','l3:project-b:rev-b'];
 const content='# Durable rules / 长期规则\n\nAtomic fact: EN: Validate exact evidence before changing durable facts. | Evidence: '+refs.join(', ')+'\nAtomic fact: ZH: 更新长期事实前核验证据。 | Evidence: '+refs.join(', ');
 const result=await submitDistillationControl({stateRoot,sourceHarness:'review-test',
  args:{kind,scope:kind==='l3'?'project':'account',...(kind==='l3'?{project:'alpha'}:{}),content,evidence_refs:refs,confidence:0.9},
  runtime:{accountId:'review-account',userId:'u',source:{platform:'test'},projects:{resolve:async(a,p)=>p},memory:{distill:async()=>{writes++;throw Error('must not write')}},memoryClient:{viewerGet:async()=>({items:[]})}},
  resolveToolScope:async()=>({projectId:kind==='l3'?'alpha':null,resolutionSource:'explicit'}),
  validateDistillationEvidenceChain:async()=>refs.map((ref,i)=>({ref,layer:kind==='l3'?'L2':'L3',kind:'artifact',project_id:kind==='l3'?'alpha':`p${i}`,content:'verified source'}))});
 assert.equal(result.status,'awaiting_user_review'); assert.equal(result.written,false); assert.equal(writes,0);
 assert.equal(result.review.proposed_content,content); assert.deepEqual(result.review.evidence_refs,refs);
 assert.equal(result.review.next_action.action,'plan'); assert.equal(result.review.next_action.tool,'litsan_memory');
 assert.equal((await listDistillationJobs(stateRoot,'review-account')).length,0);
});

test('card timing records rejected and thrown calls without tokens or answers', async t=>{
 const stateRoot=await createTestRoot('card-timing-');t.after(()=>rm(stateRoot,{recursive:true,force:true}));
 const tool=cardTools({runtime:{accountId:'acct',source:{platform:'test'}},context:{stateRoot}})[0];
 const secret='never-log-this-token';
 const result=await tool.run({action:'inline_load',inline_turn_event:'',lease_token:secret,answer:{content:'never-log-answer'}});
 assert.equal(result.value.code,'turn_unavailable');
 await assert.rejects(tool.run({action:'unknown',lease_token:secret}),/unsupported/);
 const body=await readFile(join(stateRoot,'maintenance/timing/card-log.jsonl'),'utf8');
 assert.ok(!body.includes(secret));assert.ok(!body.includes('never-log-answer'));
 const rows=body.trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(r=>r.outcome),['rejected','error']);
 for(const r of rows){assert.equal(r.account,'acct');assert.ok(r.duration_ms>=0);}
});
