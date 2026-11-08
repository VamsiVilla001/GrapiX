"""Digest every tracker row marked done: name, done-when, and the recorded evidence.

Evidence sources, in order: the tracker $comment sentences naming the row, the
memory.md dated entries whose heading names the row, and whether
docs/evidence/<row>/ exists. Output: rows-done.json next to this script.
"""
import json, os, re

ROOT = 'D:/Project KK/Personal projects/GrapiX/agent/worktree'
HERE = os.path.dirname(os.path.abspath(__file__))

html = open(f'{ROOT}/progress.html', encoding='utf-8').read()
i = html.index('const PLAN = ')
plan = json.loads(html[i + 13:html.index('];', i) + 1])
state = json.load(open(f'{ROOT}/progress.json', encoding='utf-8'))
comment = state['$comment']
memory = open(f'{ROOT}/memory.md', encoding='utf-8').read()

# memory.md entries: heading -> body (first 1200 chars)
entries = []
for m in re.finditer(r'^## (.+?)$', memory, re.M):
    entries.append((m.start(), m.group(1)))
bodies = {}
for k, (start, heading) in enumerate(entries):
    end = entries[k + 1][0] if k + 1 < len(entries) else len(memory)
    bodies[heading] = memory[start:end]

def sentences_mentioning(text, rid):
    pat = re.compile(r'(?<![\d.])' + re.escape(rid) + r'(?![\d.])')
    out = []
    for sentence in re.split(r'(?<=[.;])\s+', text):
        if pat.search(sentence):
            out.append(sentence.strip())
    return out

rows = []
for milestone in plan:
    for step in milestone['steps']:
        rid = step['id']
        if state.get(rid) != 'done':
            continue
        pat = re.compile(r'(?<![\d.])' + re.escape(rid) + r'(?![\d.])')
        tracker_notes = sentences_mentioning(comment, rid)
        mem = [(h, b) for h, b in bodies.items() if pat.search(h)]
        if mem:
            mem_text = ' '.join(re.sub(r'\s+', ' ', b)[:1500] for _, b in mem[:3])
        else:
            # No heading names the row: take the sentences inside entries that
            # do, newest entries first, with the entry heading for its date.
            pieces = []
            for h, b in bodies.items():
                if h == 'Rules for the next session':
                    continue
                hits = sentences_mentioning(re.sub(r'\s+', ' ', b), rid)
                if hits:
                    pieces.append(f'[{h}] ' + ' '.join(hits)[:700])
                if sum(len(x) for x in pieces) > 2800:
                    break
            mem_text = ' '.join(pieces)[:3000]
            mem = [(h, '') for h in [x[1:x.index(']')] for x in pieces]]
        has_evidence_dir = os.path.isdir(f'{ROOT}/docs/evidence/{rid}')
        rows.append({
            'id': rid,
            'name': step['name'],
            'track': step['track'],
            'done_when': step['done'],
            'tracker_notes': ' '.join(tracker_notes)[:1500],
            'memory_headings': [h for h, _ in mem],
            'memory_text': mem_text,
            'evidence_dir': has_evidence_dir,
        })
json.dump(rows, open(f'{HERE}/rows-done.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
no_notes = [r['id'] for r in rows if not r['tracker_notes'] and not r['memory_headings']]
print(len(rows), 'done rows;', len(no_notes), 'with no tracker note or memory heading naming them:', ' '.join(no_notes))
