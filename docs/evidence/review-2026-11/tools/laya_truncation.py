"""How much of each state Laya actually read in the reviews: state tokens versus tokens dropped.

Rebuilds the per-row states exactly as review_done.py did, plus the decision files used for
3.22 and the review findings, and asks one cheap question of each, reading Laya's usage record.
"""
import json, os, sys
import laya

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from review_done import QUESTIONS  # same questions, so the head budget matches

model = laya.load('convaiinnovations/laya')
print('max_len', model.cfg.get('max_len', 512), 'head_max_len', model.cfg.get('head_max_len', 192))

def usage(state, questions):
    out = model.predict(state, questions)
    return out.get('usage', {}) if isinstance(out, dict) else {}

results = {}
rows = json.load(open(os.path.join(HERE, 'rows-done.json'), encoding='utf-8'))
refs = json.load(open(os.path.join(HERE, 'code-refs.json'), encoding='utf-8'))
cut = 0
for r in rows:
    state = {
        'row': f"{r['id']} {r['name']} (track {r['track']})",
        'done_when': r['done_when'],
        'tracker_record': r['tracker_notes'] or '(no tracker note names this row)',
        'memory_record': r['memory_text'][:3000] or '(no memory.md entry heading names this row)',
        'evidence_directory': 'docs/evidence/%s exists' % r['id'] if r['evidence_dir'] else 'no docs/evidence directory for this row',
        'code_citing_this_row': {
            'test_functions': refs.get(r['id'], {}).get('tests', []),
            'conformance_checks_naming_it': refs.get(r['id'], {}).get('conformance_checks', 0),
            'source_files': refs.get(r['id'], {}).get('files', []),
            'note': 'Every Rust test and conformance check runs in the repository gate (npm run check), which passed on 8 Nov 2026: 771 Rust tests, 500 conformance checks, 0 failures.',
        },
    }
    u = usage(state, QUESTIONS)
    results[r['id']] = {k: u.get(k) for k in ('state_tokens', 'state_tokens_dropped', 'truncated')}
    cut += bool(u.get('truncated'))
read = [v['state_tokens'] - v['state_tokens_dropped'] for v in results.values()]
total = [v['state_tokens'] for v in results.values()]
print(f'rows: {cut} of {len(rows)} truncated; median state {sorted(total)[len(total)//2]} tokens, '
      f'median read {sorted(read)[len(read)//2]}; read share overall {sum(read)/sum(total):.0%}')
for name in ['acceptance-322.json', 'decision-322.json', 'decision-review-findings.json', 'decision-ci.json']:
    d = json.load(open(os.path.join(HERE, name), encoding='utf-8'))
    u = usage(d['state'], d['questions'])
    results[name] = {k: u.get(k) for k in ('state_tokens', 'state_tokens_dropped', 'truncated', 'truncated_questions')}
    print(name, results[name])
json.dump(results, open(os.path.join(HERE, 'laya-truncation.json'), 'w', encoding='utf-8'), indent=1)
