// Diagnostic only: score all turns before lexical truncation; gold is used only after ranking.
import fs from 'node:fs/promises';
import {createEmbedder} from '../vendor/memory-core/src/model/embedder.js';
import {rankRecallHits} from '../dist/retrieval-ranker.js';
const root='.review-runtime/repair-luna56-contract-20261103';
const samples=JSON.parse(await fs.readFile('.review-runtime/benchmarks/data/locomo10.json','utf8'));
const old=JSON.parse(await fs.readFile('.review-runtime/repair-luna56-final-20261103/candidate.contexts.json','utf8'));
const embedder=createEmbedder({provider:'local',model:'Xenova/all-MiniLM-L6-v2',normalize:true,cache:true});
const results=[];
for(const sample of samples){
 const rows=old.filter(r=>r.id.startsWith('LoCoMo:'+sample.sample_id+':'));
 if(!rows.length)continue;
 const turns=Object.entries(sample.conversation).filter(([k,v])=>/^session_\d+$/.test(k)&&Array.isArray(v)).flatMap(([key,ts])=>ts.map(t=>({...t,session:key,text:t.speaker+': '+t.text})));
 const vectors=await embedder.embed(turns.map(t=>t.text),'document');
 for(const row of rows){
  const q=await embedder.embedOne(row.question,'query');
  const hits=turns.map((t,i)=>({id:t.dia_id,kind:'evidence',memoryLayer:'L1',status:'active',snippet:t.text,score:q.reduce((s,v,j)=>s+v*vectors[i][j],0),tags:[],source:'benchmark'}));
  const ranked=rankRecallHits(hits,row.question,20).hits.map(r=>r.hit.id);
  const gold=sample.qa[Number(row.id.split(':').at(-1))].evidence||[];
  assertQuestion(sample.qa[Number(row.id.split(':').at(-1))].question,row.question);
  results.push({id:row.id,question:row.question,required:gold,semantic_top20:ranked,semantic_recalled:gold.filter(id=>ranked.includes(id)),existing_exact_turn_recalled:gold.filter(id=>{const t=turns.find(t=>t.dia_id===id);return t&&row.context.includes(t.text);})});
 }
}
function assertQuestion(a,b){if(a!==b)throw new Error('Question mapping mismatch');}
await fs.writeFile(root+'/semantic-passage-probe.json',JSON.stringify({scope:'30 LoCoMo diagnostic cases; top20 turns versus exact-turn inclusion in 16KB context, unequal coverage measures; not answer accuracy or a fair retrieval benchmark',rows:results},null,2));
console.log(JSON.stringify(results.find(r=>r.id==='LoCoMo:conv-26:7')));
