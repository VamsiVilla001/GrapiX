"""For each done row, find the code that cites it: test functions, conformance
checks and source comments naming the row id. Writes code-refs.json."""
import json, os, re, subprocess

ROOT = 'D:/Project KK/Personal projects/GrapiX/agent/worktree'
HERE = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(f'{HERE}/rows-done.json', encoding='utf-8'))
files = subprocess.run(['git', 'ls-files', 'Shared', 'services', 'conformance', 'tools', 'Editor/src', 'Editor/tests', 'Editor/web', 'Playout', 'mocks', 'tests', 'docs/evidence'],
                       cwd=ROOT, capture_output=True, text=True).stdout.split()
files = [f for f in files if re.search(r'\.(rs|ts|mjs|md|json)$', f) and 'generated-ts' not in f and 'node_modules' not in f]
texts = {}
for f in files:
    try:
        texts[f] = open(f'{ROOT}/{f}', encoding='utf-8', errors='replace').read()
    except OSError:
        pass
fn_re = re.compile(r'^\s*(?:pub(?:\(crate\))? )?fn (\w+)|^\s*(?:it|test)\(\s*["\'`](.+?)["\'`]', re.M)
out = {}
for r in rows:
    rid = r['id']
    pat = re.compile(r'(?<![\d.])' + re.escape(rid) + r'(?![\d.])')
    refs = {'files': [], 'tests': [], 'conformance_checks': 0, 'evidence_docs': []}
    for f, s in texts.items():
        if not pat.search(s):
            continue
        if f.startswith('docs/evidence'):
            refs['evidence_docs'].append(f)
            continue
        refs['files'].append(f)
        # test functions whose body or the 12 lines before them mention the row
        for m in pat.finditer(s):
            before = s[max(0, m.start() - 1500):m.start()]
            after = s[m.start():m.start() + 600]
            fns = fn_re.findall(before)
            if fns:
                name = fns[-1][0] or fns[-1][1]
                if ('#[test]' in before[-600:] or 'tests/' in f or '.test.' in f) and name not in refs['tests']:
                    refs['tests'].append(name)
            if 'report.record(' in after[:200] or 'report.record(' in before[-200:]:
                refs['conformance_checks'] += 1
    refs['tests'] = refs['tests'][:12]
    refs['files'] = refs['files'][:12]
    out[rid] = refs
json.dump(out, open(f'{HERE}/code-refs.json', 'w', encoding='utf-8'), indent=1)
none = [k for k, v in out.items() if not v['files'] and not v['evidence_docs']]
print(len(out), 'rows;', sum(1 for v in out.values() if v['tests']), 'with named tests;', len(none), 'with no code citation:', ' '.join(none))
