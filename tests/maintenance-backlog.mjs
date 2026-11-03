import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceBacklog } from '../dist/core/maintenance/backlog.js';
import { validateL2ChunkAnswer } from '../dist/core/maintenance/answers.js';
import { mergeChunkEvents } from '../dist/core/maintenance/merge-l2.js';
const now = Date.parse('2026-11-03T08:00:00Z'), recent = new Date(now - 3600000).toISOString();
test('backlog separates leases, merge waits, retired sets, unmaterialized/coalesced jobs and actual commits', () => {
 const card = (id, status='pending', extra={}) => ({card_id:id,kind:'l2_chunk',project_id:'alpha',status,created_at:recent,...extra});
 const cards=[card('pending'),card('leased','leased',{lease:{until:new Date(now+60000).toISOString()}}),card('expired','leased',{lease:{until:recent}}),card('accepted','accepted'),card('stale'),card('aborted'),card('merged','accepted'),card('superseded','superseded')];
 const sets=[{status:'open',parent_job_id:'a',parent_job_ids:['a','b'],card_ids:['pending','leased','expired','accepted']}, {status:'open',parent_job_id:'done',card_ids:['stale']},{status:'aborted',parent_job_id:'empty',card_ids:['aborted']},{status:'merged',parent_job_id:'done',card_ids:['merged']}];
 const jobs=['a','b','empty'].map(job_id=>({job_id,target:'l2',project_id:'alpha',status:'pending'}));
 jobs.push({job_id:'done',target:'l2',status:'completed',result_kind:'l2',completed_at:recent},{job_id:'noop',target:'l2',status:'completed',result_kind:'noop',completed_at:recent},{job_id:'promotion',target:'l3',status:'pending'});
 const logs=[{kind:'l2_chunk',outcome:'accepted',ts:recent,harness:'memhub-in-turn:one'}, {kind:'l2_chunk',outcome:'accepted',ts:recent,harness:'remote-mcp'}, {kind:'arch_link',outcome:'accepted',ts:recent,harness:'remote-mcp'}, {kind:'l2_chunk',outcome:'accepted',ts:'2026-10-01T00:00:00Z',harness:'remote-mcp'}];
 const original=JSON.stringify({cards,sets,jobs,logs}), b=maintenanceBacklog(cards,sets,jobs,logs,now).summary;
 assert.equal(b.pending_cards,2);assert.equal(b.leased_cards,1);assert.equal(b.accepted_waiting_merge,1);assert.equal(b.stale_cards,2);assert.equal(b.parent_jobs,3);assert.equal(b.unmaterialized_jobs,1);assert.equal(b.oldest_pending_age_h,1);assert.equal(b.promotion_jobs,1);
 assert.deepEqual(b.throughput_24h,{created_cards:8,created_then_superseded:1,accepted_cards:2,in_turn_accepted:1,other_accepted:1,committed_l2_revisions:1});
 assert.equal(JSON.stringify({cards,sets,jobs,logs}),original);
});
const event={date:'2026-11-03',title_en:'Rename',title_zh:'更名',body_en:'Atomic fact: MEMHUB_PUBLIC_HOST controls OAuth; clients must re-authenticate. | Evidence: l1:rename',body_zh:'MEMHUB_PUBLIC_HOST 控制 OAuth；客户端必须重新认证。',evidence_refs:['l1:rename']};
test('a same-title operational prerequisite and its citation survive merge and exact replay',()=>{
 const base='# Timeline\n\n## 2026-11-03: Rename / 更名\n\nThe visible label changed.\n\n显示名已更改。\n\nEvidence: l1:label';
 const wrap=e=>({event:e,chunkIndex:0,eventIndex:0,cardId:'card'});
 const once=mergeChunkEvents({baseContent:base,canonicalTitle:'Timeline',events:[wrap(event)]});
 assert.match(once.content,/clients must re-authenticate/);assert.match(once.content,/Evidence: l1:rename/);assert.equal(once.dropped_duplicates,0);assert.equal((once.content.match(/^## /gm)||[]).length,1);
 const replay=mergeChunkEvents({baseContent:once.content,canonicalTitle:'Timeline',events:[wrap(event)]});
 assert.equal(replay.content,once.content);assert.equal(replay.dropped_duplicates,1);
 const extra={...event,body_en:'Atomic fact: Assistant suggested a four-day schedule. | Evidence: l1:suggestion',body_zh:'助手建议四天发布节奏。',evidence_refs:['l1:suggestion']};
 const batch=mergeChunkEvents({baseContent:null,canonicalTitle:'Timeline',events:[wrap(event),{...wrap(extra),chunkIndex:1}]});
 assert.match(batch.content,/re-authenticate/);assert.match(batch.content,/Assistant suggested/);assert.match(batch.content,/l1:suggestion/);
});
test('multi-source cards require claim-level citations and reject external or uncited claims',()=>{
 const card={allowed_refs:['l1:rename','l1:suggestion'],input:{items:[]}};
 const validate=e=>validateL2ChunkAnswer(card,{events:[e]});
 const multi={...event,evidence_refs:card.allowed_refs,body_en:event.body_en+'\nAtomic fact: The assistant suggested a schedule. | Evidence: l1:suggestion'};
 assert.equal(validate(multi).ok,true);
 assert.equal(validate({...multi,body_en:'Clients must re-authenticate. A schedule was suggested.'}).code,'schema_invalid');
 assert.equal(validate({...multi,body_en:event.body_en+'\nAtomic fact: The user declined a specific fix.'}).code,'schema_invalid');
 assert.equal(validate({...multi,body_en:multi.body_en.replace('l1:suggestion','l1:other-thread')}).code,'ref_not_allowed');
 assert.equal(validate(event).ok,true);
});

test('dedup preserves case-sensitive values and distinct citation IDs',()=>{
 const first={...event,body_en:'Atomic fact: Mode is AUTH. | Evidence: l1:rename',body_zh:'模式为 AUTH。'};
 const changed={...first,body_en:first.body_en.replace('AUTH','auth'),body_zh:'模式改为 auth。'};
 const wrap=(event,i)=>({event,chunkIndex:i,eventIndex:0,cardId:String(i)});
 const result=mergeChunkEvents({baseContent:null,canonicalTitle:'Timeline',events:[wrap(first,0),wrap(changed,1)]});
 assert.equal(result.dropped_duplicates,0);assert.match(result.content,/Mode is AUTH/);assert.match(result.content,/Mode is auth/);
});
