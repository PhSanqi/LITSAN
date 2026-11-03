import json,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from memory_eval_calls import cached_call
with tempfile.TemporaryDirectory(dir='.review-runtime') as d:
    root=Path(d);(root/'calls').mkdir();calls=[]
    def call(tag,prompt):
        calls.append(tag);p=root/'calls'/tag
        p.with_suffix('.prompt.txt').write_text(prompt)
        p.with_suffix('.jsonl').write_text('\n'.join(json.dumps(x) for x in [{'type':'item.completed','item':{'type':'agent_message','text':'{"answer":"ok"}'}},{'type':'turn.completed'}]))
        return {'answer':'ok'}
    assert cached_call(call,root,'sample','one')=={'answer':'ok'}
    first=(root/'calls'/calls[0]).with_suffix('.jsonl').read_bytes()
    assert cached_call(call,root,'sample','one')=={'answer':'ok'} and len(calls)==1
    assert (root/'calls'/calls[0]).with_suffix('.jsonl').read_bytes()==first
    cached_call(call,root,'sample','two');assert len(calls)==2
    second=root/'other';second.mkdir()
    assert cached_call(call,second,'sample','one',root)=={'answer':'ok'} and len(calls)==2
    assert (second/'cache-reuse.jsonl').exists()
print('6 immutable cache and reuse checks passed')
