import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from memory_judge import validate_assessment,reconcile
rubric=[{'id':'r','expected':'yes','source':'present findings at relevant academic and industry conferences.'}]
answer='We will present findings at relevant academic and industry conferences.'
base={'id':'a','assessments':[{'criterion_id':'r','verdict':'pass','answer_quotes':[answer],'missing_claim':'','reason':'Supported'}]}
v=validate_assessment(base,answer,rubric)
assert reconcile(v,v)[0] is True
for changes in [{'answer_quotes':['fabricated']},{'answer_quotes':[]},{'verdict':'fail','answer_quotes':[],'missing_claim':'present findings at relevant academic and industry conferences'}, {'verdict':'fail','answer_quotes':[],'missing_claim':'invented requirement'},{'extra':True}]:
    bad={'id':'a','assessments':[{**base['assessments'][0],**changes}]}
    try: validate_assessment(bad,answer,rubric)
    except ValueError: pass
    else: raise AssertionError(changes)
u={'r':{**v['r'],'verdict':'uncertain'}}
assert reconcile(v,u)[0] is None
assert reconcile(u,u)[0] is None
print('8 judge validation/uncertainty checks passed')
from memory_judge import judge_pairs
import json
calls=[]
def fake(tag,prompt):
    calls.append(tag)
    data=json.loads(prompt.split('\n')[-1])
    return [{'id':r['id'],'assessments':[{'criterion_id':c['id'],'verdict':'pass','answer_quotes':[r['answer']],'missing_claim':'','reason':'supported'} for c in r['criteria']]} for r in data]
row={'id':'q','question':'Where?','gold':'Target','before_answer':'Target','candidate_answer':'Target'}
ledger={}
first=judge_pairs(fake,[row],'first',ledger)
assert len(ledger)==1 and len(calls)==2
second=judge_pairs(fake,[row],'second',ledger)
assert first==second and len(calls)==2
assert first['rows'][0]['before']==first['rows'][0]['candidate']
print('3 content-addressed blind judge checks passed')
case={'id':'a','assessments':[{'criterion_id':'r','verdict':'pass','answer_quotes':['target'],'missing_claim':'','reason':'supported'}]}
assert validate_assessment(case,'Target',[{'id':'r','expected':'yes','source':'Target'}])['r']['answer_quotes']==['Target']
print('Exact source casing recovery passed')
attempts=[]
def invalid_then_repair(tag,prompt):
    attempts.append(tag)
    data=json.loads(prompt.split('\n')[-1])
    return [{'id':r['id'],'assessments':[{'criterion_id':c['id'],'verdict':'pass','answer_quotes':['fabricated' if len(attempts)==1 else r['answer']],'missing_claim':'','reason':'supported'} for c in r['criteria']]} for r in data]
repaired=judge_pairs(invalid_then_repair,[row],'repair-check')
assert len(attempts)==3 and repaired['rows'][0]['candidate']['correct'] is True
assert not repaired['errors'] and len(repaired['repairs'])==1
rejected=judge_pairs(lambda tag,prompt:[],[row],'bad-ids')
assert rejected['rows'][0]['before']['correct'] is None and len(rejected['errors'])==2
print('3 bounded grade recovery checks passed')
