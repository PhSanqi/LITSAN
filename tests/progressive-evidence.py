import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from progressive_evidence import blocks,preference_refs,pack,CAP
a='[movie] recorded: 2026-01-01\ntype: preference\nitem: Joan Crawford\n\n'
b='[food] recorded: 2026-01-01\ntype: preference\nitem: noodles\n\n'
c='[fact] recorded: 2026-01-01\nA source fact.\n\n'
assert preference_refs(a+b+c)==['movie','food']
assert pack([a+b+c],['movie'])==a+c
assert pack([a+b+c],[])==c
assert pack([a+b,a+c])==a+b+c
assert pack([c,'[large] recorded: now\n'+'汉'*CAP])==c
assert ''.join(blocks(a+b+c))==a+b+c
print('6 source-preserving packing checks passed')
from progressive_evidence import merge_evidence,source_evidence
old='[a] recorded: now\nThe store was Target.\n\n'+'[b] recorded: now\n'+'x'*300+'\n\n'
new='[c] recorded: now\nA new relationship fact.\n\n'
merged,trace=merge_evidence(old,[new],[{'ref':'a','quote':'The store was Target.'}],cap=250)
assert 'The store was Target.' in merged and 'A new relationship fact.' in merged
assert len(merged.encode())<=250 and trace['admitted_new_blocks']==1
assert merge_evidence(old,[old])[1]['admitted_new_blocks']==0
try:merge_evidence(old,[new],[{'ref':'a','quote':'Invented.'}])
except ValueError:pass
else:raise AssertionError('fabricated evidence accepted')
assert source_evidence(old)['a'].startswith('[a]')
print('5 protected evidence/admission checks passed')
