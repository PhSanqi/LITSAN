"""Immutable exact-prompt cache and bounded recovery for evaluation calls."""
import hashlib,json,subprocess,threading,time
LOCK=threading.Lock()
def cached_call(raw_call,root,tag,prompt,reuse_root=None):
    tag=tag+'-'+hashlib.sha256(prompt.encode()).hexdigest()[:12]
    for directory in [root,reuse_root]:
        if directory is None:continue
        for name in [tag,'retry-'+tag]+[f'{tag}-attempt-{n}' for n in range(3)]:
            path=directory/'calls'/name
            try:
                saved=path.with_suffix('.prompt.txt').read_text()
                if saved not in [prompt,prompt+'\nEnsure the response is valid JSON with all quotation marks inside strings escaped.']:continue
                events=[json.loads(line) for line in path.with_suffix('.jsonl').read_text().splitlines()]
                if not any(e.get('type')=='turn.completed' for e in events):continue
                if any(e.get('type')=='item.completed' and e.get('item',{}).get('type') not in ['reasoning','agent_message'] for e in events):continue
                messages=[e['item']['text'] for e in events if e.get('type')=='item.completed' and e['item'].get('type')=='agent_message']
                content=messages[-1].strip()
                if content.startswith('```'):content=content.split('\n',1)[1].rsplit('```',1)[0].strip()
                result=json.loads(content)
            except (OSError,ValueError,KeyError,IndexError):continue
            with LOCK:
                with (root/'cache-reuse.jsonl').open('a') as out:out.write(json.dumps({'tag':tag,'source':str(path.with_suffix('.jsonl')),'sha256':hashlib.sha256(path.with_suffix('.jsonl').read_bytes()).hexdigest()})+'\n')
            return result
    failures=[]
    for attempt in range(3):
        name=f'{tag}-attempt-{attempt}';path=root/'calls'/name
        if path.with_suffix('.prompt.txt').exists():continue
        try:return raw_call(name,prompt)
        except (ValueError,RuntimeError,subprocess.TimeoutExpired) as exc:
            failures.append(str(exc))
            with LOCK:
                with (root/'call-failures.jsonl').open('a') as out:out.write(json.dumps({'tag':name,'error':str(exc)})+'\n')
            if attempt<2:time.sleep(5*(attempt+1))
    raise RuntimeError('Bounded evaluation attempts exhausted: '+tag+' '+str(failures))
