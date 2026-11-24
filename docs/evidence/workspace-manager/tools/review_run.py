"""Ask Jev and Laya to review the dock model's error handling and accuracy on measured outcomes (23 Nov 2026).

What they are shown is what the code returned, never a description of it:

  facts.json     what the real functions returned for 31 calls (tools/facts.ts)
  controls.json  for 24 of those calls, what a deliberately BROKEN build returned (tools/controls.py)

Every outcome becomes one anonymous case ("Case 7"), and each case gets the same typed question: does this
outcome satisfy the rule? The hand label is yes for a true outcome and no for a broken one. A true outcome and
its broken twin are never in the same batch, so a classifier cannot answer by comparing them. Error cases from
the real code also get two questions about the words the author is shown.

A classifier that cannot say no to the broken outcomes is not reviewing anything; that is what the controls are
for. (The first run of this review, kept as jev-laya-review-run1.json, used a weaker control, the same outcome
put to another fact's rule. Several of those rules were partly true of the outcome, so that control was unfair
to Jev; and Laya answered yes to all 31 of them.)

Jev is `jev-1.14.0` via D:/Project KK/ai-tools/jev_runner.mjs (the key is read there, never printed). Laya is
`laya-multilingual` at max_len=8192, asserted not truncated; it is uncalibrated zero-shot: a second opinion,
never a vote. Everything is written to jev-laya-review.json.
"""
import json, os, subprocess
import laya

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'jev-laya-review.json')
RUNNER = 'D:/Project KK/ai-tools/jev_runner.mjs'
MODEL = 'convaiinnovations/laya-multilingual'

facts = json.load(open(os.path.join(HERE, '..', 'facts.json'), encoding='utf-8'))
controls = json.load(open(os.path.join(HERE, '..', 'controls.json'), encoding='utf-8'))['controls']

# Cases: (fact, outcome, label). Batches alternate, so a true outcome and its broken twin are apart.
errors = [f for f in facts if f['kind'] == 'error']
accuracy = [f for f in facts if f['kind'] == 'accuracy']


def split(items):
    one, two = [], []
    for index, f in enumerate(items):
        true_case = {'fact': f, 'outcome': f['outcome'], 'label': True, 'source': 'real'}
        (one if index % 2 == 0 else two).append(true_case)
        if f['id'] in controls:
            broken = {'fact': f, 'outcome': controls[f['id']]['outcome'], 'label': False, 'source': controls[f['id']]['mutant']}
            (two if index % 2 == 0 else one).append(broken)
    return one, two


e1, e2 = split(errors)
a1, a2 = split(accuracy)
BATCHES = [('errors-1', e1), ('errors-2', e2), ('accuracy-1', a1), ('accuracy-2', a2)]


def yes_no(text):
    return {'true': 'Yes: ' + text, 'false': 'No, it does not.'}


results = {}
laya_model = laya.load(MODEL)
for name, cases in BATCHES:
    # A fixed order that does not follow the fact ids: sorted by the outcome text.
    cases = sorted(cases, key=lambda c: (len(c['outcome']) * 7919) % 101)
    state = {
        'what_this_is': "Outcomes of calling functions of GrapiX's dock model on a small workspace. Some outcomes come from the real code and some from a build with a fault put in on purpose; you are not told which. A tree is written [group: tabs, the tab marked * is showing] or {split side-by-side|stacked weights ...: children}. Judge each case only by its own call, its 'before' and its result.",
        'cases': [],
    }
    questions, labels, origin = {}, {}, {}
    for number, case in enumerate(cases, 1):
        f = case['fact']
        lines = [f"Case {number}. call: {f['call']}"]
        if f.get('before'):
            lines.append(f"   before: {f['before']}")
        lines.append(f"   result: {case['outcome']}")
        state['cases'].append('\n'.join(lines))
        key = f'case{number}_satisfies_rule'
        questions[key] = {'type': 'noul', 'instructions': f"Case {number}: does the result satisfy this rule? RULE: {f['rule']}", 'criteria': yes_no('the result satisfies the rule.')}
        labels[key] = case['label']
        origin[key] = {'fact': f['id'], 'source': case['source']}
        if f['kind'] == 'error' and case['label']:
            q = f'case{number}_cause_named'
            questions[q] = {'type': 'noul', 'instructions': f"Case {number}: does the text in quotes say what is wrong in words that an author of broadcast graphics, who is not a programmer, would understand?", 'criteria': yes_no('it names the cause clearly.')}
            labels[q] = None
            origin[q] = {'fact': f['id'], 'source': 'real'}
            q = f'case{number}_next_step_clear'
            questions[q] = {'type': 'noul', 'instructions': f"Case {number}: after reading the text in quotes, is it clear what the author could do next?", 'criteria': yes_no('the next step is clear.')}
            labels[q] = None
            origin[q] = {'fact': f['id'], 'source': 'real'}
    payload = {'state': state, 'questions': questions}
    out = subprocess.run(['node', RUNNER], input=json.dumps(payload).encode('utf-8'), capture_output=True)
    jev = json.loads(out.stdout.decode('utf-8')) if out.returncode == 0 else {'error': out.stderr.decode('utf-8', 'replace')[-400:]}
    res = laya_model.system_one(state, questions, max_len=8192)
    usage = res.get('usage', {})
    assert not usage.get('truncated'), (name, usage)
    results[name] = {'state': state, 'questions': questions, 'labels': labels, 'origin': origin, 'jev': jev,
                     'laya': {'model': MODEL, 'max_len': 8192, 'usage': usage, 'answers': res['answers']}}
    print(name, len(cases), 'cases | jev', jev.get('model'), '| laya tokens', usage.get('state_tokens'), 'truncated', usage.get('truncated'), flush=True)

json.dump(results, open(OUT, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('written', OUT)
