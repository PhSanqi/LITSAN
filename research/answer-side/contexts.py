"""Build the fixed contexts every arm and the gate read (written once, then reused).

LoCoMo      text+records fused retrieval (multihop/retrieval.py, the replicated §9 setting)
LongMemEval text-only hybrid over user turns with neighbours and a "Question date:" line,
            the multihop/fresh/contexts.py method; C2 reuses fresh/contexts.json unchanged
Vectors and embedding inputs live in the runtime dir, not in the shared multihop dir.
usage: python3 contexts.py
"""
import os
import hashlib, json, subprocess, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
RT = Path(os.environ.get('LITSAN_BENCH_DATA') or Path(__file__).resolve().parents[2] / '.review-runtime')  # data folder, see REPORT.md
MH = RT / 'attribution-20261106/multihop'
RD = RT / 'answer-side-20261107'
sys.path.insert(0, str(MH))
import retrieval
from retrieval import BM25, CAP, CONFIGS, hybrid_rank, rrf, render
retrieval.HERE = RD  # records/embed.mjs are symlinks there; vectors.json is a private copy
sys.path.insert(0, str(MH / 'fresh'))
from contexts import lme_date, h

S = json.loads((HERE / 'sets.json').read_text())
assert hashlib.sha256((HERE / 'sets.json').read_bytes()).hexdigest() == (HERE / 'sets.sha256').read_text().split()[0]


def lme_contexts(rows, out, evidence):
    data = {q['question_id']: q for q in json.loads((RT / 'benchmarks/data/longmemeval_s_cleaned.json').read_text())}
    items, seen = [], set()
    for r in rows:
        q = data[r['id'].split(':', 1)[1]]
        for sess in q['haystack_sessions']:
            for t in sess:
                if t['role'] == 'user' and h(t['content']) not in seen:
                    seen.add(h(t['content'])); items.append({'id': h(t['content']), 'text': t['content'][:2000]})
        items.append({'id': 'q:' + r['id'], 'text': r['question'], 'role': 'query'})
    (RD / 'lme-embed-input.json').write_text(json.dumps(items, ensure_ascii=False))
    subprocess.run(['node', str(RD / 'embed.mjs'), str(RD / 'lme-embed-input.json'), str(RD / 'lme-vectors.json')], check=True, cwd=RT / 'gnn-core-worktree-20261104')
    vec = json.loads((RD / 'lme-vectors.json').read_text())
    for r in rows:
        q = data[r['id'].split(':', 1)[1]]
        sess = sorted(zip(q['haystack_dates'], q['haystack_sessions'], q['haystack_session_ids']), key=lambda x: x[0])
        turns = []
        for s_no, (date, ss, sid) in enumerate(sess, 1):
            for t_no, t in enumerate(ss, 1):
                turns.append({'id': f'D{s_no}:{t_no}', 's': s_no, 'role': t['role'], 'text': t['content'], 'date': lme_date(date), 'answer': bool(t.get('has_answer'))})
        users = [i for i, t in enumerate(turns) if t['role'] == 'user']
        order = hybrid_rank(vec['q:' + r['id']], r['question'], [vec[h(turns[i]['text'])] for i in users], BM25([turns[i]['text'] for i in users]))
        chosen, used = set(), 0
        for k in order:
            i = users[k]
            group = [j for j in (i - 1, i, i + 1) if 0 <= j < len(turns) and turns[j]['s'] == turns[i]['s'] and j not in chosen]
            cost = sum(min(len(turns[j]['text']), 400 if turns[j]['role'] == 'assistant' else 1500) + 20 for j in group) + 60
            if used + cost > CAP:
                continue
            chosen.update(group); used += cost
        blocks, last = [f"Question date: {lme_date(q['question_date'])}"], None
        for j in sorted(chosen):
            t = turns[j]
            if t['s'] != last:
                blocks.append(f"\n[lme:session_{t['s']}] recorded: {t['date']}"); last = t['s']
            text = t['text'] if t['role'] == 'user' else t['text'][:400] + ('…' if len(t['text']) > 400 else '')
            blocks.append(f"{t['id']} {t['role']}: {text[:1500]}")
        out[r['id']] = '\n'.join(blocks)
        evidence[r['id']] = [sum(j in chosen for j, t in enumerate(turns) if t['answer']), sum(t['answer'] for t in turns)]


def main():
    out, evidence = {}, {}
    loc = [r for r in S['G'] if r['dataset'] == 'LoCoMo']
    convs, vectors = retrieval.load({r['id']: r['question'] for r in loc})
    for r in loc:
        conv = convs[r['conv']]
        ch, _ = conv.channels(r['question'], vectors[r['id']])
        out[r['id']], present = render(conv, rrf(ch, CONFIGS['text+records']))
        evidence[r['id']] = [sum(d in present for d in r['evidence']), len(r['evidence'])]
    lme_contexts([r for r in S['G'] + S['S'] if r['dataset'] == 'LongMemEval'], out, evidence)
    old = json.loads((MH / 'fresh/contexts.json').read_text())
    for r in S['C2']:
        out[r['id']] = old['contexts'][r['id']]; evidence[r['id']] = list(old['evidence_in_context'][r['id']])
    (RD / 'contexts.json').write_text(json.dumps({'contexts': out, 'evidence_in_context': evidence}, ensure_ascii=False))
    full = sum(1 for v in evidence.values() if v[1] and v[0] == v[1])
    print('contexts', len(out), 'complete evidence', full, '/', sum(1 for v in evidence.values() if v[1]),
          'mean bytes', round(sum(len(c.encode()) for c in out.values()) / len(out)))


if __name__ == '__main__':
    main()
