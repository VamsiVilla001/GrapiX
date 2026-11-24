"""Score the Jev and Laya review of the dock model (reads jev-laya-review.json, writes review-summary.json).

A classifier answers yes when its noul value is 0.5 or more. Jev's value is a confidence; Laya's is
uncalibrated zero-shot.

  real outcomes answered yes    the code's own outcomes that the classifier accepts
  broken outcomes answered no   the outcomes of a deliberately broken build that it rejects (the control)

A classifier is only worth reading on the real outcomes if it rejects the broken ones.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, '..', 'jev-laya-review.json'), encoding='utf-8'))

rows = []
for batch, body in data.items():
    jev = body['jev'].get('answers') or {}
    lay = body['laya']['answers']
    for key, label in body['labels'].items():
        rows.append({'batch': batch, 'question': key, 'label': label, 'fact': body['origin'][key]['fact'], 'source': body['origin'][key]['source'],
                     'jev': (jev.get(key) or {}).get('noul'), 'laya': (lay.get(key) or {}).get('noul')})

summary = {}
for who in ('jev', 'laya'):
    real = [r for r in rows if r['label'] is True and r[who] is not None]
    broken = [r for r in rows if r['label'] is False and r[who] is not None]
    summary[who] = {
        'real_yes': [sum(1 for r in real if r[who] >= 0.5), len(real)],
        'broken_no': [sum(1 for r in broken if r[who] < 0.5), len(broken)],
    }
    print(f"{who:5s} real outcomes answered yes: {summary[who]['real_yes'][0]}/{summary[who]['real_yes'][1]}   broken outcomes answered no: {summary[who]['broken_no'][0]}/{summary[who]['broken_no'][1]}")

fmt = lambda v: '-' if v is None else f'{v:.2f}'
print('\nWhere a classifier disagrees with the hand label:')
for r in rows:
    wrong = [w for w in ('jev', 'laya') if r['label'] is not None and r[w] is not None and (r[w] >= 0.5) != r['label']]
    if wrong:
        print(f"  {r['fact']:4s} {('real' if r['label'] else 'broken: ' + r['source']):46s} jev={fmt(r['jev'])} laya={fmt(r['laya'])}  <-- {'+'.join(wrong)}")
print('\nThe words of each real refusal (Jev; Laya in brackets):')
by_fact = {}
for r in rows:
    if r['label'] is None:
        by_fact.setdefault(r['fact'], {})['cause' if r['question'].endswith('cause_named') else 'next'] = r
for fact, pair in sorted(by_fact.items(), key=lambda kv: int(kv[0][1:])):
    c, n = pair.get('cause'), pair.get('next')
    flag = '  <-- low' if (c and c['jev'] is not None and c['jev'] < 0.5) or (n and n['jev'] is not None and n['jev'] < 0.5) else ''
    print(f"  {fact:4s} cause named {fmt(c['jev'])} ({fmt(c['laya'])})   next step clear {fmt(n['jev'])} ({fmt(n['laya'])}){flag}")

json.dump({'summary': summary, 'rows': rows}, open(os.path.join(HERE, '..', 'review-summary.json'), 'w', encoding='utf-8'), indent=1)
