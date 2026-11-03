"""Paired answer-contract experiment; frozen retrieval, real Luna calls, blind paired grading."""
import json
import random
import sys
import hashlib
import concurrent.futures
from pathlib import Path

BASE = Path('.review-runtime/repair-luna56-final-20261103').resolve()
regrade_only = '--regrade-frozen' in sys.argv
followup = '--completeness-followup' in sys.argv
assert not (regrade_only and followup)
ROOT = Path('.review-runtime/repair-luna56-completeness-20261103' if followup else '.review-runtime/repair-luna56-contract-control-20261103' if regrade_only else '.review-runtime/repair-luna56-contract-20261103').resolve()
ROOT.mkdir(exist_ok=True)
(ROOT / 'work').mkdir(exist_ok=True)
# Reuse the frozen runner's audited CLI, usage recording and exact-prompt cache.
namespace = {'__file__': str(ROOT / 'run.py')}
source = (BASE / 'run.py').read_text().split('OLD=ROOT.parent')[0]
exec(compile(source, str(BASE / 'run.py'), 'exec'), namespace)
call = namespace['call']
contract = Path('scripts/memory-answer-contract.txt').read_text()
if (ROOT / 'manifest.json').exists():
    saved = json.loads((ROOT / 'manifest.json').read_text())
    assert saved['contract_sha256'] == hashlib.sha256(contract.encode()).hexdigest(), 'Refusing to overwrite an experiment with a different answer contract; use a fresh experiment root.'
context_paths = {'before':BASE / ('candidate.contexts.json' if followup else 'before.contexts.json'), 'candidate':BASE.parent / 'repair-luna56-intent-20261103/candidate.contexts.json' if followup else BASE / 'candidate.contexts.json'}
contexts = {lane:json.loads(path.read_text()) for lane,path in context_paths.items()}
if (ROOT / 'manifest.json').exists():
    assert saved['context_sha256'] == {lane:hashlib.sha256(path.read_bytes()).hexdigest() for lane,path in context_paths.items()}, 'Refusing to overwrite an experiment with different contexts'
assert len(contexts['before']) == len(contexts['candidate']) == 90
assert [r['id'] for r in contexts['before']] == [r['id'] for r in contexts['candidate']]
assert all(len(r['context'].encode()) <= 16000 for rows in contexts.values() for r in rows)
(ROOT / 'manifest.json').write_text(json.dumps({'mode':'completeness-followup' if followup else 'frozen-answer-regrade' if regrade_only else 'new-contract-frozen-contexts','source':str(BASE),'contract_sha256':hashlib.sha256(contract.encode()).hexdigest(),'context_sha256':{lane:hashlib.sha256(path.read_bytes()).hexdigest() for lane,path in context_paths.items()},'model':'gpt-5.6-luna','effort':'low','cases':90,'cap_bytes':16000,'limitations':'Same tuned 90 cases; same model judge; no live MCP or production deployment.'},indent=2))
answers = {'before': {}, 'candidate': {}}

def answer(job):
    lane, i, rows = job
    evidence = [{k: r[k] for k in ['id', 'question', 'context']} for r in rows]
    result = call(f'contract-{lane}-{i:02}', contract + '\n' + json.dumps(evidence))
    assert len(result) == len(rows) and {r['id'] for r in result} == {r['id'] for r in rows}
    assert all(isinstance(r['answer'], str) for r in result)
    return lane, result

jobs = [] if regrade_only else [(lane, i, rows) for lane, data in contexts.items() if not followup or lane=='candidate' for i, rows in enumerate(namespace['batches'](data))]
if regrade_only:
    answers = json.loads((BASE / 'answers.json').read_text())
if followup:
    answers['before']=json.loads((BASE.parent/'repair-luna56-contract-20261103/answers.json').read_text())['candidate']
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    for lane, result in pool.map(answer, jobs):
        answers[lane].update({r['id']: r['answer'] for r in result})
        (ROOT / 'answers.partial.json').write_text(json.dumps(answers, indent=2))
(ROOT / 'answers.json').write_text(json.dumps(answers, indent=2))

# Both answers share one grading decision, with deterministic randomized order and hidden lane names.
rng = random.Random(20261103)
mapping = {}
items = []
for i, row in enumerate(contexts['before']):
    lanes = ['before', 'candidate']; rng.shuffle(lanes)
    token = f'case-{i}'
    mapping[token] = (row['id'], lanes)
    items.append({'id': token, 'question': row['question'], 'reference': row['gold'], 'answers': [answers[lane][row['id']] for lane in lanes]})
grades = {}
prompt = ('Grade both answers to each question against the same reference using the same standard. Use no tools. Accept equivalent meanings and date paraphrases; equivalent answers MUST receive identical correctness labels. For Memora require requested current facts and reject outdated facts stated as current; do not require unrelated metadata. General suggestions may accompany grounded personalization; they must not contradict the reference. Do not penalize style. Return ONLY JSON array of {"id":string,"correct":[boolean,boolean],"reasons":[string,string]}, preserving answer order.\n')
for i in range(0, len(items), 6):
    batch = items[i:i+6]
    result = call(f'paired-judge-{i//6:02}', prompt + json.dumps(batch))
    assert len(result) == len(batch) and {r['id'] for r in result} == {r['id'] for r in batch}
    for r in result:
        key, lanes = mapping[r['id']]
        assert len(r['correct']) == len(r['reasons']) == 2 and all(type(x) is bool for x in r['correct'])
        if answers['before'][key] == answers['candidate'][key]:
            assert r['correct'][0] == r['correct'][1], 'Identical answers received inconsistent grades'
        for j, lane in enumerate(lanes): grades[(key, lane)] = (r['correct'][j], r['reasons'][j])
    (ROOT / 'grades.partial.json').write_text(json.dumps([{'id': k, 'lane': lane, 'correct': v[0], 'reason': v[1]} for (k, lane), v in grades.items()], indent=2))
rows = []
historical_results = BASE.parent / 'repair-luna56-contract-20261103/results.json' if followup else BASE / 'results.json'
old = {r['id']: r for r in json.loads(historical_results.read_text())['rows']}
for r in contexts['before']:
    key = r['id']
    rows.append({**{k:r[k] for k in ['id','sample_id','question','gold']}, **{lane+'_answer': answers[lane][key] for lane in answers}, **{lane+'_correct': grades[(key,lane)][0] for lane in answers}, **{lane+'_reason': grades[(key,lane)][1] for lane in answers}, 'old_before_correct':old[key]['candidate_correct'] if followup else old[key]['before_correct'], 'old_candidate_correct':old[key]['candidate_correct']})
summary = {}
for name in ['all', 'LoCoMo', 'LongMemEval', 'Memora']:
    selected = [r for r in rows if name == 'all' or r['sample_id'] == name]
    summary[name] = {'cases':len(selected), **{lane:sum(r[lane+'_correct'] for r in selected) for lane in answers}, 'improved':sum(r['candidate_correct'] and not r['before_correct'] for r in selected), 'regressed':sum(r['before_correct'] and not r['candidate_correct'] for r in selected)}
(ROOT / 'results.json').write_text(json.dumps({'protocol':'frozen-context-paired-contract-v1','model':'gpt-5.6-luna','effort':'low','summary':summary,'rows':rows}, indent=2))
print(json.dumps(summary), flush=True)
