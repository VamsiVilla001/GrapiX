"""Ask Jev and Laya the same typed questions about a decision (11.112 and 11.113, 24 Nov 2026).

Usage: laya-venv python decide.py <input.json> <output.json> [jev-only]
Jev (TypeSafe, via D:/Project KK/ai-tools/jev_runner.mjs; the key is read there, never printed) and Laya
(laya-multilingual, max_len=8192, asserted not truncated) get the same state and questions. Laya is
uncalibrated zero-shot: a second opinion, never a vote. Jev's numbers are confidences, not versions. Both
answers are kept in one JSON per decision.
"""
import json
import subprocess
import sys

RUNNER = 'D:/Project KK/ai-tools/jev_runner.mjs'
MODEL = 'convaiinnovations/laya-multilingual'
src, dst = sys.argv[1], sys.argv[2]
jev_only = len(sys.argv) > 3 and sys.argv[3] == 'jev-only'
decision = json.load(open(src, encoding='utf-8'))
state, questions = decision['state'], decision['questions']
out = subprocess.run(['node', RUNNER], input=json.dumps(decision).encode('utf-8'), capture_output=True)
jev = {'error': out.stderr.decode('utf-8', 'replace')[-400:]} if out.returncode != 0 else json.loads(out.stdout.decode('utf-8'))
result = {'input': decision, 'jev': jev}
if not jev_only:
    import laya
    model = laya.load(MODEL)
    res = model.system_one(state, questions, max_len=8192)
    usage = res.get('usage', {})
    assert not usage.get('truncated'), usage
    result['laya'] = {'model': MODEL, 'max_len': 8192, 'usage': usage, 'answers': res['answers']}
json.dump(result, open(dst, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('jev model:', jev.get('model'), '| laya:', 'skipped' if jev_only else result['laya']['usage'].get('state_tokens'))
