"""Rerun Laya on every review input with a checkpoint that reads the whole input.

The base checkpoint (convaiinnovations/laya) reads 512 tokens and silently truncated 83 of
123 done-row inputs and all four decision inputs (laya-truncation.json). This reruns only
Laya's half with convaiinnovations/laya-multilingual at max_len=8192, asserts nothing was
truncated, and keeps Jev's answers (which came from the full inputs) untouched. The
superseded base-512 Laya values are kept beside the new ones under `laya_base_512`.
"""
import json, os, sys, time
import laya

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from review_done import QUESTIONS  # the per-row questions, unchanged

MODEL = 'convaiinnovations/laya-multilingual'
MAX_LEN = 8192
t0 = time.perf_counter()
model = laya.load(MODEL)
LOAD_S = round(time.perf_counter() - t0, 2)
print('loaded', MODEL, 'cfg max_len', model.cfg.get('max_len'), 'in', LOAD_S, 's', flush=True)


def pick(a):
    if not isinstance(a, dict):
        return a
    for k in ('choice', 'noul', 'score'):
        if k in a:
            return a[k]
    return a


def ask(state, questions):
    q = {name: {k: v for k, v in spec.items() if k in ('type', 'instructions', 'criteria')} for name, spec in questions.items()}
    t1 = time.perf_counter()
    out = model.system_one(state, q, max_len=MAX_LEN)
    usage = dict(out.get('usage', {}))
    usage['predict_s'] = round(time.perf_counter() - t1, 3)
    assert not usage.get('truncated'), usage
    return out['answers'], usage


context = {'model': MODEL, 'max_len': MAX_LEN, 'inputs': {}}

# 1. The 123 done rows, states built exactly as review_done.py built them.
rows = json.load(open(os.path.join(HERE, 'rows-done.json'), encoding='utf-8'))
refs = json.load(open(os.path.join(HERE, 'code-refs.json'), encoding='utf-8'))
prev = {r['id']: r for r in json.load(open(os.path.join(HERE, 'review-done-v2.json'), encoding='utf-8'))}
out_rows = []
for n, r in enumerate(rows, 1):
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
    answers, usage = ask(state, QUESTIONS)
    row = dict(prev[r['id']])
    row['laya_base_512'] = row['laya']
    row['laya'] = {k: pick(v) for k, v in answers.items()}
    out_rows.append(row)
    context['inputs'][r['id']] = {k: usage.get(k) for k in ('state_tokens', 'state_tokens_dropped', 'truncated', 'predict_s')}
    print(f"{n}/{len(rows)} {r['id']} laya_done={row['laya'].get('done_when_met')} (base512 {row['laya_base_512'].get('done_when_met')}) jev={row['jev'].get('done_when_met')} tokens={usage.get('state_tokens')}", flush=True)
json.dump(out_rows, open(os.path.join(HERE, 'review-done-v3.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)

# 2. The four decision files: same state and questions, Laya's half replaced.
PAIRS = [('acceptance-322.json', 'acceptance-322-answers.json', 'acceptance-322-answers-v2.json'),
         ('decision-322.json', 'compare-322.json', 'compare-322-v2.json'),
         ('decision-review-findings.json', 'decision-review-findings-answers.json', 'decision-review-findings-answers-v2.json'),
         ('decision-ci.json', 'decision-ci-answers.json', 'decision-ci-answers-v2.json')]
for spec_name, old_name, new_name in PAIRS:
    spec = json.load(open(os.path.join(HERE, spec_name), encoding='utf-8'))
    report = json.load(open(os.path.join(HERE, old_name), encoding='utf-8'))
    answers, usage = ask(spec['state'], spec['questions'])
    base = {}
    for row in report['rows']:
        name = row['question']
        base[name] = row['laya']
        row['laya'] = pick(answers[name])
        row['laya_detail'] = answers[name]
        if row.get('jev') is not None:
            row['agree'] = (row['laya'] == row['jev']) if row['type'] != 'noul' else abs(float(row['laya']) - float(row['jev'])) < 0.25
    report['agreement'] = sum(1 for r in report['rows'] if r['agree']) / max(len(report['rows']), 1)
    report['laya'] = {'model': MODEL, 'max_len': MAX_LEN, 'load_s': LOAD_S, 'predict_s': usage['predict_s'],
                      'state_tokens': usage.get('state_tokens'), 'truncated': bool(usage.get('truncated'))}
    report['laya_base_512'] = {'model': 'convaiinnovations/laya', 'max_len': 512, 'superseded': 'read only the first 512 tokens of this input; see laya-context.json', 'answers': base}
    json.dump(report, open(os.path.join(HERE, new_name), 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    context['inputs'][spec_name] = {k: usage.get(k) for k in ('state_tokens', 'state_tokens_dropped', 'truncated', 'predict_s')}
    print(spec_name, 'agreement', round(report['agreement'], 2), {r['question']: (r['laya'], r['jev']) for r in report['rows']}, flush=True)

base512 = json.load(open(os.path.join(HERE, 'laya-truncation.json'), encoding='utf-8'))
context['base_512_measurement'] = {'model': 'convaiinnovations/laya', 'max_len': 512, 'inputs': base512}
json.dump(context, open(os.path.join(HERE, 'laya-context.json'), 'w', encoding='utf-8'), indent=1)
n_done = sum(1 for r in out_rows if isinstance(r['laya'].get('done_when_met'), (int, float)) and r['laya']['done_when_met'] >= 0.5)
n_agree = sum(1 for r in out_rows if isinstance(r['laya'].get('done_when_met'), (int, float)) and isinstance(r['jev'].get('done_when_met'), (int, float)) and (r['laya']['done_when_met'] >= 0.5) == (r['jev']['done_when_met'] >= 0.5))
print(f'done: laya>=0.5 on {n_done}/{len(out_rows)}; agree with jev on {n_agree}; total {time.perf_counter() - t0:.0f}s')
