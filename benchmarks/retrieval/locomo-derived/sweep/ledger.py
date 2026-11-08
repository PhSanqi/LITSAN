#!/usr/bin/env python3
"""Question-set ledger (P7 M1). usage:
  ledger.py check <set.json> <tune|final|confirm> [--user-approved]   exit 1 if a final/confirm use would repeat
  ledger.py record <set.json> <purpose> <criteria-file> [note]
  ledger.py show
"""
import hashlib, json, sys, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
LEDGER = HERE.parent / 'sets' / 'LEDGER.json'


def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:16]


def load(): return json.loads(LEDGER.read_text()) if LEDGER.exists() else {'sets': {}}


def key(p): return Path(p).name


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'show'
    led = load()
    if cmd == 'show':
        for name, e in led['sets'].items():
            print(name, e['sha256'], [(u['purpose'], u['criteria'], u['date']) for u in e['uses']])
        return
    path, purpose = sys.argv[2], sys.argv[3]
    e = led['sets'].setdefault(key(path), {'sha256': sha(path), 'uses': []})
    if e['sha256'] != sha(path):
        sys.exit(f'ledger: {key(path)} changed on disk ({sha(path)} != {e["sha256"]}); a changed set is a new set, add it under a new file name')
    if cmd == 'check':
        used = [u for u in e['uses'] if u['purpose'] in ('final', 'confirm')]
        if purpose in ('final', 'confirm') and used and '--user-approved' not in sys.argv:
            sys.exit(f'ledger: {key(path)} already used for {[(u["purpose"], u["criteria"]) for u in used]}; ask the user, then pass --user-approved')
        print('ledger: ok', key(path), purpose)
    elif cmd == 'record':
        e['uses'].append({'purpose': purpose, 'criteria': sys.argv[4], 'date': datetime.date.today().isoformat(), 'note': sys.argv[5] if len(sys.argv) > 5 else ''})
        LEDGER.write_text(json.dumps(led, indent=1) + '\n')
        print('ledger: recorded', key(path), purpose)


main()
