"""Score the run against CRITERIA.md (+ ADDENDUM-1.md); no model calls.

Idea 1  gate on G: coverage, selective accuracy, Fisher H1/H1b, equal-cost McNemar,
        risk-coverage curve and AURC with bootstrap CIs, per dataset
Idea 2  rule on C: exact match R vs A (McNemar, bootstrap CI), C1/C2, A vs A2 noise floor,
        hedge rates, judge on C, harm check on non-count G questions
usage: python3 analyze.py smoke|main   (writes results-<part>.json next to this file)
"""
import os
import collections, hashlib, json, math, random, re, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
RT = Path(os.environ.get('LITSAN_BENCH_DATA') or Path(__file__).resolve().parents[2] / '.review-runtime')  # data folder, see REPORT.md
RD = RT / 'answer-side-20261107'
sys.path.insert(0, str(RT / 'attribution-20261106/multihop'))
from answer_layer_v4 import deterministic_grade

PART = sys.argv[1]
for name, path in [('CRITERIA.sha256', HERE / 'CRITERIA.md'), ('sets.sha256', HERE / 'sets.json'), ('ADDENDUM-1.sha256', HERE / 'ADDENDUM-1.md')]:
    assert hashlib.sha256(path.read_bytes()).hexdigest() == (HERE / name).read_text().split()[0], path.name
SELF_ABSTAIN = re.compile(r'insufficient evidence|not (mentioned|stated|specified|provided|enough)|no (information|record|mention)|cannot (be )?(determine|answer)|does not (say|mention|specify)', re.I)
HEDGE = re.compile(r'\bat least\b|\bor more\b|\bseveral\b|\ba few\b|\bmultiple\b|\bmore than\b|\bup to\b|\d+\s*(-|–|to)\s*\d+', re.I)
B = 10000


def mcnemar(k, n): return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(k, n - k) + 1)) / 2 ** n)


def binom_cdf(k, n, p): return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))


def clopper(k, n, a=0.05):
    if n == 0: return [None, None]
    def solve(f):
        lo, hi = 0.0, 1.0
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if f(mid) else (lo, mid)
        return round((lo + hi) / 2, 4)
    low = 0.0 if k == 0 else solve(lambda p: 1 - binom_cdf(k - 1, n, p) < a / 2)
    high = 1.0 if k == n else solve(lambda p: binom_cdf(k, n, p) > a / 2)
    return [low, high]


def fisher_greater(a, b, c, d):
    """One-sided P(X >= a) for the 2x2 table [[a, b], [c, d]] with fixed margins (a = answered & correct)."""
    r1, c1, n = a + b, a + c, a + b + c + d
    tot = math.comb(n, r1)
    return float(f'{sum(math.comb(c1, x) * math.comb(n - c1, r1 - x) for x in range(a, min(r1, c1) + 1)) / tot:.3g}') if n else 1.0


def boot(ids, stat, seed=20261107):
    rng, vals = random.Random(seed), []
    for _ in range(B):
        s = [ids[rng.randrange(len(ids))] for _ in ids]
        v = stat(s)
        if v is not None: vals.append(v)
    vals.sort()
    return [round(vals[int(0.025 * len(vals))], 4), round(vals[int(0.975 * len(vals)) - 1], 4)] if vals else [None, None]


def gate_block(ids, correct, suff):
    n = len(ids); ans = [i for i in ids if suff[i]]
    a = sum(correct[i] for i in ans); b = len(ans) - a
    c = sum(correct[i] for i in ids if not suff[i]); d = n - len(ans) - c

    def delta(s):
        an = [i for i in s if suff[i]]
        return None if not an else sum(correct[i] for i in an) / len(an) - sum(correct[i] for i in s) / len(s)
    return {'n': n, 'answered': len(ans), 'coverage': round(len(ans) / n, 4) if n else None,
            'overall_correct': a + c, 'overall_acc': round((a + c) / n, 4) if n else None, 'overall_acc_ci': clopper(a + c, n),
            'selective_correct': a, 'selective_acc': round(a / len(ans), 4) if ans else None, 'selective_acc_ci': clopper(a, len(ans)),
            'abstained_correct': c, 'abstained_not_correct': d,
            'acc_when_insufficient': round(c / (c + d), 4) if c + d else None,
            'delta': round(a / len(ans) - (a + c) / n, 4) if ans and n else None, 'delta_ci': boot(ids, delta) if n else [None, None],
            'fisher_p_one_sided': fisher_greater(a, b, c, d),
            'equal_cost_mcnemar': {'improved_abstained_not_correct': d, 'regressed_abstained_correct': c, 'p': round(mcnemar(min(c, d), c + d), 6)}}


def curve(ids, correct, score, tie):
    order = sorted(ids, key=lambda i: (-score[i], tie[i]))
    acc, run = [], 0
    for k, i in enumerate(order, 1):
        run += correct[i]; acc.append(run / k)
    n = len(order)
    pts = {f'{c}%': round(acc[max(1, round(n * c / 100)) - 1], 4) for c in (50, 60, 70, 80, 90, 100)} if n else {}
    aurc = sum(1 - x for x in acc) / n if n else None
    return pts, aurc


def risk_block(ids, correct, score, tie):
    if not ids:
        return None
    pts, aurc = curve(ids, correct, score, tie)
    base = 1 - sum(correct[i] for i in ids) / len(ids)

    def gap(s):
        _, a = curve(s, correct, score, tie)
        return (1 - sum(correct[i] for i in s) / len(s)) - a
    return {'selective_acc_at_coverage': pts, 'aurc': round(aurc, 4), 'random_aurc': round(base, 4), 'aurc_gain': round(base - aurc, 4), 'aurc_gain_ci': boot(ids, gap)}


def paired(ids, x, y):
    """x, y: id -> bool; returns R-vs-A style paired table (y is the candidate)."""
    wc = sum(1 for i in ids if not x[i] and y[i]); cw = sum(1 for i in ids if x[i] and not y[i])
    return {'n': len(ids), 'base_correct': sum(x[i] for i in ids), 'cand_correct': sum(y[i] for i in ids), 'W->C': wc, 'C->W': cw,
            'mcnemar_p': round(mcnemar(min(wc, cw), wc + cw), 6),
            'diff': round((sum(y[i] for i in ids) - sum(x[i] for i in ids)) / len(ids), 4) if ids else None,
            'diff_ci': boot(ids, lambda s: (sum(y[i] for i in s) - sum(x[i] for i in s)) / len(s)) if ids else [None, None]}


def main():
    S = json.loads((HERE / 'sets.json').read_text())
    res = json.loads((RD / f'run-{PART}/results.json').read_text())
    ev = json.loads((RD / 'contexts.json').read_text())['evidence_in_context']
    ans, gate, grades = res['answers'], res['gate'], res['grades']
    G = S['S'] if PART == 'smoke' else S['G']
    C2 = [] if PART == 'smoke' else S['C2']
    rows = {r['id']: r for r in G + C2}
    C1 = [r['id'] for r in G if r['count']] if PART == 'smoke' else S['C1']
    out = {'part': PART, 'missing': {k: len(v) for k, v in res['missing'].items()}, 'judge_errors': len(res['judge_errors'])}
    jc = {arm: {i: grades.get(i, {}).get(arm) is True for i in rows} for arm in ('A', 'R')}
    unc = {arm: sum(1 for i in rows if i in grades and grades[i][arm] is None) for arm in ('A', 'R')}
    out['judge_uncertain'] = unc

    # Idea 1
    gid = [r['id'] for r in G if r['id'] in grades and isinstance(ans['A'].get(r['id']), str)]
    suff = {i: gate.get(i, {}).get('sufficient') is not False for i in gid}  # missing verdict = answer
    out['gate_missing_verdicts'] = sum(1 for i in gid if not isinstance(gate.get(i, {}).get('sufficient'), bool))
    rng = random.Random(20261107); tie = {i: rng.random() for i in sorted(gid)}
    conf = {i: gate.get(i, {}).get('confidence') if isinstance(gate.get(i, {}).get('confidence'), (int, float)) else 50 for i in gid}
    score = {i: 100 + conf[i] if suff[i] else 100 - conf[i] for i in gid}
    alt = {i: 100 + conf[i] if suff[i] else conf[i] for i in gid}
    i1 = {'all': gate_block(gid, jc['A'], suff)}
    for ds in ('LongMemEval', 'LoCoMo'):
        i1[ds] = gate_block([i for i in gid if rows[i]['dataset'] == ds], jc['A'], suff)
    nonself = [i for i in gid if not SELF_ABSTAIN.search(ans['A'][i])]
    i1['H1b_not_self_abstained'] = gate_block(nonself, jc['A'], suff)
    i1['risk_coverage'] = {'all': risk_block(gid, jc['A'], score, tie), 'alt_reading': risk_block(gid, jc['A'], alt, tie)}
    for ds in ('LongMemEval', 'LoCoMo'):
        i1['risk_coverage'][ds] = risk_block([i for i in gid if rows[i]['dataset'] == ds], jc['A'], score, tie)
    selfab = {i: not SELF_ABSTAIN.search(ans['A'][i]) for i in gid}
    i1['self_abstention_only'] = gate_block(gid, jc['A'], selfab)
    i1['gate_or_self'] = gate_block(gid, jc['A'], {i: suff[i] and selfab[i] for i in gid})
    i1['gate_on_R_answers'] = gate_block(gid, jc['R'], suff)
    comp = {i: bool(ev[i][1]) and ev[i][0] == ev[i][1] for i in gid if ev.get(i) and ev[i][1]}
    i1['gate_vs_complete_gold_evidence'] = dict(collections.Counter(f"{'suff' if suff[i] else 'insuff'}|{'complete' if comp[i] else 'incomplete'}" for i in comp))
    i1['abstention_questions'] = {'n': sum(1 for i in gid if rows[i].get('abstention')), 'gate_insufficient': sum(1 for i in gid if rows[i].get('abstention') and not suff[i]),
                                  'A_correct': sum(1 for i in gid if rows[i].get('abstention') and jc['A'][i])}
    # Descriptive only (not in the verdict): the gate vs the answerer's own refusals at matched coverage, and without uncertain grades.
    k_self = sum(selfab.values())
    ranked = sorted(gid, key=lambda i: (-score[i], tie[i]))
    both = sorted(gid, key=lambda i: (not selfab[i], -score[i], tie[i]))
    i1['descriptive'] = {
        'self_abstention_coverage': k_self, 'self_abstention_selective_acc': round(sum(jc['A'][i] for i in gid if selfab[i]) / k_self, 4),
        'gate_ranking_at_same_coverage': round(sum(jc['A'][i] for i in ranked[:k_self]) / k_self, 4),
        'self_then_gate_at_77pct': round(sum(jc['A'][i] for i in both[:231]) / 231, 4) if len(gid) >= 231 else None,
        'uncertain_excluded': gate_block([i for i in gid if grades[i]['A'] is not None], jc['A'], suff)}
    a = i1['all']; lme_d, loc_d = i1['LongMemEval']['delta'], i1['LoCoMo']['delta']
    conds = {'H1_p<0.05': a['fisher_p_one_sided'] < 0.05, 'delta_ci_excludes_0': a['delta_ci'][0] is not None and a['delta_ci'][0] > 0,
             'delta>0_both_datasets': bool(lme_d and lme_d > 0 and loc_d and loc_d > 0), 'coverage_50_95': a['coverage'] is not None and 0.5 <= a['coverage'] <= 0.95,
             'H1b_p<0.05': i1['H1b_not_self_abstained']['fisher_p_one_sided'] < 0.05}
    verdict = 'VALIDATED' if all(conds.values()) else 'PROMISING' if conds['H1_p<0.05'] or (a['fisher_p_one_sided'] < 0.2 and (a['delta'] or 0) > 0) else 'FAILED'
    i1['conditions'], i1['verdict'] = conds, verdict
    out['idea1_gate'] = i1

    # Idea 2
    cids = [i for i in C1 + [r['id'] for r in C2] if i in rows]
    det = {arm: {i: deterministic_grade(rows[i]['question'], rows[i]['gold'], ans[arm].get(i) or '') for i in cids} for arm in ('A', 'A2', 'R')}
    gradable = [i for i in cids if det['A'][i] is not None and det['R'][i] is not None and isinstance(ans['A'].get(i), str) and isinstance(ans['R'].get(i), str)]
    ex = {arm: {i: det[arm][i] is True for i in cids} for arm in det}
    i2 = {'C_n': len(cids), 'gradable': len(gradable), 'ungradable': len(cids) - len(gradable)}
    i2['primary_exact_R_vs_A'] = paired(gradable, ex['A'], ex['R'])
    c1s = set(C1)
    i2['C1_exact'] = paired([i for i in gradable if i in c1s], ex['A'], ex['R'])
    i2['C2_exact'] = paired([i for i in gradable if i not in c1s], ex['A'], ex['R'])
    g2 = [i for i in gradable if det['A2'][i] is not None and isinstance(ans['A2'].get(i), str)]
    i2['noise_floor_exact_A2_vs_A'] = paired(g2, ex['A'], ex['A2'])
    i2['hedge_rate'] = {arm: {'hedged': sum(1 for i in cids if HEDGE.search(ans[arm].get(i) or '')), 'n': sum(1 for i in cids if isinstance(ans[arm].get(i), str))} for arm in ('A', 'A2', 'R')}
    i2['hedged_A_outcomes'] = dict(collections.Counter(f"A={'C' if ex['A'][i] else 'W'} R={'C' if ex['R'][i] else 'W'} R_hedged={bool(HEDGE.search(ans['R'].get(i) or ''))}" for i in gradable if HEDGE.search(ans['A'].get(i) or '')))
    jcid = [i for i in cids if i in grades]
    i2['judge_on_C'] = paired(jcid, jc['A'], jc['R'])
    noncount = [r['id'] for r in G if not r['count'] and r['id'] in grades]
    i2['harm_judge_noncount_G'] = paired(noncount, jc['A'], jc['R'])
    for ds in ('LongMemEval', 'LoCoMo'):
        i2[f'harm_judge_noncount_{ds}'] = paired([i for i in noncount if rows[i]['dataset'] == ds], jc['A'], jc['R'])
    i2['judge_all_G_plus_C2'] = paired([i for i in rows if i in grades], jc['A'], jc['R'])
    p = i2['primary_exact_R_vs_A']
    harm = any(t['cand_correct'] < t['base_correct'] and t['mcnemar_p'] < 0.05 for t in (i2['harm_judge_noncount_G'], i2['judge_on_C']))
    hedge_falls = i2['hedge_rate']['R']['hedged'] < i2['hedge_rate']['A']['hedged']
    conds2 = {'primary_R>A': p['cand_correct'] > p['base_correct'], 'primary_p<0.05': p['mcnemar_p'] < 0.05,
              'R>=A_C1_and_C2': i2['C1_exact']['cand_correct'] >= i2['C1_exact']['base_correct'] and i2['C2_exact']['cand_correct'] >= i2['C2_exact']['base_correct'],
              'no_harm': not harm, 'hedge_rate_falls': hedge_falls}
    v2 = ('VALIDATED' if conds2['primary_R>A'] and conds2['primary_p<0.05'] and conds2['R>=A_C1_and_C2'] and not harm
          else 'PROMISING' if conds2['primary_R>A'] and hedge_falls and not harm else 'FAILED')
    i2['conditions'], i2['verdict'] = conds2, v2
    out['idea2_rule'] = i2
    (HERE / f'results-{PART}.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
