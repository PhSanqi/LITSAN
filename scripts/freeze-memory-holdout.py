"""Freeze 30 unused questions before answer generation; stratify within each dataset."""
import json,hashlib
from pathlib import Path
ROOT=Path('.review-runtime/progressive-v1-20261103');ROOT.mkdir(exist_ok=True)
B=Path('.review-runtime/benchmarks')
regression=json.loads(Path('.review-runtime/repair-luna56-intent-20261103/candidate.contexts.json').read_text())
used={r['id'] for r in regression}
sources={}
def load(p):
 raw=p.read_bytes();sources[str(p)]=hashlib.sha256(raw).hexdigest();return json.loads(raw)
def pick(rows,n):
 groups={}
 for r in rows:groups.setdefault(str(r['category']),[]).append(r)
 for g in groups.values():g.sort(key=lambda r:hashlib.sha256(('memhub-holdout-v1:'+r['id']).encode()).hexdigest())
 out=[]
 while len(out)<n:
  for key in sorted(groups):
   if groups[key] and len(out)<n:out.append(groups[key].pop(0))
  if not any(groups.values()) and len(out)<n:raise ValueError('Not enough holdout cases')
 return out
holdout=[];pool=[]
for s in load(B/'data/locomo10.json'):
 if s['sample_id'] in ['conv-26','conv-48']:continue
 for i,q in enumerate(s['qa']):
  if 'answer' not in q or q.get('category')==5:continue
  pool.append({'id':f"LoCoMo:{s['sample_id']}:{i}",'sample_id':'LoCoMo','category':q['category'],'question':q['question'],'gold':q['answer'],'context':''})
holdout+=pick([r for r in pool if r['id'] not in used],10);pool=[]
for q in load(B/'data/longmemeval_s_cleaned.json'):
 pool.append({'id':'LongMemEval:'+q['question_id'],'sample_id':'LongMemEval','category':q['question_type'],'question':('Question date: '+q['question_date']+'\n' if q.get('question_date') else '')+q['question'],'gold':q['answer'],'context':''})
holdout+=pick([r for r in pool if r['id'] not in used],10);pool=[]
persona='software_engineer'
evaluation=load(B/f'upstream/memora/data/weekly/{persona}/evaluation_questions_{persona}.json')
for category,questions in evaluation['questions'].items():
 for q in questions:
  pool.append({'id':f"Memora:{persona}:{q['question_id']}",'sample_id':'Memora','category':category,'question':('Question date: '+q['question_date']+'\n' if q.get('question_date') else '')+q['question'],'gold':json.dumps({'required_current':q['memory_evidence'],'forbidden_outdated':q.get('forgetting_evidence',{}),'evaluation':q['evaluation']}),'context':''})
holdout+=pick([r for r in pool if r['id'] not in used],10)
assert len(holdout)==30 and len({r['id'] for r in holdout})==30 and not used.intersection(r['id'] for r in holdout)
raw=json.dumps(holdout,indent=2)
target=ROOT/'holdout.questions.json'
if target.exists():assert target.read_text()==raw,'Frozen holdout cannot change'
target.write_text(raw)
(ROOT/'holdout-manifest.json').write_text(json.dumps({'seed':'memhub-holdout-v1','cases':30,'ids':[r['id'] for r in holdout],'source_sha256':sources,'question_sha256':hashlib.sha256(raw.encode()).hexdigest(),'selection':'10 per dataset, category-stratified; excluded regression IDs, LoCoMo conv-26/48; Memora uses software_engineer persona','limitations':'Not used in this 90-question tuning sequence; shared public datasets, not a globally unseen benchmark.'},indent=2))
print('Frozen 30 holdout questions')
