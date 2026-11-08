#!/usr/bin/env python3
"""P7 verdicts (criteria 'Final check'). usage: final.py <score-tuning.json> <score-final.json> [out.json]
Both score files come from analyze.py (final run with --k 4: Holm over the three picks, K-1 = 3)."""
import json, sys
tun, fin = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
out = {'n_final': fin['n'], 'picks': {}}
labels = [l for l, p in tun['picks'].items() if p and p['arm'] in fin['arms']]
raw_p = {l: fin['arms'][tun['picks'][l]['arm']]['vs_base']['p'] for l in labels}
order = sorted(labels, key=lambda l: raw_p[l]); holm_p = {}; run = 0.0   # Holm over the three picks only (R4 is a reference, not a pick)
for rank, l in enumerate(order): run = max(run, min(1.0, (len(order) - rank) * raw_p[l])); holm_p[l] = run
for label, p in tun['picks'].items():
    if not p: out['picks'][label] = {'verdict': 'no pick'}; continue
    a = p['arm']; t = tun['arms'][a]; f = fin['arms'].get(a)
    if not f: out['picks'][label] = {'arm': a, 'verdict': 'not run'}; continue
    v = f['vs_base']; budget = p['budget']
    gain_t = t.get('gain_pp_per_extra_kb'); gain_f = f.get('gain_pp_per_extra_kb')
    checks = {'p_holm<=0.01': holm_p[label] <= 0.01, 'cluster_ci_above_0': v['cluster95_pp'][0] > 0, 'bytes_in_budget': f['mean_bytes'] <= budget,
              'harm_ok': v['lost'] <= max(2, 0.1 * v['gained']), 'gain_per_kb>=half_tuning': gain_t is not None and gain_f is not None and gain_f >= 0.5 * gain_t}
    if all(checks.values()): verdict = 'validated'
    elif v['p'] <= 0.05 and v['net'] > 0 and f['mean_bytes'] <= budget: verdict = 'promising'
    else: verdict = 'failed'
    out['picks'][label] = {'arm': a, 'verdict': verdict, 'checks': checks, 'final': {k: f[k] for k in ('complete_raw', 'mean_bytes')}, 'base': fin['arms'][fin['base']]['complete_raw'],
                           'vs_base': v, 'p_holm_picks': holm_p[label], 'tuning_raw': p['complete_raw'], 'gain_per_kb_tuning': gain_t, 'gain_per_kb_final': gain_f}
vs = [x['verdict'] for x in out['picks'].values()]
below = any(x.get('vs_base', {}).get('net', 0) < 0 for x in out['picks'].values())
out['overall'] = 'failed' if below or not vs else next(c for c in ('validated', 'promising', 'failed') if c in vs)
json.dump(out, open(sys.argv[3] if len(sys.argv) > 3 else 'verdict-p7.json', 'w'), indent=1)
print(json.dumps(out, indent=1))
