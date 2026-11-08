"""Parse GrapiX-Build-Plan.md into rows with phase context and tracker state -> plan-rows.json."""
import json, os, re

ROOT = 'D:/Project KK/Personal projects/GrapiX/agent/worktree'
HERE = os.path.dirname(os.path.abspath(__file__))
text = open(f'{ROOT}/GrapiX-Build-Plan.md', encoding='utf-8').read()
state = json.load(open(f'{ROOT}/progress.json', encoding='utf-8'))

rows, phases = [], {}
phase = None
intro = []
for line in text.splitlines():
    m = re.match(r'^## (Phase \S+) — (.*)$', line)
    if m:
        phase = m.group(1); phases[phase] = {'title': m.group(2), 'intro': '', 'rows': []}
        intro = []
        continue
    m2 = re.match(r'^### (.*)$', line)
    if m2 and phase:
        intro.append(m2.group(1))
        continue
    if phase is None:
        continue
    cells = [c.strip() for c in line.strip().strip('|').split('|')] if line.startswith('|') else None
    if cells and len(cells) >= 5 and re.fullmatch(r'`[0-9P]+\.[0-9]+`', cells[0]):
        step = cells[0].strip('`')
        row = {'step': step, 'phase': phase, 'work': cells[1], 'track': cells[2], 'needs': cells[3], 'done_when': cells[4],
               'state': state.get(step, 'pending'), 'section': intro[-1] if intro else None}
        rows.append(row); phases[phase]['rows'].append(step)
    elif line.strip() and not line.startswith('|'):
        if not phases[phase]['rows']:
            phases[phase]['intro'] += line.strip() + ' '
json.dump({'phases': phases, 'rows': rows}, open(os.path.join(HERE, 'plan-rows.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
from collections import Counter
print(len(rows), 'rows;', Counter(r['state'] for r in rows))
missing = [k for k in state if k != '$comment' and k not in {r['step'] for r in rows}]
print('tracker rows not in plan:', missing)
for p, v in phases.items():
    open_rows = [r for r in rows if r['phase'] == p and r['state'] != 'done']
    print(f"{p:<9} {len(v['rows']):>3} rows, {len(open_rows):>3} open: {' '.join(r['step'] for r in open_rows)[:150]}")
