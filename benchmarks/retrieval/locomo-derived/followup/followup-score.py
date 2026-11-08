"""P6 follow-up novelty: admission policies, scoring and paired statistics (P6-FOLLOWUP-NOVELTY-CRITERIA.md).
Usage: python3 followup-score.py <questions.json> <suffix> [--arms A-OV,B-OV,...] [--controls R1,R2,...] [--out name]
Reads  .review-runtime/locomo-derived/responses-<base>-<suffix>.json  (baseline N4200w and rungs R1..R5)
       .review-runtime/followup/plan-<A|B>-<suffix>.json              (planner output)
       .review-runtime/locomo-derived/fu-<A|B>-<suffix>.json          (follow-up litsan_context responses)
Writes .review-runtime/followup/score-<suffix>.json. No model call happens here; gold labels are used only for scoring."""
import os
import json, math, random, re, sys, collections
from pathlib import Path
# Data folder (LoCoMo copy, attribution sets): LITSAN_BENCH_DATA, default <repo>/.review-runtime (git-ignored).
DATA = os.environ.get('LITSAN_BENCH_DATA') or os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../..', '.review-runtime'))

ROOT = Path(__file__).resolve().parents[4]
LD = ROOT / '.review-runtime/locomo-derived'
FU = ROOT / '.review-runtime/followup'
LOCOMO = DATA + '/benchmarks/data/locomo10.json'
CAP = 2000
POLICIES = ['F0', 'C2K', 'OV', 'JA', 'OJ', 'MM']

qfile, suffix = sys.argv[1], sys.argv[2]
opt = dict(zip(sys.argv[3::2], sys.argv[4::2]))
arm_names = opt.get('--arms', ','.join(f'{p}-{k}' for p in 'AB' for k in POLICIES)).split(',')
rung_names = opt.get('--controls', 'R1,R2,R3,R4,R5').split(',')
out_name = opt.get('--out', f'score-{suffix}.json')
BASE = opt.get('--base', 'N4200w')


def norm(s): return re.sub(r'[^a-z0-9]+', ' ', s.lower().replace('\\n', ' ')).strip()


TURN = {}
for c in json.load(open(LOCOMO)):
    for k, v in c['conversation'].items():
        if re.fullmatch(r'session_\d+', k) and isinstance(v, list):
            for t in v: TURN[(c['sample_id'], t['dia_id'])] = norm(f"{t['speaker']}: {t['text']}")


def mcnemar(k, n): return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(k, n - k) + 1)) / 2 ** n)


def gold(r): return [d for d in r['evidence'] if (r['conv'], d) in TURN]


def gold_refs(r): return {f"l1:lc-{r['conv']}-{d.replace(':', '-')}" for d in gold(r)}


def raw_hits(text, r):
    hay = norm(text)
    return [TURN[(r['conv'], d)][:60] in hay for d in gold(r)]


def any_hits(text, r):
    return [h or f"l1:lc-{r['conv']}-{d.replace(':', '-')}" in text for h, d in zip(raw_hits(text, r), gold(r))]


def parse(text):
    d = json.loads(text)
    raw, facts = [], []
    for e in d.get('turnKnowledgePlan', {}).get('supporting', []):
        for p in e.get('passages', []):
            if e.get('id') == 'adaptive:raw-evidence' and p.get('evidence_ref'): raw.append({'ref': p['evidence_ref'], 'text': p['text']})
            elif p.get('fact_id'): facts.append({'id': p['fact_id'], 'text': p['text']})
    return raw, facts


def tokens(text, fact=False):
    t = re.sub(r'^\s*\[[^\]]*\]\s*', '', text)
    if fact: t = re.sub(r'^Atomic fact:\s*', '', t); t = re.sub(r'\s*\|\s*Evidence:.*$', '', t)
    return {w for w in re.findall(r'[a-z0-9]+', t.lower()) if len(w) > 1}


def jac(a, b):
    u = len(a | b)
    return len(a & b) / u if u else 0.0


def ubytes(u): return len(u['text'].encode()) + len((u.get('ref') or u.get('id')).encode())


def admit(policy, base, fups):
    """base = (raw, facts) of the first context; fups = [{'query', 'raw', 'facts'}]. Returns [(followup index, kind, unit)]."""
    braw, bfacts = base
    R, F = {u['ref'] for u in braw}, {u['id'] for u in bfacts}
    seen = [tokens(u['text']) for u in braw] + [tokens(u['text'], True) for u in bfacts]
    cap = None if policy == 'F0' else CAP
    chosen, used = [], 0
    overlap_gate = policy in ('OV', 'OJ')
    jac_filter = policy in ('JA', 'OJ')

    def fits(u): return cap is None or used + ubytes(u) <= cap

    if policy == 'MM':
        cands = []
        for i, f in enumerate(fups):
            for pos, u in enumerate(f['raw'] + f['facts']):
                kind = 'raw' if 'ref' in u else 'fact'
                if (kind == 'raw' and u['ref'] in R) or (kind == 'fact' and u['id'] in F): continue
                cands.append({'i': i, 'kind': kind, 'u': u, 'rel': 1.0 / (1 + pos), 'tok': tokens(u['text'], kind == 'fact')})
        picked = set()
        while True:
            best, best_s = None, 0.0
            for j, c in enumerate(cands):
                if j in picked: continue
                key = c['u'].get('ref') or c['u']['id']
                if key in {x[2].get('ref') or x[2].get('id') for x in chosen}: continue
                if not fits(c['u']): continue
                s = 0.5 * c['rel'] - 0.5 * max([jac(c['tok'], t) for t in seen] or [0.0])
                if s > best_s: best, best_s = j, s
            if best is None: break
            c = cands[best]; picked.add(best); chosen.append((c['i'], c['kind'], c['u'])); used += ubytes(c['u']); seen.append(c['tok'])
        return chosen
    for i, f in enumerate(fups):
        if overlap_gate and f['raw']:
            got = sum(1 for u in f['raw'] if u['ref'] in R or u['ref'] in {x[2].get('ref') for x in chosen})
            if got / len(f['raw']) > 0.5: continue
        for u in f['raw'] + f['facts']:
            kind = 'raw' if 'ref' in u else 'fact'
            if kind == 'raw' and (u['ref'] in R or u['ref'] in {x[2].get('ref') for x in chosen}): continue
            if kind == 'fact' and (u['id'] in F or u['id'] in {x[2].get('id') for x in chosen}): continue
            tok = tokens(u['text'], kind == 'fact')
            if jac_filter and max([jac(tok, t) for t in seen] or [0.0]) >= 0.6: continue
            if not fits(u): continue
            chosen.append((i, kind, u)); used += ubytes(u); seen.append(tok)
    return chosen


def compose(base_text, fups, chosen):
    if not chosen: return base_text
    blocks = collections.OrderedDict()
    for i, kind, u in chosen:
        blocks.setdefault(i, {'query': fups[i]['query'], 'passages': []})['passages'].append(
            {'evidence_ref': u['ref'], 'text': u['text']} if kind == 'raw' else {'fact_id': u['id'], 'text': u['text']})
    return base_text + '\n' + json.dumps({'followUpEvidence': list(blocks.values())}, ensure_ascii=False)


rows = [r for part in json.load(open(qfile)).values() for r in part if gold(r)]
base_resp = json.load(open(LD / f'responses-{BASE}-{suffix}.json'))
rows = [r for r in rows if r['id'] in base_resp]
n = len(rows)
rungs = {k: json.load(open(LD / f'responses-{k}-{suffix}.json')) for k in rung_names if (LD / f'responses-{k}-{suffix}.json').exists()}
plans, fus = {}, {}
for v in 'AB':
    if (FU / f'plan-{v}-{suffix}.json').exists(): plans[v] = json.load(open(FU / f'plan-{v}-{suffix}.json'))
    if (LD / f'fu-{v}-{suffix}.json').exists(): fus[v] = json.load(open(LD / f'fu-{v}-{suffix}.json'))

texts, meta = {BASE: {r['id']: base_resp[r['id']]['text'] for r in rows}}, {BASE: {}}
for k, resp in rungs.items():
    texts[k] = {r['id']: resp[r['id']]['text'] for r in rows if r['id'] in resp}
base_ms = {r['id']: base_resp[r['id']]['ms'] for r in rows}
ms_of = {BASE: base_ms, **{k: {i: v['ms'] for i, v in resp.items()} for k, resp in rungs.items()}}
meta = {k: {} for k in texts}
useful = collections.defaultdict(lambda: collections.Counter())
admitted_info = collections.defaultdict(lambda: collections.Counter())
for name in arm_names:
    v, pol = name.split('-')
    if v not in plans: continue
    texts[name], ms_of[name], meta[name] = {}, {}, {}
    for r in rows:
        base = parse(base_resp[r['id']]['text'])
        raw_fups = fus.get(v, {}).get(r['id'], [])
        fups = []
        for f in raw_fups:
            fr, ff = parse(f['text']); fups.append({'query': f['query'], 'raw': fr, 'facts': ff, 'ms': f['ms']})
        chosen = admit(pol, base, fups)
        texts[name][r['id']] = compose(base_resp[r['id']]['text'], fups, chosen)
        p = plans[v].get(r['id'], {})
        ms_of[name][r['id']] = base_ms[r['id']] + sum(f['ms'] for f in fups)
        meta[name][r['id']] = {'planner_ms': p.get('planner_ms', 0), 'model_calls': p.get('model_calls', 0), 'litsan_calls': 1 + len(fups),
                               'followups': len(fups), 'admitted_units': len(chosen), 'admitted_bytes': sum(ubytes(u) for _, _, u in chosen)}
        g = gold_refs(r); R0 = {u['ref'] for u in base[0]}
        newgold = {u['ref'] for _, k, u in chosen if k == 'raw' and u['ref'] in g and u['ref'] not in R0}
        ai = admitted_info[name]
        ai['admitted_raw'] += sum(1 for _, k, _u in chosen if k == 'raw'); ai['admitted_raw_gold'] += sum(1 for _, k, u in chosen if k == 'raw' and u['ref'] in g)
        ai['new_gold'] += len(newgold); ai['bytes'] += meta[name][r['id']]['admitted_bytes']
        if pol == 'F0':   # follow-up classes are policy independent; count them once per prompt
            for f in fups:
                refs = [u['ref'] for u in f['raw']]
                ov = sum(1 for x in refs if x in R0) / len(refs) if refs else 0.0
                ng = {x for x in refs if x in g and x not in R0}
                cls = 'useful' if ng else ('useless' if ov > 0.5 else 'neutral')
                useful[v][cls] += 1; useful[v]['followups'] += 1; useful[v]['overlap_sum'] += ov
            if fups: useful[v]['questions_with_followups'] += 1
            useful[v]['questions'] += 1


def complete(name, fn):
    return [all(fn(texts[name][r['id']], r)) for r in rows]


done = {k: {'raw': complete(k, raw_hits), 'any': complete(k, any_hits)} for k in texts}


def mean_bytes(k): return sum(len(texts[k][r['id']].encode()) for r in rows) / n


def paired(a, b, kind):
    x, y = done[a][kind], done[b][kind]
    g = sum(1 for p, q in zip(x, y) if not p and q); l = sum(1 for p, q in zip(x, y) if p and not q)
    d = (g - l) / n; se = math.sqrt(max(0.0, (g + l) / n - d * d) / n)
    rnd = random.Random(20261107); diffs = []
    delta = [int(q) - int(p) for p, q in zip(x, y)]
    for _ in range(10000): diffs.append(sum(delta[rnd.randrange(n)] for _ in range(n)) / n)
    diffs.sort()
    return {'base': sum(x), 'arm': sum(y), 'gained': g, 'lost': l, 'net': g - l, 'p': round(mcnemar(g, g + l), 5), 'diff_pp': round(100 * d, 2),
            'wald95_pp': [round(100 * (d - 1.96 * se), 2), round(100 * (d + 1.96 * se), 2)],
            'boot95_pp': [round(100 * diffs[250], 2), round(100 * diffs[9749], 2)]}


def pctl(xs, q): xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * q))] if xs else 0


result = {'n': n, 'suffix': suffix, 'arms': {}, 'controls': {}}
rung_bytes = {k: mean_bytes(k) for k in rungs if k in texts}
for k in texts:
    ms = [ms_of[k][r['id']] for r in rows if r['id'] in ms_of[k]]
    m = meta[k]
    entry = {'complete_raw': sum(done[k]['raw']), 'complete_raw_or_cited': sum(done[k]['any']),
             'raw_recall': round(sum(sum(raw_hits(texts[k][r['id']], r)) / len(gold(r)) for r in rows) / n, 4),
             'mean_bytes': round(mean_bytes(k)), 'p50_retrieval_ms': pctl(ms, 0.5), 'p95_retrieval_ms': pctl(ms, 0.95),
             'mean_retrieval_ms': round(sum(ms) / len(ms), 1)}
    if m:
        vals = list(m.values()); k_ = len(vals)
        entry.update({'mean_planner_ms': round(sum(x['planner_ms'] for x in vals) / k_), 'p95_planner_ms': pctl([x['planner_ms'] for x in vals], 0.95),
                      'model_calls_per_q': round(sum(x['model_calls'] for x in vals) / k_, 3),
                      'litsan_calls_per_q': round(sum(x['litsan_calls'] for x in vals) / k_, 3),
                      'share_with_followups': round(sum(1 for x in vals if x['followups']) / k_, 3),
                      'mean_admitted_units': round(sum(x['admitted_units'] for x in vals) / k_, 2),
                      'mean_admitted_bytes': round(sum(x['admitted_bytes'] for x in vals) / k_, 1)})
        ai = admitted_info[k]
        entry['admitted_raw_precision'] = round(ai['admitted_raw_gold'] / ai['admitted_raw'], 4) if ai['admitted_raw'] else None
        entry['new_gold_turns'] = ai['new_gold']
        entry['bytes_per_new_gold'] = round(ai['bytes'] / ai['new_gold']) if ai['new_gold'] else None
    (result['controls'] if k in rungs else result['arms'])[k] = entry
    if k != BASE:
        entry['vs_base_raw'] = paired(BASE, k, 'raw'); entry['vs_base_any'] = paired(BASE, k, 'any')
        if k not in rungs:
            ok = [(rb, rn) for rn, rb in rung_bytes.items() if rb >= mean_bytes(k)]
            if ok:
                rn = min(ok)[1]
                entry['matched_control'] = rn
                entry['vs_control_raw'] = paired(rn, k, 'raw'); entry['vs_control_any'] = paired(rn, k, 'any')
                cat = collections.Counter()
                for r, a, b in zip(rows, done[rn]['raw'], done[k]['raw']): cat[r['category']] += int(b) - int(a)
                entry['net_vs_control_by_category'] = dict(sorted(cat.items()))
            else:
                entry['matched_control'] = None
        cat = collections.Counter()
        for r, a, b in zip(rows, done[BASE]['raw'], done[k]['raw']): cat[r['category']] += int(b) - int(a)
        entry['net_vs_base_by_category'] = dict(sorted(cat.items()))
result['followup_classes'] = {v: {**dict(c), 'mean_overlap': round(c['overlap_sum'] / c['followups'], 3) if c['followups'] else None} for v, c in useful.items()}
result['plan_failures'] = {v: sum(1 for r in rows if not plans[v].get(r['id'], {}).get('ok', True)) for v in plans}
# eligibility (tuning selection rule)
elig = []
for name, e in result['arms'].items():
    c = e.get('vs_control_raw')
    if c and c['net'] >= 5 and c['p'] <= 0.05 and c['gained'] > c['lost']: elig.append((-c['net'], e['mean_bytes'], e['litsan_calls_per_q'], name))
result['eligible'] = [x[3] for x in sorted(elig)]
result['pick'] = result['eligible'][0] if result['eligible'] else None
json.dump(result, open(FU / out_name, 'w'), indent=1)
print(f"n={n} base raw={result['arms'][BASE]['complete_raw'] if BASE in result['arms'] else result['controls'].get(BASE)}")
hdr = f"{'arm':8} {'raw':>4} {'any':>4} {'bytes':>6} {'fu%':>5} {'adm_B':>6} {'vsBase g/l p':>16} {'ctl':>3} {'vsCtl g/l p':>16}"
print(hdr)
for name, e in {**result['controls'], **result['arms']}.items():
    b = e.get('vs_base_raw'); c = e.get('vs_control_raw')
    print(f"{name:8} {e['complete_raw']:>4} {e['complete_raw_or_cited']:>4} {e['mean_bytes']:>6} {e.get('share_with_followups', ''):>5} {e.get('mean_admitted_bytes', ''):>6} "
          f"{(str(b['gained']) + '/' + str(b['lost']) + ' ' + str(b['p'])) if b else '':>16} {e.get('matched_control', '') or '':>3} {(str(c['gained']) + '/' + str(c['lost']) + ' ' + str(c['p'])) if c else '':>16}")
print('classes', result['followup_classes'], 'eligible', result['eligible'], 'pick', result['pick'])
