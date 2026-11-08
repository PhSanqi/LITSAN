"""P3 slots: paired arm-vs-control comparison pooled over the parts of one question file.
Usage: python3 paired-p3.py <questions.json> <suffix> <control> <arm> [<arm> ...]
Reads .review-runtime/locomo-derived/responses-<arm>-<suffix>.json; exact McNemar, 95% CI of the paired difference."""
import os
import json, math, re, sys, collections
# Data folder (LoCoMo copy, attribution sets): LITSAN_BENCH_DATA, default <repo>/.review-runtime (git-ignored).
DATA = os.environ.get('LITSAN_BENCH_DATA') or os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../..', '.review-runtime'))
OUT = '.review-runtime/locomo-derived'
qfile, suffix, control, arms = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
def norm(s): return re.sub(r'[^a-z0-9]+', ' ', s.lower().replace('\\n', ' ')).strip()
TURN = {}
for c in json.load(open(DATA + '/benchmarks/data/locomo10.json')):
    for k, v in c['conversation'].items():
        if re.fullmatch(r'session_\d+', k) and isinstance(v, list):
            for t in v: TURN[(c['sample_id'], t['dia_id'])] = norm(f"{t['speaker']}: {t['text']}")
def mcnemar(k, n): return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(k, n - k) + 1)) / 2 ** n)
def gold(r): return [d for d in r['evidence'] if (r['conv'], d) in TURN]
def raw(text, r): hay = norm(text); return [TURN[(r['conv'], d)][:60] in hay for d in gold(r)]
def anyhit(text, r): return [h or f"l1:lc-{r['conv']}-{d.replace(':', '-')}" in text for h, d in zip(raw(text, r), gold(r))]
rows = [r for part in json.load(open(qfile)).values() for r in part if gold(r)]
resp = {a: json.load(open(f'{OUT}/responses-{a}-{suffix}.json')) for a in [control, *arms]}
rows = [r for r in rows if all(r['id'] in resp[a] for a in resp)]
n = len(rows)
def stats(arm):
    out = {'n': n, 'mean_bytes': round(sum(len(resp[arm][r['id']]['text'].encode()) for r in rows) / n),
           'p95_ms': sorted(resp[arm][r['id']]['ms'] for r in rows)[int(n * 0.95)],
           'raw_recall': round(sum(sum(raw(resp[arm][r['id']]['text'], r)) / len(gold(r)) for r in rows) / n, 4)}
    for label, fn in [('complete_raw', raw), ('complete_raw_or_cited', anyhit)]:
        a = [all(fn(resp[control][r['id']]['text'], r)) for r in rows]
        b = [all(fn(resp[arm][r['id']]['text'], r)) for r in rows]
        g = sum(1 for x, y in zip(a, b) if not x and y); l = sum(1 for x, y in zip(a, b) if x and not y)
        d = (g - l) / n; se = math.sqrt(max(0.0, (g + l) / n - d * d) / n)
        cats = collections.Counter();
        for r, x, y in zip(rows, a, b): cats[r['category']] += (y - x)
        out[label] = {'control': sum(a), 'arm': sum(b), 'gained': g, 'lost': l, 'p': round(mcnemar(g, g + l), 4),
                      'diff_pp': round(100 * d, 2), 'ci95_pp': [round(100 * (d - 1.96 * se), 2), round(100 * (d + 1.96 * se), 2)],
                      'net_by_category': dict(sorted(cats.items()))}
    return out
result = {arm: stats(arm) for arm in [control, *arms]}
print(json.dumps(result, indent=1))
json.dump(result, open(f'{OUT}/paired-p3-{suffix}.json', 'w'), indent=1)
