"""Run the arms of CRITERIA.md on the fixed contexts (model calls; results are cached).

A   plain contract           on G + C2
R   plain contract + rule    on G + C2
A2  plain contract again     on every batch that holds a C question (noise floor)
gate sufficiency verdict     on G (sees question + context only)
judge memory-judge-v4        on A and R answers of G + C2
The gate prompt and the rule line are read verbatim from CRITERIA.md, whose hash is checked.
usage: python3 run.py smoke|main
"""
import os
import concurrent.futures, hashlib, json, random, re, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
RT = Path(os.environ.get('LITSAN_BENCH_DATA') or Path(__file__).resolve().parents[2] / '.review-runtime')  # data folder, see REPORT.md
RD = RT / 'answer-side-20261107'
PART = sys.argv[1]
for name, path in [('CRITERIA.sha256', HERE / 'CRITERIA.md'), ('sets.sha256', HERE / 'sets.json')]:
    assert hashlib.sha256(path.read_bytes()).hexdigest() == (HERE / name).read_text().split()[0], f'{path.name} changed after freezing'
RUN = RT / 'gnn-core-worktree-20261104/.review-runtime/demand-repair-20261104'
sys.path.insert(0, str(RT / 'gnn-core-worktree-20261104/scripts'))
from memory_eval_calls import cached_call
from memory_judge import judge_pairs, fingerprint

cal = json.loads((RT / 'gnn-core-worktree-20261104/.review-runtime/judge-batch-check-20261106/calibration/judge-calibration.json').read_text())
assert cal['passed'] and cal['judge_fingerprint'] == fingerprint(), 'current judge is not the calibrated one'
GATE_PROMPT, RULE = re.findall(r'```text\n(.*?)\n```', (HERE / 'CRITERIA.md').read_text(), re.S)
assert GATE_PROMPT.startswith('You check retrieved memory context') and RULE.startswith('Count rule')
CONTRACT = (RUN / 'memory-answer-contract.txt').read_text() + '\n' + (RUN / 'progressive-answer-guidance.txt').read_text()
ARMS = {'A': CONTRACT, 'A2': CONTRACT, 'R': CONTRACT.rstrip('\n') + '\n' + RULE + '\n'}
ROOT = RD / f'run-{PART}'
(ROOT / 'work').mkdir(parents=True, exist_ok=True)
ns = {'__file__': str(ROOT / 'run.py')}
exec(compile((RUN / 'cli-helper.py').read_text(), '<frozen-cli-helper>', 'exec'), ns)
def call(tag, prompt): return cached_call(ns['uncached_call'], ROOT, tag, prompt)


def ask(tag, prompt, ids):
    for attempt in range(2):
        try:
            res = call(tag + ('-retry' if attempt else ''), prompt + ('' if not attempt else '\nReturn exactly one object per case, using exactly these ids: ' + json.dumps(ids)))
            if isinstance(res, list) and {x.get('id') for x in res if isinstance(x, dict)} == set(ids):
                return {x['id']: x for x in res}
        except Exception as e:
            print('call failure', tag, attempt, e, flush=True)
    return {}


def main():
    S = json.loads((HERE / 'sets.json').read_text())
    ctx = json.loads((RD / 'contexts.json').read_text())['contexts']
    if PART == 'smoke':
        rows, gate_ids, c_ids = S['S'], {r['id'] for r in S['S']}, {r['id'] for r in S['S']}
    else:
        rows = S['G'] + S['C2']
        gate_ids = {r['id'] for r in S['G']}
        c_ids = set(S['C1']) | {r['id'] for r in S['C2']}
    rng = random.Random(20261107)
    first = sorted((r for r in rows if r['id'] in c_ids), key=lambda r: r['id']); rest = sorted((r for r in rows if r['id'] not in c_ids), key=lambda r: r['id'])
    rng.shuffle(first); rng.shuffle(rest)
    order = first + rest  # count questions first, so A, A2 and R share identical batches
    batches = [order[i:i + 4] for i in range(0, len(order), 4)]
    gate_rows = [r for r in order if r['id'] in gate_ids]
    jobs = [(arm, i, b) for arm in ('A', 'R') for i, b in enumerate(batches)]
    jobs += [('A2', i, b) for i, b in enumerate(batches) if any(r['id'] in c_ids for r in b)]
    jobs += [('gate', i, gate_rows[i:i + 4]) for i in range(0, len(gate_rows), 4)]

    def run(job):
        kind, i, b = job
        payload = json.dumps([{'id': r['id'], 'question': r['question'], 'context': ctx[r['id']]} for r in b], ensure_ascii=False)
        prompt = (GATE_PROMPT if kind == 'gate' else ARMS[kind]) + '\n' + payload
        return kind, ask(f'{kind}-{i:03d}', prompt, [r['id'] for r in b])
    got = {k: {} for k in ('A', 'A2', 'R', 'gate')}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for n, (kind, res) in enumerate(pool.map(run, jobs)):
            got[kind].update(res)
            if n % 20 == 0:
                print('progress', n, '/', len(jobs), flush=True)
    answers = {arm: {k: v.get('answer') for k, v in got[arm].items()} for arm in ('A', 'A2', 'R')}
    gate = {k: {'sufficient': v.get('sufficient'), 'confidence': v.get('confidence'), 'missing': v.get('missing')} for k, v in got['gate'].items()}
    good = [{**r, 'before_answer': answers['A'].get(r['id']), 'candidate_answer': answers['R'].get(r['id'])} for r in order
            if isinstance(answers['A'].get(r['id']), str) and isinstance(answers['R'].get(r['id']), str)]
    grades, errors = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for res in pool.map(lambda ib: judge_pairs(call, ib[1], f'judge-{ib[0]:03d}', {}), list(enumerate(good[i:i + 4] for i in range(0, len(good), 4)))):
            errors.extend(res['errors'])
            for g in res['rows']:
                grades[g['id']] = {'A': g['before']['correct'], 'R': g['candidate']['correct']}
    out = {'part': PART, 'order': [r['id'] for r in order], 'answers': answers, 'gate': gate, 'grades': grades, 'judge_errors': errors,
           'missing': {arm: [r['id'] for r in order if not isinstance(answers[arm].get(r['id']), str)] for arm in ('A', 'R')} | {'gate': sorted(gate_ids - set(gate))}}
    (ROOT / 'results.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps({'n': len(order), 'answers': {a: len(v) for a, v in answers.items()}, 'gate': len(gate), 'graded': len(grades), 'judge_errors': len(errors),
                      'missing': {k: len(v) for k, v in out['missing'].items()}}), flush=True)


if __name__ == '__main__':
    main()
