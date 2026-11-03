import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {materializeCurrentState, conditionalStateCandidates} from './memora-state.mjs';
import {selectPassages} from '../dist/turn-knowledge-plan.js';
import {tokenizeRetrievalText, rankRecallHits} from '../dist/retrieval-ranker.js';
import {createEmbedder} from '../vendor/memory-core/src/model/embedder.js';
const ROOT=path.resolve(process.argv[2] || '.review-runtime/repair-luna56-final-20261103');
const OLD=path.resolve('.review-runtime/three-dataset-answer-ab-20261103');
const B=path.resolve('.review-runtime/benchmarks');
const hashes={};
async function load(p){const text=await fs.readFile(p,'utf8');hashes[p]=crypto.createHash('sha256').update(text).digest('hex');return JSON.parse(text);}
const before=await load(process.argv[3] || path.join(OLD,'candidate.contexts.json'));
const selection=(await load(path.join(OLD,'manifest.json'))).selection_rows;
const locomo=await load(path.join(B,'data/locomo10.json'));
const long=await load(path.join(B,'data/longmemeval_s_cleaned.json'));
const embedder=createEmbedder({provider:'local',model:'Xenova/all-MiniLM-L6-v2',normalize:true,cache:true});
const CAP=16000;
const after=[], diagnostics=[];
await fs.mkdir(ROOT,{recursive:true});
await fs.mkdir(path.join(ROOT,'work'),{recursive:true});
for(const row of before){
 let docs=[];
 if(row.sample_id==='LoCoMo'){
  const selected=selection.find(s=>s.id===row.id) ?? {original_sample:row.id.split(':')[1]};
  const sample=locomo.find(s=>s.sample_id===selected.original_sample);
  docs=Object.entries(sample.conversation).filter(([k,v])=>/^session_\d+$/.test(k)&&Array.isArray(v)).map(([k,v])=>({id:sample.sample_id+':'+k,date:sample.conversation[k+'_date_time'],text:v.map(t=>(t.speaker||'speaker')+': '+(t.text||'')).join('\n')}));
 }else if(row.sample_id==='LongMemEval'){
  const q=long.find(q=>'LongMemEval:'+q.question_id===row.id);
  docs=q.haystack_sessions.map((messages,i)=>({id:q.haystack_session_ids[i],date:q.haystack_dates?.[i],text:messages.map(m=>(m.role||'speaker')+': '+(typeof m.content==='string'?m.content:JSON.stringify(m.content))).join('\n')}));
 }else{
  const [,persona,qid]=row.id.split(':');
  const root=path.join(B,'upstream/memora/data/weekly',persona);
  const evaluation=await load(path.join(root,'evaluation_questions_'+persona+'.json'));
  const q=Object.values(evaluation.questions).flat().find(q=>q.question_id===qid);
  const sessions=[];
  for(const name of (await fs.readdir(path.join(root,'conversations'))).filter(n=>/^session_\d+\.json$/.test(n))) sessions.push(await load(path.join(root,'conversations',name)));
  const state=conditionalStateCandidates(materializeCurrentState(sessions,q.question_date),q.question,q.question_date);
  docs=state.map(s=>({id:s.key,date:s.date,structured:true,text:s.text+(s.eventDate?'\nevent_date: '+s.eventDate:'')}));
 }
 // Explicit source expansion is restricted to this case's already scoped source set.
 if(row.expand_refs){
  if(!Array.isArray(row.expand_refs)||row.expand_refs.length>3||new Set(row.expand_refs).size!==row.expand_refs.length||row.expand_refs.some(ref=>!docs.some(d=>d.id===ref)))throw new Error('Invalid source expansion');
  const expanded= row.expand_refs.map(ref=>docs.find(d=>d.id===ref));
  const chunks=expanded.map(d=>{
   const result=[];let chunk='';
   for(const line of d.text.split('\n')){
    if(Buffer.byteLength(chunk+'\n'+line)>1800&&chunk){result.push(chunk);chunk='';}
    chunk+=(chunk?'\n':'')+line;
   }
   if(chunk)result.push(chunk);return result;
  });
  let context='';let admitted=0;
  for(let i=0;i<Math.max(0,...chunks.map(c=>c.length));i++)for(let j=0;j<expanded.length;j++){
   if(!chunks[j][i])continue;
   const d=expanded[j],unit='['+d.id+'] recorded: '+(d.date||'unknown')+'\n'+chunks[j][i]+'\n\n';
   if(Buffer.byteLength(context+unit)<=CAP){context+=unit;admitted++;}
  }
  after.push({...row,context});diagnostics.push({id:row.id,expanded_refs:row.expand_refs,source_chunks:chunks.reduce((n,c)=>n+c.length,0),admitted_chunks:admitted,context_bytes:Buffer.byteLength(context)});
  continue;
 }
 const terms=tokenizeRetrievalText(row.question);
 const prepared=docs.map(d=>{
  if(Buffer.byteLength(d.text)<=(d.structured?CAP:2500))return {...d,blocks:[d.text],snippet:d.text};
  const lines=d.text.split('\n').filter(Boolean);
  const passages=selectPassages(lines.join('\n\n'),terms,[],'retrieval',d.text,6,1000,'matched');
  const blocks=[];
  const userPassages=passages.filter(p=>/^(?:user|user_agent|用户)\s*[:：]/iu.test(p.text));
  const userBundle=userPassages.map(p=>p.text).join('\n');
  const bundled=userPassages.length>1 && Buffer.byteLength(userBundle)<=3000;
  if(bundled)blocks.push(userBundle);
  for(const p of passages){
   if(bundled && userPassages.includes(p))continue;
   const i=lines.findIndex(line=>line===p.text);
   const block=i>=0?[i>0?lines[i-1].slice(-500):'',p.text,i+1<lines.length?lines[i+1].slice(0,500):''].filter(Boolean).join('\n'):p.text;
   if(!blocks.includes(block))blocks.push(block);
  }
  return {...d,blocks,snippet:blocks.join('\n')};
 });
 const vectors=prepared.length?await embedder.embed(prepared.map(d=>d.snippet),'document'):[];
 const qv=await embedder.embedOne(row.question,'query');
 const hits=prepared.map((d,i)=>({id:d.id,kind:'repair-evidence',memoryLayer:'L2',status:'active',snippet:d.snippet,score:qv.reduce((sum,v,j)=>sum+v*(vectors[i][j]||0),0),tags:[],source:'benchmark'}));
 const ranked=rankRecallHits(hits,row.question,Math.min(20,hits.length)).hits.map(r=>prepared.find(d=>d.id===r.hit.id));
 let context='';const used=new Set();
 const admissions=[...ranked.slice(0,4).flatMap(d=>[0,1].map(round=>({d,round}))),...Array.from({length:6},(_,round)=>ranked.map(d=>({d,round}))).flat()];
 for(const {d,round} of admissions){
  const block=d.blocks[round];if(!block)continue;
  const key=d.id+':'+block;if(used.has(key))continue;used.add(key);
  const unit='['+d.id+'] recorded: '+(d.date||'unknown')+'\n'+block+'\n\n';
  if(Buffer.byteLength(context+unit)<=CAP)context+=unit;
 }
 after.push({...row,context});
 diagnostics.push({id:row.id,candidates:docs.length,ranked_ids:ranked.map(d=>d.id),context_bytes:Buffer.byteLength(context)});
 console.log(row.id+' '+Buffer.byteLength(context));
}
await fs.writeFile(path.join(ROOT,'before.contexts.json'),JSON.stringify(before,null,2));
await fs.writeFile(path.join(ROOT,'candidate.contexts.json'),JSON.stringify(after,null,2));
await fs.writeFile(path.join(ROOT,'manifest.json'),JSON.stringify({protocol:'fresh-query-passages-repair-v1',cases:before.length,cap_bytes:CAP,model:'gpt-5.6-luna',before:'Previous optimized contexts, fresh model answers',candidate:'Fresh query-focused hybrid ranking, bounded neighboring turns, shared product passage selector, corrected state identities and as-of dates',limitations:'Not full production MCP; event-series repair tested separately; original 90-question selection; no gold used in candidate retrieval',diagnostics,source_sha256:hashes},null,2));
