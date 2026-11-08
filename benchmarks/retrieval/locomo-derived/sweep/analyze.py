#!/usr/bin/env python3
"""P7 analysis (P7-FIRST-CALL-SWEEP-CRITERIA.md). No model call; gold is used only for scoring.
usage: analyze.py <questions.json> <suffix> [--base N4200] [--k 80] [--out score-p7-s1.json] [--picks-out picks.json]
Reads .review-runtime/{locomo-derived,sweep-w*}/responses-<name>-<suffix>.json  (name = arm; the baseline is --base).
Scorer = run.mjs complete-raw (first 60 normalised chars of each gold turn), with two recorded fixes: evidence entries such as
"D8:6; D9:17" are split on ';', and a question with no scorable gold turn is dropped (it would pass every arm for free).
"""
import os
import collections, glob, json, math, random, re, sys
from pathlib import Path
# Data folder (LoCoMo copy, attribution sets): LITSAN_BENCH_DATA, default <repo>/.review-runtime (git-ignored).
DATA = os.environ.get('LITSAN_BENCH_DATA') or os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..', '.review-runtime'))

ROOT = Path(__file__).resolve().parents[4]
RT = ROOT / '.review-runtime'
LOCOMO = DATA + '/benchmarks/data/locomo10.json'
BUDGETS = {'Lean': 10000, 'Mid': 13000, 'Max': 17000}

qfile, suffix = sys.argv[1], sys.argv[2]
opt = dict(zip(sys.argv[3::2], sys.argv[4::2]))
BASE = opt.get('--base', 'N4200')
K = int(opt.get('--k', 80))
out_name = opt.get('--out', f'score-p7-{suffix}.json')


def norm(s): return re.sub(r'[^a-z0-9]+', ' ', s.lower().replace('\\n', ' ')).strip()


TURN = {}
for c in json.load(open(LOCOMO)):
    for k, v in c['conversation'].items():
        if re.fullmatch(r'session_\d+', k) and isinstance(v, list):
            for t in v: TURN[(c['sample_id'], t['dia_id'])] = norm(f"{t['speaker']}: {t['text']}")


def gold(r):
    ids = [d.strip() for e in r['evidence'] for d in e.split(';') if d.strip()]
    return [d for d in ids if (r['conv'], d) in TURN]


rows = [r for part in json.load(open(qfile)).values() for r in part]
rows = [r for r in rows if gold(r)]
n = len(rows)
convs = sorted({r['conv'] for r in rows})


def hits(text, r, cited=False):
    hay = norm(text)
    return [TURN[(r['conv'], d)][:60] in hay or (cited and f"l1:lc-{r['conv']}-{d.replace(':', '-')}" in text) for d in gold(r)]


# ---- load responses
files = {}
for sfx in suffix.split(','):  # several sweeps can be pooled: 's1,a1'
    for d in [RT / 'locomo-derived', *map(Path, glob.glob(str(RT / 'sweep-w*')))]:
        for f in glob.glob(str(d / f'responses-*-{sfx}.json')):
            name = Path(f).name[len('responses-'):-len(f'-{sfx}.json')]
            files[name] = f
if BASE not in files: sys.exit(f'baseline {BASE} not found; have {sorted(files)[:5]}')
texts, ms_of = {}, {}
for name, f in files.items():
    d = json.load(open(f))
    if not all(r['id'] in d for r in rows): continue
    texts[name] = {r['id']: d[r['id']]['text'] for r in rows}; ms_of[name] = [d[r['id']]['ms'] for r in rows]
done = {k: {'raw': [all(hits(t[r['id']], r)) for r in rows], 'any': [all(hits(t[r['id']], r, True)) for r in rows]} for k, t in texts.items()}
mbytes = {k: sum(len(t[r['id']].encode()) for r in rows) / n for k, t in texts.items()}


def mcnemar(g, l):
    m = g + l
    return 1.0 if m == 0 else min(1.0, 2 * sum(math.comb(m, i) for i in range(min(g, l) + 1)) / 2 ** m)


def cluster_ci(delta, reps=10000, seed=20261108):
    by = collections.defaultdict(list)
    for r, x in zip(rows, delta): by[r['conv']].append(x)
    cl = [(sum(v), len(v)) for v in by.values()]; rnd = random.Random(seed); out = []
    for _ in range(reps):
        s = c = 0
        for _ in cl:
            a, b = cl[rnd.randrange(len(cl))]; s += a; c += b
        out.append(100 * s / c)
    out.sort(); return [round(out[int(reps * 0.025)], 2), round(out[int(reps * 0.975)], 2)]


def paired(a, b, kind='raw'):
    x, y = done[a][kind], done[b][kind]
    delta = [int(q) - int(p) for p, q in zip(x, y)]
    g = sum(1 for d in delta if d > 0); l = sum(1 for d in delta if d < 0)
    return {'gained': g, 'lost': l, 'net': g - l, 'p': mcnemar(g, l), 'cluster95_pp': cluster_ci(delta)}


def holm(ps):
    order = sorted(range(len(ps)), key=lambda i: ps[i]); adj = [0.0] * len(ps); run = 0.0
    for rank, i in enumerate(order):
        run = max(run, min(1.0, (K - 1 - rank) * ps[i])); adj[i] = run
    return adj


def envelope(points):
    pts = sorted(points); env = []
    for b, v in pts:
        if not env or v > env[-1][1]: env.append((b, v))
    return env


def interp(env, b):
    if not env or b < env[0][0] or b > env[-1][0]: return None
    for (b0, v0), (b1, v1) in zip(env, env[1:]):
        if b0 <= b <= b1: return v0 + (v1 - v0) * (b - b0) / (b1 - b0) if b1 > b0 else v1
    return env[-1][1]


def pctl(xs, q): xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * q))]


def buckets(k):
    out = collections.defaultdict(lambda: [0, 0])
    for r, ok in zip(rows, done[k]['raw']):
        g = min(len(gold(r)), 3); out[f'gold{g}{"+" if g == 3 else ""}'][1] += 1; out[f'gold{g}{"+" if g == 3 else ""}'][0] += int(ok)
        out[f'cat{r["category"]}'][1] += 1; out[f'cat{r["category"]}'][0] += int(ok)
    return {a: b for a, b in sorted(out.items())}


res = {'n': n, 'suffix': suffix, 'base': BASE, 'k_declared': K, 'arms': {}}
names = sorted(texts, key=lambda k: mbytes[k])
for k in names:
    e = {'complete_raw': sum(done[k]['raw']), 'complete_raw_or_cited': sum(done[k]['any']), 'mean_bytes': round(mbytes[k]),
         'raw_recall': round(sum(sum(hits(texts[k][r['id']], r)) / len(gold(r)) for r in rows) / n, 4),
         'p50_ms': pctl(ms_of[k], 0.5), 'p95_ms': pctl(ms_of[k], 0.95), 'buckets': buckets(k)}
    if k != BASE: e['vs_base'] = paired(BASE, k)
    res['arms'][k] = e
ps = [res['arms'][k]['vs_base']['p'] for k in names if k != BASE]
for k, a in zip([k for k in names if k != BASE], holm(ps)): res['arms'][k]['vs_base']['p_holm'] = round(a, 5)
for k in names:
    if 'vs_base' in res['arms'][k]: res['arms'][k]['vs_base']['p'] = round(res['arms'][k]['vs_base']['p'], 5)

# frontier, excess over leave-one-out frontier, gain per KB
bb = res['arms'][BASE]; allpts = {k: (mbytes[k], sum(done[k]['raw'])) for k in names}
for k in names:
    env = envelope([v for kk, v in allpts.items() if kk != k]); e = res['arms'][k]; f = interp(env, mbytes[k])
    e['frontier_loo'] = None if f is None else round(f, 2); e['excess_over_frontier'] = None if f is None else round(e['complete_raw'] - f, 2)
    if k != BASE and mbytes[k] > mbytes[BASE]: e['gain_pp_per_extra_kb'] = round(100 * (e['complete_raw'] - bb['complete_raw']) / n / ((mbytes[k] - mbytes[BASE]) / 1000), 3)  # per question, so sets of different size compare
res['frontier'] = [{'arm': k, 'bytes': round(mbytes[k]), 'raw': v} for k, v in allpts.items() if v in envelope(list(allpts.values()))]

# operating-point picks (criteria: highest raw within budget; ties fewer bytes, then any, then simpler; harm <= 2)
picks = {}
for label, budget in BUDGETS.items():
    cand = [k for k in names if k != BASE and mbytes[k] <= budget and res['arms'][k]['vs_base']['lost'] <= 2]
    cand.sort(key=lambda k: (-res['arms'][k]['complete_raw'], mbytes[k], -res['arms'][k]['complete_raw_or_cited'], 0 if k.startswith('u-') else 1))
    picks[label] = {'arm': cand[0], 'budget': budget, **{x: res['arms'][cand[0]][x] for x in ('complete_raw', 'mean_bytes')}} if cand else None
res['picks'] = picks

# determinism (stage-1 N4200 vs stored P6 N4200w)
old = RT / 'locomo-derived' / f"responses-{opt.get('--det', 'N4200w-tp')}.json"
if old.exists():
    od = json.load(open(old)); strip = lambda t: re.sub(r'rt_[0-9a-f]{32}', 'rt_', t)
    same = sum(1 for r in rows if strip(od.get(r['id'], {}).get('text', '')) == strip(texts[BASE][r['id']]))
    res['determinism_vs_N4200w'] = {'identical': same, 'of': n}

# discordance of the best pick vs base, for power of the final set
if picks['Mid']:
    v = res['arms'][picks['Mid']['arm']]['vs_base']; res['discordance_mid'] = round((v['gained'] + v['lost']) / n, 4)

json.dump(res, open(RT / 'locomo-derived' / out_name, 'w'), indent=1)
print(f"n={n} base={BASE} raw={bb['complete_raw']} bytes={bb['mean_bytes']}  determinism={res.get('determinism_vs_N4200w')}")
print(f"{'arm':14}{'raw':>5}{'any':>5}{'bytes':>7}{'g/l':>8}{'p_holm':>9}{'cluster95pp':>16}{'exc':>7}{'pp/KB':>7}")
for k in names:
    e = res['arms'][k]; v = e.get('vs_base')
    print(f"{k:14}{e['complete_raw']:>5}{e['complete_raw_or_cited']:>5}{e['mean_bytes']:>7}" +
          (f"{str(v['gained']) + '/' + str(v['lost']):>8}{v['p_holm']:>9}{str(v['cluster95_pp']):>16}" if v else f"{'':>33}") +
          f"{e['excess_over_frontier'] if e['excess_over_frontier'] is not None else '':>7}{e.get('gain_pp_per_extra_kb', ''):>6}")
print('picks', json.dumps(picks))
