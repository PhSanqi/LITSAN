"""Freeze the question sets of CRITERIA.md §1 (no model calls).

G   all 150 LongMemEval holdout questions of frozen-split.json + 150 LoCoMo questions
    sampled (seed 20261108) from signal-set.json confirm
C1  questions in G that start with "how many"
C2  the 95 LongMemEval count questions of fresh/fresh-set.json frozen
S   8 LongMemEval dev questions unused by any set (smoke only)
usage: python3 freeze_sets.py
"""
import os
import collections, hashlib, json, random, re
from pathlib import Path
HERE = Path(__file__).resolve().parent
RT = Path(os.environ.get('LITSAN_BENCH_DATA') or Path(__file__).resolve().parents[2] / '.review-runtime')  # data folder, see REPORT.md
ATT = RT / 'attribution-20261106'
SIGNAL = Path(__file__).resolve().parents[2] / 'benchmarks/retrieval/locomo-derived/sets/signal-set.json'
WANT = {ATT / 'frozen-split.json': '73091fe99097e06a8879aac9346da0fc92069a24bd239a645f0f3da03162dcc9',
        ATT / 'multihop/fresh/fresh-set.json': '578c0661e6691c446e36ff76748fcd1db0d56a3139f75d367e1939777696e7a4'}
for p, h in WANT.items():
    assert hashlib.sha256(p.read_bytes()).hexdigest() == h, p


def is_count(q): return bool(re.match(r'how many\b', q.lower().strip()))


split = json.loads((ATT / 'frozen-split.json').read_text())
lme = {q['question_id']: q for q in json.loads((RT / 'benchmarks/data/longmemeval_s_cleaned.json').read_text())}


def lme_row(cid):
    q = lme[cid.split(':', 1)[1]]
    return {'id': cid, 'dataset': 'LongMemEval', 'qtype': q['question_type'], 'question': q['question'], 'gold': str(q['answer']),
            'question_date': q['question_date'], 'abstention': cid.endswith('_abs'), 'count': is_count(q['question'])}


G = [lme_row(c) for c in split['holdout']['LongMemEval']]
sig = json.loads(SIGNAL.read_text())['confirm']
for r in random.Random(20261108).sample(sorted(sig, key=lambda r: r['id']), 150):
    G.append({'id': r['id'], 'dataset': 'LoCoMo', 'conv': r['conv'], 'category': r['category'], 'question': r['question'],
              'gold': str(r['gold']), 'evidence': r['evidence'], 'count': is_count(r['question'])})
fresh = json.loads((ATT / 'multihop/fresh/fresh-set.json').read_text())
C2 = [{**{k: r[k] for k in ('id', 'dataset', 'qtype', 'question', 'gold', 'question_date', 'abstention')}, 'count': True}
      for r in fresh['frozen'] if r['dataset'] == 'LongMemEval' and r['kind'] == 'count']
assert len(C2) == 95
used = {r['id'] for p in ('tune', 'frozen') for r in fresh[p]} | set((ATT / 'used-ids.txt').read_text().split())
pool = sorted(c for c in split['dev']['LongMemEval'] if c not in used)
S = [lme_row(c) for c in random.Random(20261109).sample(pool, 8)]
assert not ({r['id'] for r in G} & {r['id'] for r in C2}) and not ({r['id'] for r in S} & ({r['id'] for r in G} | {r['id'] for r in C2}))
out = {'seeds': {'G_locomo': 20261108, 'S': 20261109}, 'G': G, 'C1': [r['id'] for r in G if r['count']], 'C2': C2, 'S': S}
body = json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True)
(HERE / 'sets.json').write_text(body)
(HERE / 'sets.sha256').write_text(hashlib.sha256(body.encode()).hexdigest() + '  sets.json\n')
print('G', len(G), dict(collections.Counter(r['dataset'] for r in G)), 'C1', len(out['C1']), 'C2', len(C2), 'S', len(S))
print('G LME qtypes', dict(collections.Counter(r.get('qtype') for r in G if r['dataset'] == 'LongMemEval')), 'LoCoMo cats', dict(collections.Counter(r.get('category') for r in G if r['dataset'] == 'LoCoMo')))
