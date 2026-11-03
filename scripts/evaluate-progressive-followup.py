"""Consume the structured demand in answers; reuse unchanged inputs and preserve prior trials."""
import json,hashlib,concurrent.futures,sys
from pathlib import Path
from memory_judge import judge_pairs,fingerprint
from memory_eval_calls import cached_call
from progressive_evidence import preference_refs,blocks,merge_evidence,CAP
UNBIASED='--unbiased' in sys.argv
SAFE='--current-baseline' in sys.argv
DYNAMIC='--dynamic' in sys.argv or UNBIASED or SAFE
BASE=Path('.review-runtime/progressive-v4-20261103' if UNBIASED else '.review-runtime/progressive-v3-20261103' if DYNAMIC else '.review-runtime/progressive-v2-20261103').resolve()
ROOT=Path('.review-runtime/progressive-v6-20261103' if SAFE else '.review-runtime/progressive-v5-20261103' if UNBIASED else '.review-runtime/progressive-v4-20261103' if DYNAMIC else '.review-runtime/progressive-v3-20261103').resolve()
PREP=ROOT if DYNAMIC and not UNBIASED else BASE
ROOT.mkdir(exist_ok=True);(ROOT/'work').mkdir(exist_ok=True)
def save(name,value):(ROOT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2))
contexts=json.loads((PREP/'candidate.contexts.json').read_text())
trace=json.loads((PREP/'progressive-trace.json').read_text())
demands={r['id']:r['demand'] for r in trace if 'demand' in r}
unchanged=set() if DYNAMIC else set(json.loads((BASE/'controlled-analysis-plan.json').read_text())['unchanged_ids'])
affected={r['id'] for r in contexts if r['id'] not in unchanged or demands[r['id']]['preference_refs'] or demands[r['id']]['decision']=='abstain'}
if UNBIASED:
    affected={key for key,d in demands.items() if d['decision']=='abstain' or d['missing_information']}
    delivered={r['id']:r for r in json.loads((BASE/'delivered-inputs.json').read_text())}
    contexts=[{**r,'context':delivered[r['id']]['context']} for r in contexts]
contract=Path('scripts/memory-answer-contract.txt').read_text()+'\n'+Path('scripts/progressive-answer-guidance.txt').read_text()
manifest={'model':'gpt-5.6-luna','effort':'low','source':str(BASE),'affected_ids':sorted(affected),'context_and_demand_cap_bytes':CAP,'input_sha256':{name:hashlib.sha256((PREP/name).read_bytes()).hexdigest() for name in ['candidate.contexts.json','progressive-trace.json']},'contract_sha256':hashlib.sha256(contract.encode()).hexdigest(),'judge_fingerprint':fingerprint(),'reason':'Original regression movie case selected both actress and decade but answer ignored actress; deliver structured selection and gaps to answer stage. No retrieval tuning or holdout score used.','limits':'Same-model judge, small public-dataset holdout. Reused frozen baseline answer+grade for unaffected inputs.'}
if DYNAMIC:
    manifest.update(input_sha256={name:hashlib.sha256((PREP/name).read_bytes()).hexdigest() for name in ['candidate.contexts.json','progressive-trace.json']},reason='Dynamic semantic demand, protected evidence, scoped source expansion, partial-answer guidance; compare frozen v3 candidate answers.',limits='Same-model judge; 30 public holdout cases are now previously inspected regression validation, not unseen generalization.')
if UNBIASED:
    manifest.update(reason='Remove stale planner abstention/gaps from answer inputs; retain exactly the delivered v4 evidence. Frozen v4 candidate answers are the baseline.',delivered_sha256=hashlib.sha256((BASE/'delivered-inputs.json').read_bytes()).hexdigest())
if SAFE:manifest.update(reason='Continue from the latest v3 evidence context rather than an obsolete pre-disclosure snapshot; preserve evidence and omit stale planner gap conclusions. Frozen v3 answers remain the baseline.')
if (ROOT/'manifest.json').exists():assert json.loads((ROOT/'manifest.json').read_text())==manifest
save('manifest.json',manifest)
# Freeze the follow-up protocol before the preceding full result is available.
if not DYNAMIC:assert json.loads((BASE/'judge-calibration.json').read_text())['passed']
ns={'__file__':str(ROOT/'run.py')}
exec(compile(Path('.review-runtime/repair-luna56-final-20261103/run.py').read_text().split('OLD=ROOT.parent')[0],'<frozen-cli-helper>','exec'),ns)
def call(tag,prompt):return cached_call(ns['uncached_call'],ROOT,tag,prompt,Path('.review-runtime/progressive-v5-20261103').resolve() if SAFE else None)
def delivery(r):
    demand=demands.get(r['id'],{'decision':'answer','missing_information':[],'preference_refs':[]})
    d={k:demand[k] for k in ['decision','missing_information','preference_refs']}
    if DYNAMIC and 'strategy' in demand:d['strategy']={k:v for k,v in demand['strategy'].items() if k not in ['required_evidence','expand_refs']}
    if UNBIASED or SAFE:
        # Retrieval stop decisions are not conclusions about the final answer evidence.
        d.pop('decision',None);d.pop('missing_information',None)
    metadata_bytes=len(json.dumps(d,ensure_ascii=False).encode());context=''
    for block in blocks(r['context']):
        if len((context+block).encode())+metadata_bytes<=CAP:context+=block
    if DYNAMIC and not UNBIASED:
        required=[e for e in demand.get('strategy',{}).get('required_evidence',[]) if any(b.startswith('['+e['ref']+']') and e['quote'] in b for b in blocks(r['context']))]
        context,_=merge_evidence(r['context'],[],required,cap=CAP-metadata_bytes)
        d['preference_refs']=[ref for ref in d['preference_refs'] if ref in preference_refs(context)]
    assert set(d['preference_refs'])<=set(preference_refs(context)),'Selected preference missing from delivered context'
    assert len(context.encode())+metadata_bytes<=CAP
    return {'id':r['id'],'question':r['question'],'context':context,'knowledge_demand':d}
def generate(job):
    i,batch=job;payload=[delivery(r) for r in batch]
    prompt=contract+'\n'+json.dumps(payload,ensure_ascii=False)
    def valid(result):
        return isinstance(result,list) and len(result)==len(batch) and all(isinstance(r,dict) and set(r)=={'id','answer'} and isinstance(r['answer'],str) for r in result) and {r['id'] for r in result}=={r['id'] for r in batch}
    result=call(f'answer-guidance-{i}',prompt)
    if not valid(result):
        save(f'answer-schema-error-{i}.json',{'expected_ids':[r['id'] for r in batch],'rejected':result})
        result=call(f'answer-guidance-{i}-schema-retry',prompt+'\nReturn exactly one object per case. Copy each id verbatim, with no edits: '+json.dumps([r['id'] for r in batch]))
    assert valid(result),'Answer schema still invalid after one bounded retry'
    return result
def generate_affected():
    answers={}
    jobs=list(enumerate(ns['batches']([r for r in contexts if r['id'] in affected])))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for result in pool.map(generate,jobs):
            answers.update({r['id']:r['answer'] for r in result});save('answers.partial.json',answers)
    return answers
if __name__=='__main__':
    import sys
    if '--freeze-only' in sys.argv:
        for r in contexts:
            if r['id'] in affected:delivery(r)
        print('Frozen answer-consumption follow-up for '+str(len(affected))+' cases');raise SystemExit(0)
    if '--generate-only' in sys.argv:
        save('delivered-inputs.json',[delivery(r) for r in contexts if r['id'] in affected])
        generate_affected();print('Affected answers saved; scoring deferred');raise SystemExit(0)
    base=json.loads((BASE/'results.json').read_text())
    if DYNAMIC:
        for r in base['rows']:
            r['before_answer']=r['candidate_answer']
            r['grades']['before']=r['grades']['candidate']
        save('delivered-inputs.json',[delivery(r) for r in contexts])
    lookup={r['id']:r for r in base['rows']}
    answers={};grades={};errors=[{**e,'source':'reused baseline grade'} for e in base['errors'] if e.get('id') not in affected]
    for r in base['rows']:
        if r['id'] not in affected:
            answers[r['id']]=r['before_answer'];grades[r['id']]={**r['grades'],'candidate':r['grades']['before']}
    answers.update(generate_affected())
    pairs=[{**lookup[r['id']],'candidate_answer':answers[r['id']]} for r in contexts if r['id'] in affected]
    if DYNAMIC:
        calibration=json.loads(Path('.review-runtime/progressive-v4-calibration-20261103/judge-calibration.json').read_text())
        assert calibration['passed'] and calibration['judge_fingerprint']==fingerprint(),'Calibration gate failed; answers retained, scoring blocked'
    ledger_path=ROOT/'judge-ledger.json'
    if UNBIASED and not ledger_path.exists():ledger_path=BASE/'judge-ledger.json'
    if SAFE and not ledger_path.exists():ledger_path=Path('.review-runtime/progressive-v5-20261103/judge-ledger.json')
    ledger=json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    def grade(job):
        i,batch=job;return judge_pairs(call,batch,f'judge-guidance-{i}',dict(ledger))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for result in pool.map(grade,[(i,pairs[i:i+4]) for i in range(0,len(pairs),4)]):
            grades.update({r['id']:r for r in result['rows']});errors.extend(result['errors'])
            for r in result['rows']:
                for lane in ['before','candidate']:ledger[r[lane]['answer_key']]=r[lane]
            save('grades.partial.json',{'rows':list(grades.values()),'errors':errors});save('judge-ledger.json',ledger)
    rows=[{**r,'candidate_answer':answers[r['id']],'grades':grades[r['id']],'input_changed':r['id'] in affected} for r in base['rows']]
    summary={}
    for group in ['regression','holdout']:
        summary[group]={}
        for dataset in ['all','LoCoMo','LongMemEval','Memora']:
            selected=[r for r in rows if r['group']==group and (dataset=='all' or r['sample_id']==dataset)]
            summary[group][dataset]={'cases':len(selected),**{lane:{'correct':sum(r['grades'][lane]['correct'] is True for r in selected),'incorrect':sum(r['grades'][lane]['correct'] is False for r in selected),'uncertain':sum(r['grades'][lane]['correct'] is None for r in selected)} for lane in ['before','candidate']},'improved':sum(r['grades']['before']['correct'] is False and r['grades']['candidate']['correct'] is True for r in selected),'regressed':sum(r['grades']['before']['correct'] is True and r['grades']['candidate']['correct'] is False for r in selected)}
    save('results.json',{'summary':summary,'errors':errors,'rows':rows})
    save('review-queue.json',[r for r in rows if any(r['grades'][lane]['correct'] is None for lane in ['before','candidate']) or (r['grades']['before']['correct'] is True and r['grades']['candidate']['correct'] is False)])
    print(json.dumps(summary),flush=True)
