"""Score experiment 2 against CRITERIA-2.md; no model calls.

Primary   Δ = selective accuracy of S (SC answers, top-k_G by own confidence, fractional ties) − G (A answers the gate passes)
Secondary gate replication (experiment 1's H1), AURC gate-on-A vs confidence-on-SC, SC vs A unselected, SC calibration,
          descriptive per dataset / without self-refusals / gate applied to SC answers
usage: python3 analyze2.py smoke|main   (writes results2-<part>.json next to this file)
"""
import collections, hashlib, importlib.util, json, random, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
PART = sys.argv[1]
spec = importlib.util.spec_from_file_location('exp1_analyze', HERE / 'analyze.py')
a1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(a1)  # experiment 1's statistics, unchanged
RD, B, SELF_ABSTAIN = a1.RD, a1.B, a1.SELF_ABSTAIN
for name, path in [('CRITERIA-2.sha256', HERE / 'CRITERIA-2.md'), ('sets2.sha256', HERE / 'sets2.json')]:
    assert hashlib.sha256(path.read_bytes()).hexdigest() == (HERE / name).read_text().split()[0], path.name
SEED = 20261108


def correct_at(ids, score, correct):
    """Cumulative expected correct count at every coverage k = 1..n, ranking by score with ties broken uniformly at random."""
    groups = collections.defaultdict(list)
    for i in ids:
        groups[score[i]].append(correct[i])
    out, before = [], 0.0
    for s in sorted(groups, reverse=True):
        g = groups[s]; mean = sum(g) / len(g)
        out += [before + mean * j for j in range(1, len(g) + 1)]
        before += sum(g)
    return out


def sel_acc(ids, score, correct, k): return None if k == 0 else correct_at(ids, score, correct)[k - 1] / k


def aurc(ids, score, correct):
    c = correct_at(ids, score, correct)
    return sum(1 - x / k for k, x in enumerate(c, 1)) / len(c) if c else None


def boot(ids, stat):
    rng, vals = random.Random(SEED), []
    for _ in range(B):
        v = stat([ids[rng.randrange(len(ids))] for _ in ids])
        if v is not None: vals.append(v)
    vals.sort()
    return [round(vals[int(0.025 * len(vals))], 4), round(vals[int(0.975 * len(vals)) - 1], 4)] if vals else [None, None]


def compare(ids, suff, jA, jS, conf):
    """Policy G vs policy S at the gate's coverage; ids may repeat (bootstrap)."""
    def stats(s):
        k = sum(suff[i] for i in s)
        if k == 0: return None
        # duplicates in a resample are separate items, so rank positions rather than ids
        pos = list(range(len(s)))
        g = sum(jA[s[p]] for p in pos if suff[s[p]]) / k
        sa = sel_acc(pos, {p: conf[s[p]] for p in pos}, {p: jS[s[p]] for p in pos}, k)
        return k, g, sa
    k, g, sa = stats(ids)
    d = lambda s: (lambda r: None if r is None else r[2] - r[1])(stats(s))
    return {'n': len(ids), 'k_gate': k, 'coverage': round(k / len(ids), 4), 'G_selective_acc': round(g, 4), 'S_selective_acc': round(sa, 4),
            'delta': round(sa - g, 4), 'delta_ci': boot(ids, d),
            'A_unselected_acc': round(sum(jA[i] for i in ids) / len(ids), 4), 'SC_unselected_acc': round(sum(jS[i] for i in ids) / len(ids), 4)}


def ece(ids, conf, correct):
    bins = collections.defaultdict(list)
    for i in ids:
        bins[min(9, int(conf[i] // 10))].append(i)
    table = {f'{b * 10}-{b * 10 + 9 if b < 9 else 100}': {'n': len(v), 'mean_conf': round(sum(conf[i] for i in v) / len(v) / 100, 4), 'acc': round(sum(correct[i] for i in v) / len(v), 4)} for b, v in sorted(bins.items())}
    e = sum(len(v) / len(ids) * abs(sum(conf[i] for i in v) / len(v) / 100 - sum(correct[i] for i in v) / len(v)) for v in bins.values())
    return {'ece': round(e, 4), 'mean_conf': round(sum(conf[i] for i in ids) / len(ids) / 100, 4), 'acc': round(sum(correct[i] for i in ids) / len(ids), 4),
            'bins': table, 'distinct_values': dict(sorted(collections.Counter(conf[i] for i in ids).items()))}


def main():
    res = json.loads((RD / f'run2-{PART}/results.json').read_text())
    rows = {r['id']: r for r in (json.loads((HERE / 'sets.json').read_text())['S'] if PART == 'smoke' else json.loads((HERE / 'sets2.json').read_text())['G3'])}
    ans, gate, grades = res['answers'], res['gate'], res['grades']
    ids = [i for i in res['order'] if i in grades and all(isinstance(ans[a].get(i), str) for a in ('A', 'SC'))]
    out = {'part': PART, 'n_set': len(rows), 'n_scored': len(ids), 'missing': {k: len(v) for k, v in res['missing'].items()}, 'judge_errors': len(res['judge_errors']),
           'judge_uncertain': {a: sum(1 for i in ids if grades[i][a] is None) for a in ('A', 'SC')}}
    jA = {i: grades[i]['A'] is True for i in ids}; jS = {i: grades[i]['SC'] is True for i in ids}
    suff = {i: gate.get(i, {}).get('sufficient') is not False for i in ids}
    conf = {i: res['sc_confidence'].get(i) if isinstance(res['sc_confidence'].get(i), (int, float)) else 50 for i in ids}
    gconf = {i: gate.get(i, {}).get('confidence') if isinstance(gate.get(i, {}).get('confidence'), (int, float)) else 50 for i in ids}
    gscore = {i: 100 + gconf[i] if suff[i] else 100 - gconf[i] for i in ids}  # ADDENDUM-1 reading
    by = {ds: [i for i in ids if rows[i]['dataset'] == ds] for ds in ('LongMemEval', 'LoCoMo')}

    prim = compare(ids, suff, jA, jS, conf)
    out['primary'] = prim
    # Secondary 1: gate replication with experiment 1's H1 block
    out['gate_replication'] = {'all': a1.gate_block(ids, jA, suff), **{ds: a1.gate_block(v, jA, suff) for ds, v in by.items() if v}}
    # Secondary 2: AURC
    ag, asc = aurc(ids, gscore, jA), aurc(ids, conf, jS)
    out['aurc'] = {'gate_on_A': round(ag, 4), 'confidence_on_SC': round(asc, 4), 'random_A': round(1 - sum(jA.values()) / len(ids), 4), 'random_SC': round(1 - sum(jS.values()) / len(ids), 4),
                   'diff_conf_minus_gate': round(asc - ag, 4),
                   'diff_ci': boot(ids, lambda s: (lambda p: aurc(p, {q: conf[s[q]] for q in p}, {q: jS[s[q]] for q in p}) - aurc(p, {q: gscore[s[q]] for q in p}, {q: jA[s[q]] for q in p}))(list(range(len(s)))))}
    out['curves'] = {name: {f'{c}%': round(correct_at(ids, sc, cr)[max(1, round(len(ids) * c / 100)) - 1] / max(1, round(len(ids) * c / 100)), 4) for c in (50, 60, 70, 80, 90, 100)}
                     for name, sc, cr in (('gate_on_A', gscore, jA), ('confidence_on_SC', conf, jS))}
    # Secondary 3: cost of the field
    out['SC_vs_A_unselected'] = a1.paired(ids, jA, jS)
    # Secondary 4: calibration
    out['calibration_SC'] = ece(ids, conf, jS)
    # Secondary 5: descriptive
    desc = {ds: compare(v, suff, jA, jS, conf) for ds, v in by.items() if v and any(suff[i] for i in v)}
    selfab = {i: bool(SELF_ABSTAIN.search(ans['SC'][i])) for i in ids}
    k = prim['k_gate']
    nonself = [i for i in ids if not selfab[i]]
    desc['S_without_self_refusals'] = {'answerable_after_refusals': len(nonself),
                                       'selective_acc_at_k_gate': round(sel_acc(nonself, conf, jS, min(k, len(nonself))) or 0, 4),
                                       'self_refusals_SC': sum(selfab.values()), 'self_refusals_A': sum(1 for i in ids if SELF_ABSTAIN.search(ans['A'][i]))}
    desc['gate_on_SC_answers'] = a1.gate_block(ids, jS, suff)
    desc['confidence_given_gate'] = {f"gate_{'suff' if s else 'insuff'}": {'n': sum(1 for i in ids if suff[i] == s), 'mean_conf': round(sum(conf[i] for i in ids if suff[i] == s) / max(1, sum(1 for i in ids if suff[i] == s)), 2)} for s in (True, False)}
    desc['self_refusal_coverage'] = {'k': len(nonself), 'S_selacc_at_that_k': round(sel_acc(ids, conf, jS, len(nonself)) or 0, 4),
                                     'gate_on_A_selacc_at_that_k': round(sel_acc(ids, gscore, jA, len(nonself)) or 0, 4),
                                     'SC_own_refusal_selacc': round(sum(jS[i] for i in nonself) / max(1, len(nonself)), 4)}
    out['descriptive'] = desc
    # Verdict
    lo, hi = prim['delta_ci']
    sc_ok = out['SC_vs_A_unselected']['cand_correct'] >= out['SC_vs_A_unselected']['base_correct'] or out['SC_vs_A_unselected']['mcnemar_p'] >= 0.05
    adequate = lo is not None and lo > -0.03 and sc_ok
    verdict = ('INLINE BETTER' if adequate and lo > 0 else 'INLINE ADEQUATE' if adequate else 'GATE NEEDED' if hi is not None and hi < 0 else 'INCONCLUSIVE')
    gr = out['gate_replication']['all']
    out['conditions'] = {'delta_ci_lower>-0.03': lo is not None and lo > -0.03, 'SC_not_worse_than_A': sc_ok, 'delta_ci_lower>0': lo is not None and lo > 0, 'delta_ci_upper<0': hi is not None and hi < 0}
    out['verdict'] = verdict
    out['gate_replication_verdict'] = 'REPLICATED' if gr['fisher_p_one_sided'] < 0.05 and gr['delta_ci'][0] is not None and gr['delta_ci'][0] > 0 else 'NOT REPLICATED'
    (HERE / f'results2-{PART}.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
