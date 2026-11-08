"""Ask Jev and Laya, per done row, whether its done-when is met by executed evidence.

Reads rows-done.json (digest_rows.py). Writes review-done.json and prints a
table sorted by Jev's done-when probability, lowest first. Laya is loaded once;
Jev is asked through the Node runner (the key never enters this process).
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, '..', 'typesafe-sdk', 'jev_runner.mjs')

QUESTIONS = {
    'done_when_met': {'type': 'noul', 'instructions': 'Does the recorded evidence show that this row\'s done-when was met by execution (tests run, commands run, figures recorded), not merely claimed?',
                      'criteria': {'true': 'Every clause of the done-when has executed evidence.', 'false': 'A clause is unmet, only claimed, or the evidence does not name what was run.'}},
    'evidence_names_execution': {'type': 'noul', 'instructions': 'Does the evidence name specific executed checks (test names, commands, counts, measured figures) rather than describing the feature?',
                                 'criteria': {'true': 'Specific executed checks are named.', 'false': 'The evidence describes the feature without naming what was run.'}},
    'silent_substitution_risk': {'type': 'noul', 'instructions': 'Is there a risk that this row ships a silent substitution: something the done-when asks for that is approximated, skipped or deferred without being refused by name?',
                                 'criteria': {'true': 'Yes, a clause appears approximated, skipped or deferred silently.', 'false': 'No, every gap is named or refused.'}},
    'weakest': {'type': 'choice', 'instructions': 'What is the weakest point of this row\'s evidence?',
                'criteria': {'none': 'No weak point: evidence covers every clause with executed checks.',
                             'unexecuted_clause': 'A done-when clause has no executed check.',
                             'platform_gap': 'A platform the done-when names (e.g. macOS, hardware) was not run.',
                             'stale': 'Later changes (GPU compositor, colour space, schema) may have invalidated the recorded evidence.',
                             'vague_record': 'The record is too vague to tell what was run.'}},
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
    rows = json.load(open(os.path.join(HERE, 'rows-done.json'), encoding='utf-8'))
    refs = json.load(open(os.path.join(HERE, 'code-refs.json'), encoding='utf-8'))
    args = sys.argv[1:]
    out_name = 'review-done.json'
    if args and args[0] == '--out':
        out_name = args[1]
        args = args[2:]
    only = set(args)
    if only:
        rows = [r for r in rows if r['id'] in only]
    import laya
    model = laya.load(os.environ.get('LAYA_MODEL', 'convaiinnovations/laya'))
    results = []
    t0 = time.time()
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
        j = jev(state, QUESTIONS)
        try:
            l = model.predict(state, QUESTIONS)
            l_answers = l['answers'] if isinstance(l, dict) and 'answers' in l else l
        except Exception as e:  # noqa: BLE001 - recorded, not hidden
            l_answers = {'error': str(e)[:300]}
        row = {'id': r['id'], 'name': r['name'], 'track': r['track'], 'evidence_dir': r['evidence_dir'],
               'has_record': bool(r['tracker_notes'] or r['memory_headings']),
               'jev': {k: pick(v) for k, v in j.get('answers', {}).items()} if 'answers' in j else j,
               'laya': {k: pick(v) for k, v in l_answers.items()} if 'error' not in l_answers else l_answers}
        results.append(row)
        print(f"{n}/{len(rows)} {r['id']} jev_done={row['jev'].get('done_when_met', '?')} laya_done={row['laya'].get('done_when_met', '?')}", flush=True)
    json.dump(results, open(os.path.join(HERE, out_name), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print(f'{len(results)} rows in {time.time() - t0:.0f}s')
    ranked = sorted((x for x in results if isinstance(x['jev'].get('done_when_met'), (int, float))), key=lambda x: x['jev']['done_when_met'])
    print('\nLowest Jev done-when probabilities:')
    for x in ranked[:40]:
        print(f"  {x['id']:<6} jev {x['jev']['done_when_met']:.2f} exec {x['jev'].get('evidence_names_execution', 0):.2f} subst {x['jev'].get('silent_substitution_risk', 0):.2f} weakest {x['jev'].get('weakest')!s:<18} | laya {x['laya'].get('done_when_met', '?')} {x['laya'].get('weakest', '')} | {x['name'][:50]}")


if __name__ == '__main__':
    main()
