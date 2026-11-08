"""Criterion 3: do real LITSAN L2 facts cite L1 turns whose text can be found? Read-only.

Takes the most recent completed memhub L2 job with fact metadata, samples 50 facts (seed
20261107), and checks each fact's evidence_refs against the capture store (one JSON per
event). A fact resolves when at least one cited l1 ref exists with non-empty user or
assistant text. Also reports how specific facts are: share citing exactly one turn.
usage: python3 benchmarks/retrieval/locomo-derived/ref-resolution.py
"""
import glob, json, os, random, collections
STATE = os.path.expanduser('~/.memmy/memhub')
jobs = json.load(open(f'{STATE}/distillation/jobs.json'))
jobs = jobs.get('jobs', jobs) if isinstance(jobs, dict) else jobs
done = [j for j in jobs if j.get('status') == 'completed' and j.get('target') == 'l2' and j.get('project_id') == 'memhub' and (j.get('result_fact_metadata') or {}).get('facts')]
job = max(done, key=lambda j: j.get('result_committed_at') or '')
facts = job['result_fact_metadata']['facts']
events = {}
for p in glob.glob(f'{STATE}/captures/*/*.json'):
    try:
        e = json.load(open(p))
    except Exception:
        continue
    if isinstance(e, dict) and e.get('event_id'):
        events[e['event_id']] = bool((e.get('user_text') or '').strip() or (e.get('assistant_text') or '').strip())
rng = random.Random(20261107)
sample = rng.sample(facts, min(50, len(facts)))
res = collections.Counter()
for f in sample:
    l1 = [r[3:] for r in f.get('evidence_refs', []) if r.startswith('l1:')]
    ok = any(events.get(i) for i in l1)
    res['resolved' if ok else ('no_l1_ref' if not l1 else 'unresolved')] += 1
    res[f'cites_{min(len(l1), 3)}{"+" if len(l1) >= 3 else ""}_turns'] += 1
print(json.dumps({'job_committed_at': job.get('result_committed_at'), 'facts_in_revision': len(facts), 'capture_events': len(events),
                  'sample': len(sample), **res, 'resolution_rate': round(res['resolved'] / len(sample), 3)}, indent=1))
