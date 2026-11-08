"""Freeze the question set of CRITERIA-2.md §1 (no model calls).

G3  70 LongMemEval dev questions (seed 20261110) from those no run has used at any level
    + 150 LoCoMo confirm questions (seed 20261111) that experiment 1 did not use
usage: python3 freeze_sets2.py
"""
import collections, hashlib, json, os, random, re
from pathlib import Path
HERE = Path(__file__).resolve().parent
RT = Path(os.environ.get('LITSAN_BENCH_DATA') or Path(__file__).resolve().parents[2] / '.review-runtime')  # data folder, see REPORT.md
ATT = RT / 'attribution-20261106'
TYPED = RT / 'typed-graph-worktree-20261107/research/typed-graph'
SIGNAL = Path(__file__).resolve().parents[2] / 'benchmarks/retrieval/locomo-derived/sets/signal-set.json'
for name, path in [('CRITERIA-2.sha256', HERE / 'CRITERIA-2.md'), ('sets.sha256', HERE / 'sets.json')]:
    assert hashlib.sha256(path.read_bytes()).hexdigest() == (HERE / name).read_text().split()[0], path.name


def is_count(q): return bool(re.match(r'how many\b', q.lower().strip()))


split = json.loads((ATT / 'frozen-split.json').read_text())
lme = {q['question_id']: q for q in json.loads((RT / 'benchmarks/data/longmemeval_s_cleaned.json').read_text())}
fresh = json.loads((ATT / 'multihop/fresh/fresh-set.json').read_text())
S1 = json.loads((HERE / 'sets.json').read_text())
exp1 = {r['id'] for r in S1['G'] + S1['C2'] + S1['S']}
used = {r['id'] for p in ('tune', 'frozen') for r in fresh[p]} | set((ATT / 'used-ids.txt').read_text().split()) | exp1
typed = set()
for dp, _, fn in os.walk(TYPED):
    if '/.git' in dp or 'node_modules' in dp:
        continue
    for f in fn:
        if f.endswith(('.json', '.jsonl', '.txt', '.md')) and f not in ('frozen-split.json', 'fresh-set.json'):  # copies of the master lists, not usage
            typed |= set(re.findall(r'LongMemEval:[\w-]+', Path(dp, f).read_text(errors='ignore')))
pool = sorted(c for c in split['dev']['LongMemEval'] if c not in used and c not in typed)
assert len(pool) == 93, len(pool)
G3 = []
for cid in random.Random(20261110).sample(pool, 70):
    q = lme[cid.split(':', 1)[1]]
    G3.append({'id': cid, 'dataset': 'LongMemEval', 'qtype': q['question_type'], 'question': q['question'], 'gold': str(q['answer']),
               'question_date': q['question_date'], 'abstention': cid.endswith('_abs'), 'count': is_count(q['question'])})
conf = sorted((r for r in json.loads(SIGNAL.read_text())['confirm'] if r['id'] not in exp1), key=lambda r: r['id'])
assert len(conf) == 318
for r in random.Random(20261111).sample(conf, 150):
    G3.append({'id': r['id'], 'dataset': 'LoCoMo', 'conv': r['conv'], 'category': r['category'], 'question': r['question'],
               'gold': str(r['gold']), 'evidence': r['evidence'], 'count': is_count(r['question'])})
assert len({r['id'] for r in G3}) == 220 and not ({r['id'] for r in G3} & used)
out = {'seeds': {'G3_lme': 20261110, 'G3_locomo': 20261111}, 'G3': G3}
body = json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True)
(HERE / 'sets2.json').write_text(body)
(HERE / 'sets2.sha256').write_text(hashlib.sha256(body.encode()).hexdigest() + '  sets2.json\n')
print('G3', len(G3), dict(collections.Counter(r['dataset'] for r in G3)),
      'LME qtypes', dict(collections.Counter(r.get('qtype') for r in G3 if r['dataset'] == 'LongMemEval')),
      'LoCoMo cats', dict(collections.Counter(r.get('category') for r in G3 if r['dataset'] == 'LoCoMo')))
