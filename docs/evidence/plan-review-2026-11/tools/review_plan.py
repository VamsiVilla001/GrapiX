"""Ask Jev and Laya about every open build-plan row (Panchayati #105).

Per row: is the done-when executable, when should it be worked given its Needs and their
states, are the Needs right, and the main risk. Per phase with open rows: is the order right
and which open row goes first. Laya is laya-multilingual at max_len=8192 with truncation
asserted off; Jev goes through the Node runner (the key never enters this process).
"""
import json, os, subprocess, sys, time
import laya

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, '..', 'typesafe-sdk', 'jev_runner.mjs')
MODEL, MAX_LEN = 'convaiinnovations/laya-multilingual', 8192

DIRECTION = (
    "Product direction (user, 15-16 Oct 2026): After Effects-style authoring (layers, properties, keyframes, curves, "
    "effects) plus XPression/Viz-style live playout; the Render Engine owns time and Program pixels; GPU-first "
    "GrapiX-owned compositor (12 Oct), EffectCraft components ported with attribution, colour follows the project "
    "working space. The design-system concept was removed from authoring (Phase 10 and design-system parts of rows "
    "are historical compatibility only). Phase 9 validates rather than gates. Engine preview before further Editor "
    "polish. First release targets sports/esports with one Program channel. macOS runs were dropped from several "
    "rows by user decision; CI covers Windows and macOS but has never run green on the shared branch (0.3/0.4 active)."
)

ROW_Q = {
    'done_when_executable': {'type': 'noul', 'instructions': 'Can this row\'s done-when be verified by executing something (a test, a command, a measurement, an observable artefact) exactly as written?',
                             'criteria': {'true': 'Yes, as written it names something that can be run or observed and pass or fail.', 'false': 'No, it is a description, an intention or a judgement that needs rewording before work starts.'}},
    'when': {'type': 'choice', 'instructions': 'Given the Needs and their tracker states, when should this row be worked?',
             'criteria': {'now': 'Every Need is done and nothing external blocks it; it can start now.',
                          'after_needs': 'A Need is still active or pending; start after it.',
                          'external': 'Blocked on hardware, a vendor SDK, licensing, participants or another external gate.',
                          'rewrite_first': 'The done-when or the Needs must be rewritten before anyone works it.',
                          'superseded': 'The product direction has made this row historical or redundant; propose merging or dropping it.'}},
    'needs_correct': {'type': 'noul', 'instructions': 'Does the Needs column name the right dependencies for this work, given the phase and the other rows?',
                      'criteria': {'true': 'The listed Needs are the real prerequisites.', 'false': 'A prerequisite is missing, or a listed Need is not one.'}},
    'risk': {'type': 'choice', 'instructions': 'What is the main risk in this row as planned?',
             'criteria': {'none': 'No notable risk.', 'unclear_done_when': 'The done-when cannot be verified as written.',
                          'missing_dependency': 'A dependency is missing from Needs.', 'external_gate': 'Depends on hardware, a vendor, licensing or people outside the repository.',
                          'scope_too_large': 'The row bundles several deliverables and should be split.', 'superseded_by_direction': 'The product direction changed under it.'}},
}


def jev(state, questions):
    out = subprocess.run(['node', RUNNER], input=json.dumps({'state': state, 'questions': questions}).encode('utf-8'), capture_output=True)
    if out.returncode != 0:
        return {'error': out.stderr.decode('utf-8', 'replace')[-400:]}
    return json.loads(out.stdout.decode('utf-8'))


def pick(a):
    if not isinstance(a, dict):
        return a
    for k in ('choice', 'noul', 'score'):
        if k in a:
            return a[k]
    return a


def main():
    plan = json.load(open(os.path.join(HERE, 'plan-rows.json'), encoding='utf-8'))
    rows = {r['step']: r for r in plan['rows']}
    model = laya.load(MODEL)

    def ask(state, questions):
        j = jev(state, questions)
        out = model.system_one(state, questions, max_len=MAX_LEN)
        usage = out.get('usage', {})
        assert not usage.get('truncated'), usage
        return ({k: pick(v) for k, v in j.get('answers', {}).items()} if 'answers' in j else j,
                {k: pick(v) for k, v in out['answers'].items()}, usage.get('state_tokens'))

    results = {'model_laya': MODEL, 'max_len': MAX_LEN, 'rows': [], 'phases': []}
    t0 = time.time()
    open_rows = [r for r in plan['rows'] if r['state'] != 'done']
    for n, r in enumerate(open_rows, 1):
        needs = [s.strip() for s in r['needs'].replace('—', '').split(',') if s.strip()]
        state = {
            'direction': DIRECTION,
            'phase': f"{r['phase']}: {plan['phases'][r['phase']]['title']}. {plan['phases'][r['phase']]['intro'].strip()}",
            'row': {'step': r['step'], 'work': r['work'], 'track': r['track'], 'tracker_state': r['state'], 'section': r['section']},
            'needs': {s: rows.get(s, {}).get('state', 'unknown row') + ': ' + rows.get(s, {}).get('work', '') for s in needs} or 'none',
            'done_when': r['done_when'],
        }
        j, l, tokens = ask(state, ROW_Q)
        results['rows'].append({'step': r['step'], 'phase': r['phase'], 'state': r['state'], 'work': r['work'], 'needs': r['needs'], 'done_when': r['done_when'], 'jev': j, 'laya': l, 'tokens': tokens})
        print(f"{n}/{len(open_rows)} {r['step']} jev when={j.get('when')} exec={j.get('done_when_executable')} risk={j.get('risk')} | laya when={l.get('when')} exec={l.get('done_when_executable')} risk={l.get('risk')}", flush=True)
    json.dump(results, open(os.path.join(HERE, 'plan-review.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)

    for phase, info in plan['phases'].items():
        open_steps = [s for s in info['rows'] if rows[s]['state'] != 'done']
        if not open_steps:
            continue
        options = open_steps[:12]
        state = {
            'direction': DIRECTION,
            'phase': f"{phase}: {info['title']}. {info['intro'].strip()}",
            'open_rows': [{'step': s, 'state': rows[s]['state'], 'work': rows[s]['work'], 'needs': rows[s]['needs'], 'done_when': rows[s]['done_when']} for s in open_steps],
        }
        questions = {
            'order_ok': {'type': 'noul', 'instructions': 'Is the order of the open rows in this phase right as listed (each row after the rows it depends on, highest-value first otherwise)?',
                         'criteria': {'true': 'Yes, keep the order.', 'false': 'No, a reorder is needed.'}},
            'first_row': {'type': 'choice', 'instructions': 'Which open row should be worked first in this phase?',
                          'criteria': {s: rows[s]['work'][:120] for s in options}},
        }
        j, l, tokens = ask(state, questions)
        results['phases'].append({'phase': phase, 'open': open_steps, 'jev': j, 'laya': l, 'tokens': tokens})
        print(f"{phase}: jev order_ok={j.get('order_ok')} first={j.get('first_row')} | laya order_ok={l.get('order_ok')} first={l.get('first_row')}", flush=True)
    json.dump(results, open(os.path.join(HERE, 'plan-review.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print(f'{len(open_rows)} rows, {len(results["phases"])} phases in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
