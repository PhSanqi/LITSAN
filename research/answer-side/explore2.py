"""POST HOC, written after seeing results2-main.json; not part of CRITERIA-2.md and changes no verdict.

Does a policy with no extra call — treat the answerer's own "Insufficient evidence" as abstention, then rank the rest
by its confidence — match the separate gate?
  R1  SC refusals withheld, rest ranked by confidence, cut at the gate's coverage k_G      vs  G (gate on A)
  R2  SC refusals withheld only (coverage = its own)                                       vs  gate ranking on A at that same coverage
  R3  gate AND no SC refusal on SC answers                                                 vs  G
Paired bootstrap as in analyze2.py (seed 20261108).
usage: python3 explore2.py   (writes explore2-main.json)
"""
import importlib.util, json
from pathlib import Path
HERE = Path(__file__).resolve().parent
import sys; sys.argv = [sys.argv[0], 'main']
spec = importlib.util.spec_from_file_location('analyze2', HERE / 'analyze2.py')
a2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(a2)
a1 = a2.a1


def main():
    res = json.loads((a2.RD / 'run2-main/results.json').read_text())
    rows = {r['id']: r for r in json.loads((HERE / 'sets2.json').read_text())['G3']}
    ans, gate, grades = res['answers'], res['gate'], res['grades']
    ids = [i for i in res['order'] if i in grades]
    jA = {i: grades[i]['A'] is True for i in ids}; jS = {i: grades[i]['SC'] is True for i in ids}
    suff = {i: gate[i].get('sufficient') is not False for i in ids}
    conf = {i: res['sc_confidence'][i] for i in ids}
    gc = {i: gate[i].get('confidence') if isinstance(gate[i].get('confidence'), (int, float)) else 50 for i in ids}
    gscore = {i: 100 + gc[i] if suff[i] else 100 - gc[i] for i in ids}
    ref = {i: bool(a2.SELF_ABSTAIN.search(ans['SC'][i])) for i in ids}

    def pol(s):
        p = list(range(len(s)))
        k = sum(suff[s[q]] for q in p)
        g = sum(jA[s[q]] for q in p if suff[s[q]]) / k
        r1s = {q: (0 if ref[s[q]] else 1000) + conf[s[q]] for q in p}  # refusals ranked last
        r1 = a2.sel_acc(p, r1s, {q: jS[s[q]] for q in p}, k)
        kr = sum(not ref[s[q]] for q in p)
        r2 = sum(jS[s[q]] for q in p if not ref[s[q]]) / kr
        g2 = a2.sel_acc(p, {q: gscore[s[q]] for q in p}, {q: jA[s[q]] for q in p}, kr)
        k3 = sum(suff[s[q]] and not ref[s[q]] for q in p)
        r3 = sum(jS[s[q]] for q in p if suff[s[q]] and not ref[s[q]]) / k3
        return {'k_gate': k, 'G': g, 'R1': r1, 'k_refusal': kr, 'R2': r2, 'gate_at_k_refusal': g2, 'k_R3': k3, 'R3': r3}
    base = pol(ids)
    out = {'note': 'post hoc; exploratory only', 'n': len(ids), **{k: round(v, 4) for k, v in base.items()}}
    for name, f in [('R1_minus_G', lambda r: r['R1'] - r['G']), ('R2_minus_gate_same_k', lambda r: r['R2'] - r['gate_at_k_refusal']), ('R3_minus_G', lambda r: r['R3'] - r['G'])]:
        out[name] = round(f(base), 4); out[name + '_ci'] = a2.boot(ids, lambda s: f(pol(s)))
    for ds in ('LongMemEval', 'LoCoMo'):
        v = [i for i in ids if rows[i]['dataset'] == ds]; b = pol(v)
        out[ds] = {k: round(x, 4) for k, x in b.items()}
    out['refusals'] = {'SC': sum(ref.values()), 'SC_refusal_correct': sum(jS[i] for i in ids if ref[i]),
                       'SC_refusals_gate_insufficient': sum(1 for i in ids if ref[i] and not suff[i]),
                       'gate_insufficient_not_refused': sum(1 for i in ids if not ref[i] and not suff[i]),
                       'abstention_questions': sum(1 for i in ids if rows[i].get('abstention'))}
    (HERE / 'explore2-main.json').write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
