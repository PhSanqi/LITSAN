"""Keep raw results; summarize context-controlled pairs and uncertainty bounds."""
import ast,collections,hashlib,json,sys
from pathlib import Path
ROOT=Path(sys.argv[1] if len(sys.argv)>1 else '.review-runtime/progressive-v2-20261103').resolve()
raw=json.loads((ROOT/'results.json').read_text())
if all('input_changed' in r for r in raw['rows']):
    manifest=json.loads((ROOT/'manifest.json').read_text())
    assert {r['id'] for r in raw['rows'] if r['input_changed']}==set(manifest['affected_ids'])
    unchanged={r['id'] for r in raw['rows'] if not r['input_changed']}
else:
    plan=json.loads((ROOT/'controlled-analysis-plan.json').read_text())
    assert plan['declared_before_new_grading']
    unchanged=set(plan['unchanged_ids'])
rows=[]
for original in raw['rows']:
    r=json.loads(json.dumps(original))
    r['context_changed']=r['id'] not in unchanged
    if not r['context_changed']:
        r['candidate_answer']=r['before_answer']
        r['grades']['candidate']=r['grades']['before']
        assert r['candidate_answer']==r['before_answer'] and r['grades']['candidate']==r['grades']['before']
    rows.append(r)
summary={}
for group in ['regression','holdout']:
    summary[group]={}
    for dataset in ['all','LoCoMo','LongMemEval','Memora']:
        selected=[r for r in rows if r['group']==group and (dataset=='all' or r['sample_id']==dataset)]
        record={'cases':len(selected),'context_changed':sum(r['context_changed'] for r in selected)}
        for lane in ['before','candidate']:
            counts=collections.Counter(r['grades'][lane]['correct'] for r in selected)
            record[lane]={'correct':counts[True],'incorrect':counts[False],'uncertain':counts[None],'accuracy_range':[counts[True]/len(selected),(counts[True]+counts[None])/len(selected)]}
            assert sum(record[lane][k] for k in ['correct','incorrect','uncertain'])==len(selected)
        record['improved']=[r['id'] for r in selected if r['grades']['before']['correct'] is False and r['grades']['candidate']['correct'] is True]
        record['regressed']=[r['id'] for r in selected if r['grades']['before']['correct'] is True and r['grades']['candidate']['correct'] is False]
        summary[group][dataset]=record
source_path=Path('.review-runtime/benchmarks/upstream/memora/evals/model_eval/model_based_evaluator.py')
source=source_path.read_text();tree=ast.parse(source)
function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='fama_score')
exec(compile(ast.Module(body=[function],type_ignores=[]),'<official-fama>','exec'))
assert fama_score(1,1,1,1)==1 and fama_score(1,1,0,1)==.5 and fama_score(0,1,1,1)==0
fama={}
for group in ['regression','holdout']:
    fama[group]={}
    for lane in ['before','candidate']:
        bounds=[]
        for r in rows:
            if r['group']!=group or r['sample_id']!='Memora':continue
            rubric=json.loads(r['gold'])['evaluation']['evaluation_questions'];labels=r['grades'][lane]['criteria']
            scores=[]
            for unknown_passes in [False,True]:
                counts=[]
                for kind in ['memory_presence','forgetting_absence']:
                    cs=[c for c in rubric if c['evaluation_type']==kind]
                    counts += [sum(labels.get(c['evaluation_question_id'],'uncertain')=='pass' or (unknown_passes and labels.get(c['evaluation_question_id'],'uncertain')=='uncertain') for c in cs),len(cs)]
                scores.append(fama_score(*counts))
            assert scores[0]<=scores[1];bounds.append(scores)
        fama[group][lane]=[100*sum(b[i] for b in bounds)/len(bounds) for i in [0,1]]
usage_sources=list(dict.fromkeys([Path('.review-runtime/progressive-v1-20261103').resolve(),Path('.review-runtime/progressive-v2-20261103').resolve(),ROOT]))
usage=[json.loads(line) for source in usage_sources for line in (source/'usage.jsonl').read_text().splitlines()]
assert all(r['model']=='gpt-5.6-luna' and r['effort']=='low' and not r['tool_items'] for r in usage)
trace=json.loads((ROOT/'progressive-trace.json' if (ROOT/'progressive-trace.json').exists() else ROOT.parent/'progressive-v2-20261103/progressive-trace.json').read_text())
stats={'calls':len(usage),'nonzero_exit':sum(r['exit']!=0 for r in usage),'input_tokens':sum(r['usage'].get('input_tokens',0) for r in usage),'cached_input_tokens':sum(r['usage'].get('cached_input_tokens',0) for r in usage),'output_tokens':sum(r['usage'].get('output_tokens',0) for r in usage),'rounds':{str(n):dict(collections.Counter(r['demand']['decision'] for r in trace if r['round']==n and 'demand' in r)) for n in range(3)},'rejected_requests':[r for r in trace if 'error' in r]}
report={'protocol':'context-controlled-v1','summary':summary,'raw_summary':raw['summary'],'fama_bounds':fama,'fama_source_sha256':hashlib.sha256(source.encode()).hexdigest(),'usage':stats,'judge_errors':raw['errors'],'rows':rows}
(ROOT/'controlled-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
flags=json.loads((ROOT/'review-flags.json').read_text()) if (ROOT/'review-flags.json').exists() else []
blocked={(r['id'],r['lane']) for r in flags}
labels=[{'id':r['id'],'lane':lane,'label':r['grades'][lane]['correct'] if (r['id'],lane) not in blocked else None,'eligible':r['grades'][lane]['correct'] is not None and (r['id'],lane) not in blocked} for r in rows for lane in ['before','candidate']]
assert all(isinstance(r['label'],bool) and (r['id'],r['lane']) not in blocked for r in labels if r['eligible'])
(ROOT/'optimization-labels.json').write_text(json.dumps({'review_flags':flags,'labels':labels},indent=2))
print(json.dumps({k:report[k] for k in ['summary','fama_bounds','usage']},ensure_ascii=False,indent=2))
