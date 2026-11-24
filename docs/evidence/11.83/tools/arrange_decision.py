"""Ask Jev and Laya the same typed questions about line up and spread (23 Nov 2026).

Jev (via D:/Project KK/ai-tools/jev_runner.mjs; the key is read there, never printed) and Laya
(laya-multilingual, max_len=8192, asserted not truncated) get the same state and questions. Both
answers are written to jev-laya-arrange.json beside this folder's README. Laya is uncalibrated
zero-shot: a second opinion, never a vote. Jev's numbers are confidences.
"""
import json, os, subprocess
import laya

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'jev-laya-arrange.json')
RUNNER = 'D:/Project KK/ai-tools/jev_runner.mjs'
MODEL = 'convaiinnovations/laya-multilingual'

decision = json.load(open(os.path.join(HERE, 'arrange_decision_input.json'), encoding='utf-8'))
state, questions = decision['state'], decision['questions']

out = subprocess.run(['node', RUNNER], input=json.dumps(decision).encode('utf-8'), capture_output=True)
if out.returncode != 0:
    jev = {'error': out.stderr.decode('utf-8', 'replace')[-400:]}
else:
    jev = json.loads(out.stdout.decode('utf-8'))

model = laya.load(MODEL)
res = model.system_one(state, questions, max_len=8192)
usage = res.get('usage', {})
assert not usage.get('truncated'), usage

json.dump({'input': decision, 'jev': jev, 'laya': {'model': MODEL, 'max_len': 8192, 'usage': usage, 'answers': res['answers']}},
          open(OUT, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('jev model:', jev.get('model'), '| laya tokens:', usage.get('state_tokens'), 'truncated:', usage.get('truncated'))
for name in questions:
    j = (jev.get('answers') or {}).get(name)
    l = res['answers'].get(name)
    print(name, '| jev:', json.dumps(j, ensure_ascii=False)[:300], '| laya:', json.dumps(l, ensure_ascii=False)[:300])
