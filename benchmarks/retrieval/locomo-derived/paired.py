"""Paired per-question comparison of arms A and B (complete evidence, raw or cited), exact McNemar."""
import os
import json, math, re
# Data folder (LoCoMo copy, attribution sets): LITSAN_BENCH_DATA, default <repo>/.review-runtime (git-ignored).
DATA = os.environ.get('LITSAN_BENCH_DATA') or os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../..', '.review-runtime'))
OUT = '.review-runtime/locomo-derived'
Q = json.load(open(DATA + '/attribution-20261106/multihop/questions.json'))
resp = {a: json.load(open(f'{OUT}/responses-{a}.json')) for a in 'ABC'}
def complete(arm, r):
    text = resp[arm][r['id']]['text']
    return all(f"l1:lc-{r['conv']}-{d.replace(':', '-')}" in text for d in r['evidence'])
def norm(s): return re.sub(r'[^a-z0-9]+', ' ', s.lower().replace('\\n', ' ')).strip()
TURN = {}
for c in json.load(open(DATA + '/benchmarks/data/locomo10.json')):
    for k, v in c['conversation'].items():
        if re.fullmatch(r'session_\d+', k) and isinstance(v, list):
            for t in v: TURN[(c['sample_id'], t['dia_id'])] = norm(f"{t['speaker']}: {t['text']}")
def complete_raw(arm, r):
    hay = norm(resp[arm][r['id']]['text'])
    return all(TURN[(r['conv'], d)][:60] in hay for d in r['evidence'] if (r['conv'], d) in TURN)
def mcnemar(k, n): return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(k, n - k) + 1)) / 2 ** n)
out = {}
for a, b, fn in [('A', 'B', complete), ('B', 'C', complete), ('B', 'C', complete_raw), ('A', 'C', complete)]:
  for part in ['dev', 'holdout']:
    rows = [r for r in Q[part] if r['evidence']]
    wc = sum(1 for r in rows if not fn(a, r) and fn(b, r)); cw = sum(1 for r in rows if fn(a, r) and not fn(b, r))
    out[f'{a}->{b}:{fn.__name__}:{part}'] = {'n': len(rows), a: sum(fn(a, r) for r in rows), b: sum(fn(b, r) for r in rows), 'gained': wc, 'lost': cw, 'mcnemar_p': round(mcnemar(wc, wc + cw), 4)}
for part in []:
    rows = [r for r in Q[part] if r['evidence']]
    wc = sum(1 for r in rows if not complete('A', r) and complete('B', r))
    cw = sum(1 for r in rows if complete('A', r) and not complete('B', r))
    out[part] = {'n': len(rows), 'A_complete_cited': sum(complete('A', r) for r in rows), 'B_complete_cited': sum(complete('B', r) for r in rows),
                 'gained': wc, 'lost': cw, 'mcnemar_p': round(mcnemar(wc, wc + cw), 4)}
print(json.dumps(out, indent=1))
json.dump(out, open(f'{OUT}/paired.json', 'w'), indent=1)
