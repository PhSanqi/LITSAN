import json,sys
from pathlib import Path
from memory_judge import judge_pairs,fingerprint
ROOT=Path(sys.argv[1] if len(sys.argv)>1 else '.review-runtime/progressive-v1-20261103').resolve()
ROOT.mkdir(exist_ok=True);(ROOT/'work').mkdir(exist_ok=True)
ns={'__file__':str(ROOT/'run.py')}
source=Path('.review-runtime/repair-luna56-final-20261103/run.py').read_text().split('OLD=ROOT.parent')[0]
exec(compile(source,'<frozen-cli-helper>','exec'),ns)
from memory_eval_calls import cached_call
def call(tag,prompt):return cached_call(ns['uncached_call'],ROOT,tag,prompt)
cases=[
 ('facts','Which activities relax Robin?','Swimming and chess.','Robin relaxes through swimming and chess.','Robin only runs.'),
 ('date','When was the visit?','2024-03-08','March 8, 2024.','March 1, 2024.'),
 ('budget','What is the current budget?','The current budget is $1000.','$1,000.','$1,200.'),
 ('unknown','Which hotel was booked?','No hotel has been booked.','No hotel has been booked.','The Harbor Hotel was booked.'),
 ('preference','Recommend an activity matching my preferences.','The user likes hiking and dislikes swimming.','Try a hiking trail, since you like hiking and dislike swimming.','Go swimming because you love it.'),
 ('equivalent','What is the code?','ORBIT-47','ORBIT-47','ORBIT-47')
]
rows=[{'id':key,'question':q,'gold':gold,'before_answer':before,'candidate_answer':after} for key,q,gold,before,after in cases]
conference={'evaluation':{'evaluation_questions':[{'evaluation_question_id':'publication','evaluation_question':'Does the proposal include publish two papers?','expected_answer':'yes','evaluation_type':'memory_presence'},{'evaluation_question_id':'conference','evaluation_question':'Does the proposal include present findings at relevant academic and industry conferences?','expected_answer':'yes','evaluation_type':'memory_presence'}]}}
rows.append({'id':'conference','question':'Draft the dissemination objectives.','gold':json.dumps(conference),'before_answer':'We will publish two papers and present findings at relevant academic and industry conferences.','candidate_answer':'We will publish two papers.'})
negative={'evaluation':{'evaluation_questions':[{'evaluation_question_id':'forgotten','evaluation_question':'Does the answer claim that the user likes opera?','expected_answer':'no','evaluation_type':'forgetting_absence'}]}}
rows.append({'id':'negative','question':'Recommend music without claiming forgotten preferences.','gold':json.dumps(negative),'before_answer':'Try a folk album.','candidate_answer':'You like opera, so try opera arias.'})
rows.extend([
 {'id':'generic','question':'Recommend a destination.','gold':json.dumps(negative),'before_answer':'Consider opera performances as one possible cultural activity.','candidate_answer':'Because you like opera, choose an opera festival.'},
 {'id':'partial','question':'Where did I redeem the coupon?','gold':'Target','before_answer':'At Target; the particular app is uncertain.','candidate_answer':'Insufficient evidence.'},
 {'id':'lower-bound','question':'What is the exact total of projects I led?','gold':'Exactly two projects.','before_answer':'Exactly two projects.','candidate_answer':'At least one; the total is unknown.'}
])
ambiguous={'evaluation':{'evaluation_questions':[{'evaluation_question_id':'forgotten','evaluation_question':"Does the response reflect or mention the user's preference for tropical?",'expected_answer':'no','evaluation_type':'forgetting_absence'}]}}
rows.append({'id':'ambiguous','question':'Suggest a trip.','gold':json.dumps(ambiguous),'before_answer':'Consider visiting a tropical garden.','candidate_answer':'You prefer tropical climates, so visit a tropical island.'})
results=[];errors=[];repeats=[];repairs=[]
for repeat in range(2):
 current=[]
 for i in range(0,len(rows),4):
  result=judge_pairs(call,rows[i:i+4],f'calibration-{fingerprint()[:12]}-repeat-{repeat}-{i//4}')
  current.extend(result['rows']);errors.extend(result['errors']);repairs.extend(result.get('repairs',[]))
 repeats.append(current)
results=repeats[0]
if repeats[0]!=repeats[1]:errors.append({'error':'Fresh repeated calibration judgments disagree'})
failures=[]
for result in results:
 for lane in ['before','candidate']:
  expected=lane=='before' or result['id']=='equivalent'
  if result['id']=='ambiguous' and lane=='before':expected=None
  if result[lane]['correct'] is not expected: failures.append({'id':result['id'],'lane':lane,'expected':expected,'actual':result[lane]['correct']})
report={'judge_fingerprint':fingerprint(),'cases':len(rows),'labels':len(rows)*2,'fresh_repeats':2,'passed':not failures and not errors,'failures':failures,'errors':errors,'repairs':repairs,'results':results,'repeats':repeats}
(ROOT/('judge-calibration-'+fingerprint()[:12]+'.json')).write_text(json.dumps(report,indent=2))
(ROOT/'judge-calibration.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'passed':report['passed'],'failures':failures,'errors':errors}),flush=True)
if not report['passed']:raise SystemExit('Calibration gate failed; do not optimize with these labels')
