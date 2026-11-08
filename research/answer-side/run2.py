"""Run the arms of CRITERIA-2.md on the fixed contexts (model calls; results are cached).

A     plain contract                         on G3
SC    plain contract + confidence line       on G3 (same batches)
gate  sufficiency verdict of CRITERIA.md     on G3 (sees question + context only)
judge memory-judge-v4                        on (A, SC) answers
The confidence line is read verbatim from CRITERIA-2.md and the gate prompt from CRITERIA.md; both hashes are checked.
usage: python3 run2.py smoke|main
"""
import os
import concurrent.futures, hashlib, json, random, re, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
RT = Path(os.environ.get('LITSAN_BENCH_DATA') or Path(__file__).resolve().parents[2] / '.review-runtime')  # data folder, see REPORT.md
RD = RT / 'answer-side-20261107'
PART = sys.argv[1]
for name, path in [('CRITERIA.sha256', HERE / 'CRITERIA.md'), ('CRITERIA-2.sha256', HERE / 'CRITERIA-2.md'),
                   ('sets.sha256', HERE / 'sets.json'), ('sets2.sha256', HERE / 'sets2.json')]:
    assert hashlib.sha256(path.read_bytes()).hexdigest() == (HERE / name).read_text().split()[0], f'{path.name} changed after freezing'
RUN = RT / 'gnn-core-worktree-20261104/.review-runtime/demand-repair-20261104'
sys.path.insert(0, str(RT / 'gnn-core-worktree-20261104/scripts'))
from memory_eval_calls import cached_call
from memory_judge import judge_pairs, fingerprint

cal = json.loads((RT / 'gnn-core-worktree-20261104/.review-runtime/judge-batch-check-20261106/calibration/judge-calibration.json').read_text())
assert cal['passed'] and cal['judge_fingerprint'] == fingerprint(), 'current judge is not the calibrated one'
GATE_PROMPT, _ = re.findall(r'```text\n(.*?)\n```', (HERE / 'CRITERIA.md').read_text(), re.S)
(CONF_LINE,) = re.findall(r'```text\n(.*?)\n```', (HERE / 'CRITERIA-2.md').read_text(), re.S)
assert GATE_PROMPT.startswith('You check retrieved memory context') and CONF_LINE.startswith('Confidence field')
CONTRACT = (RUN / 'memory-answer-contract.txt').read_text() + '\n' + (RUN / 'progressive-answer-guidance.txt').read_text()
ARMS = {'A': CONTRACT, 'SC': CONTRACT.rstrip('\n') + '\n' + CONF_LINE + '\n'}
ROOT = RD / f'run2-{PART}'
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
    if PART == 'smoke':
        rows = json.loads((HERE / 'sets.json').read_text())['S']
        ctx = json.loads((RD / 'contexts.json').read_text())['contexts']
    else:
        rows = json.loads((HERE / 'sets2.json').read_text())['G3']
        ctx = json.loads((RD / 'contexts2.json').read_text())['contexts']
    order = sorted(rows, key=lambda r: r['id'])
    random.Random(20261107).shuffle(order)
    batches = [order[i:i + 4] for i in range(0, len(order), 4)]
    jobs = [(kind, i, b) for kind in ('A', 'SC', 'gate') for i, b in enumerate(batches)]

    def run(job):
        kind, i, b = job
        payload = json.dumps([{'id': r['id'], 'question': r['question'], 'context': ctx[r['id']]} for r in b], ensure_ascii=False)
        prompt = (GATE_PROMPT if kind == 'gate' else ARMS[kind]) + '\n' + payload
        return kind, ask(f'{kind}-{i:03d}', prompt, [r['id'] for r in b])
    got = {k: {} for k in ('A', 'SC', 'gate')}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for n, (kind, res) in enumerate(pool.map(run, jobs)):
            got[kind].update(res)
            if n % 20 == 0:
                print('progress', n, '/', len(jobs), flush=True)
    answers = {arm: {k: v.get('answer') for k, v in got[arm].items()} for arm in ('A', 'SC')}
    confidence = {k: v.get('confidence') for k, v in got['SC'].items()}
    gate = {k: {'sufficient': v.get('sufficient'), 'confidence': v.get('confidence'), 'missing': v.get('missing')} for k, v in got['gate'].items()}
    good = [{**r, 'before_answer': answers['A'].get(r['id']), 'candidate_answer': answers['SC'].get(r['id'])} for r in order
            if isinstance(answers['A'].get(r['id']), str) and isinstance(answers['SC'].get(r['id']), str)]
    grades, errors = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for res in pool.map(lambda ib: judge_pairs(call, ib[1], f'judge-{ib[0]:03d}', {}), list(enumerate(good[i:i + 4] for i in range(0, len(good), 4)))):
            errors.extend(res['errors'])
            for g in res['rows']:
                grades[g['id']] = {'A': g['before']['correct'], 'SC': g['candidate']['correct']}
    ids = {r['id'] for r in order}
    out = {'part': PART, 'order': [r['id'] for r in order], 'answers': answers, 'sc_confidence': confidence, 'gate': gate, 'grades': grades, 'judge_errors': errors,
           'missing': {arm: [r['id'] for r in order if not isinstance(answers[arm].get(r['id']), str)] for arm in ('A', 'SC')}
           | {'gate': sorted(ids - set(gate)), 'sc_confidence_non_numeric': sorted(i for i in ids if not isinstance(confidence.get(i), (int, float)))}}
    (ROOT / 'results.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps({'n': len(order), 'answers': {a: len(v) for a, v in answers.items()}, 'gate': len(gate), 'graded': len(grades), 'judge_errors': len(errors),
                      'missing': {k: len(v) for k, v in out['missing'].items()},
                      'sc_confidence_values': sorted({c for c in confidence.values() if isinstance(c, (int, float))})}), flush=True)


if __name__ == '__main__':
    main()
