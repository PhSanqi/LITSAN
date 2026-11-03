"""Pack whole source blocks; model-selected preferences never alter stored memory."""
import re
CAP=16000
def source_evidence(context):
    result={}
    for b in blocks(context):
        m=re.match(r'^\[([^\n]+)\]',b)
        if m:result[m[1]]=result.get(m[1],'')+b
    return result

def merge_evidence(old, additions, required=(), cap=CAP):
    """Keep verified anchors, reserve old support, then admit genuinely new source text."""
    sources=source_evidence(old);anchors=[]
    for e in required:
        source=sources.get(e['ref'],'')
        if not e['quote'] or e['quote'] not in source:raise ValueError('Unverified protected evidence')
        header=source.split('\n',1)[0]
        anchor=header+'\n'+e['quote']+'\n\n'
        if anchor not in anchors:anchors.append(anchor)
    result=''.join(anchors)
    if len(result.encode())>cap:raise ValueError('Required evidence exceeds context budget')
    old_blocks=blocks(old);new=[]
    for context in additions:
        for b in blocks(context):
            m=re.match(r'^\[([^\n]+)\]',b)
            body=b.split('\n',1)[-1].strip()
            if body and body not in sources.get(m[1] if m else '', '') and b not in new:new.append(b)
    admitted=[];seen=set(anchors)
    def append(items,limit):
        nonlocal result
        for b in items:
            if b not in seen and len((result+b).encode())<=limit:
                result+=b;seen.add(b)
                if b in new:admitted.append(b)
    append(old_blocks,max(len(result.encode()),cap//2))
    append(new,cap)
    append(old_blocks,cap)
    return result,{'proposed_new_blocks':len(new),'admitted_new_blocks':len(admitted),
        'admitted_new_bytes':sum(len(b.encode()) for b in admitted),'protected_quotes':len(anchors),
        'context_bytes':len(result.encode()),'old_blocks_retained':sum(b in result for b in old_blocks)}

def blocks(context):
    return [x for x in re.split(r'(?=^\[[^\n]+\] recorded: )',context,flags=re.M) if x]
def preference_refs(context):
    return list(dict.fromkeys(re.match(r'^\[([^\n]+)\]',b)[1] for b in blocks(context) if re.match(r'^\[([^\n]+)\]',b) and '\ntype: preference\n' in b))
def pack(contexts,selected=None):
    result='';seen=set()
    for context in contexts:
        for block in blocks(context):
            if block in seen:continue
            seen.add(block)
            match=re.match(r'^\[([^\n]+)\]',block)
            if selected is not None and '\ntype: preference\n' in block and match and match[1] not in selected:continue
            if len((result+block).encode())<=CAP:result+=block
    return result
