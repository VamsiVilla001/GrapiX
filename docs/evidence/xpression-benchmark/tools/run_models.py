"""Run Jev and Laya on every benchmark item (23 Nov 2026) and compare with the hand verdicts.

Jev (TypeSafe, through D:/Project KK/ai-tools/jev_runner.mjs; the key is read there, never printed) and
Laya (laya-multilingual, max_len=8192, asserted not truncated) get the same state and questions for each
item. The hand verdicts are not sent to either. Output: ../jev-laya-coverage.json.
"""
import json, os, subprocess, sys, time
import laya

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = 'D:/Project KK/ai-tools/jev_runner.mjs'
MODEL = 'convaiinnovations/laya-multilingual'

data = json.load(open(os.path.join(HERE, '..', 'items.json'), encoding='utf-8'))
hand = json.load(open(os.path.join(HERE, '..', 'hand-verdicts.json'), encoding='utf-8'))
questions = data['questions']
model = laya.load(MODEL)


def pick(a):
    if isinstance(a, dict):
        for k in ('choice', 'noul', 'score'):
            if k in a:
                return a[k] if k != 'choice' else {'choice': a['choice'], 'probabilities': a.get('probabilities')}
    return a


results = []
for n, item in enumerate(data['items'], 1):
    jev = subprocess.run(['node', RUNNER], input=json.dumps({'state': item['state'], 'questions': questions}).encode('utf-8'), capture_output=True)
    if jev.returncode != 0:
        j = {'error': jev.stderr.decode('utf-8', 'replace')[-300:]}
    else:
        j = json.loads(jev.stdout.decode('utf-8'))['answers']
    out = model.system_one(item['state'], questions, max_len=8192)
    usage = out.get('usage', {})
    assert not usage.get('truncated'), (item['key'], usage)
    l = out['answers']
    row = {'key': item['key'], 'menu': item['menu'], 'label': item['label'], 'hand': hand[item['key']], 'jev': {k: pick(v) for k, v in j.items()} if 'error' not in j else j,
           'laya': {k: pick(v) for k, v in l.items()}, 'laya_tokens': usage.get('state_tokens')}
    results.append(row)
    jc = row['jev'].get('coverage', {}).get('choice') if isinstance(row['jev'].get('coverage'), dict) else '?'
    lc = row['laya'].get('coverage', {}).get('choice') if isinstance(row['laya'].get('coverage'), dict) else '?'
    print(f"{n:>2}/{len(data['items'])} {item['key']:<26} hand={hand[item['key']]['verdict']:<8} jev={jc:<8} laya={lc}", flush=True)

json.dump(results, open(os.path.join(HERE, '..', 'jev-laya-coverage.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('done', len(results))
