"""P2 packing: paired C2 vs D8 per set (exact McNemar), plus where fresh-set raw hits came from."""
import os
import json, math, re
# Data folder (LoCoMo copy, attribution sets): LITSAN_BENCH_DATA, default <repo>/.review-runtime (git-ignored).
DATA = os.environ.get('LITSAN_BENCH_DATA') or os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../..', '.review-runtime'))
OUT = '.review-runtime/locomo-derived'
MH = DATA + '/attribution-20261106/multihop'
SETS = {'dev': (json.load(open(f'{MH}/questions.json'))['dev'], 'dev'),
        'holdout': (json.load(open(f'{MH}/questions.json'))['holdout'], 'ho'),
        'fresh': (json.load(open('benchmarks/retrieval/locomo-derived/sets/graph-holdout-locomo.json'))['fresh'], 'fr')}
def norm(s): return re.sub(r'[^a-z0-9]+', ' ', s.lower().replace('\\n', ' ')).strip()
TURN = {}
for c in json.load(open(DATA + '/benchmarks/data/locomo10.json')):
    for k, v in c['conversation'].items():
        if re.fullmatch(r'session_\d+', k) and isinstance(v, list):
            for t in v: TURN[(c['sample_id'], t['dia_id'])] = norm(f"{t['speaker']}: {t['text']}")
def mcnemar(k, n): return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(k, n - k) + 1)) / 2 ** n)
def gold(r): return [d for d in r['evidence'] if (r['conv'], d) in TURN]
def raw_hits(text, r): hay = norm(text); return [TURN[(r['conv'], d)][:60] in hay for d in gold(r)]
def any_hits(text, r): return [h or f"l1:lc-{r['conv']}-{d.replace(':', '-')}" in text for h, d in zip(raw_hits(text, r), gold(r))]
out = {}
for name, (rows, tag) in SETS.items():
    c, d = (json.load(open(f'{OUT}/responses-{a}-{tag}.json')) for a in ('C2', 'D8'))
    rows = [r for r in rows if gold(r) and r['id'] in c]
    for label, fn in [('complete_raw', raw_hits), ('complete_raw_or_cited', any_hits)]:
        a = [all(fn(c[r['id']]['text'], r)) for r in rows]; b = [all(fn(d[r['id']]['text'], r)) for r in rows]
        g = sum(1 for x, y in zip(a, b) if not x and y); l = sum(1 for x, y in zip(a, b) if x and not y)
        out[f'{name}:{label}'] = {'n': len(rows), 'C2': sum(a), 'D8': sum(b), 'gained': g, 'lost': l, 'p': round(mcnemar(g, g + l), 4)}
    # gold turns delivered raw by C2 but dropped by D8: were they cited by a delivered fact?
    dropped = cited = 0
    for r in rows:
        for d_, x, y in zip(gold(r), raw_hits(c[r['id']]['text'], r), raw_hits(d[r['id']]['text'], r)):
            if x and not y:
                dropped += 1
                facts = json.dumps([s for s in json.loads(c[r['id']]['text'])['turnKnowledgePlan']['supporting'] if s.get('kind') == 'L2'])
                cited += f"l1:lc-{r['conv']}-{d_.replace(':', '-')}" in facts
    out[f'{name}:raw_dropped_by_D8'] = {'gold_turns': dropped, 'cited_by_a_delivered_fact': cited}
print(json.dumps(out, indent=1))
json.dump(out, open(f'{OUT}/paired-p2.json', 'w'), indent=1)
