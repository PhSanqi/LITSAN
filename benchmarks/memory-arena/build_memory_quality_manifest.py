#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, subprocess
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--output', required=True)
    ap.add_argument('--artifact', action='append', default=[])
    args=ap.parse_args()
    root=Path(args.root).resolve()
    arena=root/'.review-runtime/memory-arena'
    dataset=arena/'OmniMemEval/data/locomo/locomo10.json'
    evaluator=root/'benchmarks/memory-arena/evaluate_memory_quality.py'
    collector=root/'benchmarks/memory-arena/collect_locomo_http_trace.py'
    protocol=root/'benchmarks/memory-arena/memory-quality-protocol.md'
    tests=root/'benchmarks/memory-arena/test_memory_quality.py'
    git_head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    files={}
    for label,path in {
        'dataset':dataset,'evaluator':evaluator,'trace_collector':collector,
        'protocol':protocol,'evaluator_tests':tests,
        'memhub_frozen_db':arena/'state/memhub-ab-frozen/memory/memory.sqlite',
    }.items():
        if path.exists(): files[label]={'path':str(path.relative_to(root)),'sha256':sha256(path),'bytes':path.stat().st_size}
    artifacts=[]
    for raw in args.artifact:
        path=(root/raw).resolve() if not Path(raw).is_absolute() else Path(raw)
        if path.exists(): artifacts.append({'path':str(path.relative_to(root)),'sha256':sha256(path),'bytes':path.stat().st_size})
    payload={
        'schema':'memory-quality-manifest-v1',
        'generated_at':datetime.now(timezone.utc).isoformat(),
        'git_head':git_head,
        'primary_scope':'memory_quality_only',
        'dataset':'LoCoMo 10 conversations / 1540 non-adversarial QA lane',
        'category_mapping':{'1':'multi_hop','2':'temporal','3':'open_domain','4':'single_hop','5':'adversarial_excluded'},
        'semantic_evaluator':{'model':'BAAI/bge-small-en-v1.5','execution':'local fastembed/OpenAI-compatible proxy','thresholded_recall':False},
        'files':files,
        'artifacts':artifacts,
    }
    out=Path(args.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
    print(out)

if __name__=='__main__': main()
