"""Build the fixed contexts of experiment 2 with experiment 1's functions (written once, then reused).

usage: python3 contexts2.py   (writes .review-runtime/answer-side-20261107/contexts2.json)
"""
import hashlib, importlib.util, json
from pathlib import Path
# experiment 1's contexts.py itself imports multihop/fresh/contexts.py, so load ours under another name
spec = importlib.util.spec_from_file_location('exp1_contexts', Path(__file__).resolve().parent / 'contexts.py')
c1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(c1)
HERE, RD, CONFIGS, retrieval, render, rrf = c1.HERE, c1.RD, c1.CONFIGS, c1.retrieval, c1.render, c1.rrf

S2 = json.loads((HERE / 'sets2.json').read_text())
assert hashlib.sha256((HERE / 'sets2.json').read_bytes()).hexdigest() == (HERE / 'sets2.sha256').read_text().split()[0]


def main():
    out, evidence = {}, {}
    loc = [r for r in S2['G3'] if r['dataset'] == 'LoCoMo']
    convs, vectors = retrieval.load({r['id']: r['question'] for r in loc})
    for r in loc:
        ch, _ = convs[r['conv']].channels(r['question'], vectors[r['id']])
        out[r['id']], present = render(convs[r['conv']], rrf(ch, CONFIGS['text+records']))
        evidence[r['id']] = [sum(d in present for d in r['evidence']), len(r['evidence'])]
    c1.lme_contexts([r for r in S2['G3'] if r['dataset'] == 'LongMemEval'], out, evidence)
    (RD / 'contexts2.json').write_text(json.dumps({'contexts': out, 'evidence_in_context': evidence}, ensure_ascii=False))
    full = sum(1 for v in evidence.values() if v[1] and v[0] == v[1])
    print('contexts', len(out), 'complete evidence', full, '/', sum(1 for v in evidence.values() if v[1]),
          'mean bytes', round(sum(len(x.encode()) for x in out.values()) / len(out)))


if __name__ == '__main__':
    main()
