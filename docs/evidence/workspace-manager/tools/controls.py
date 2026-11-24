"""Make the negative controls for the Jev and Laya review: what a deliberately broken build returns (23 Nov 2026).

For a chosen fact, one mutant of mutate_dock.py is applied to the source, facts.ts is bundled and run against
that broken source, and the fact's outcome is kept as its `broken` outcome. The source is restored in a
`finally`. A control is only kept when the broken outcome differs from the true one; a pair that does not
differ is reported and dropped, because it could not tell a right answer from a wrong one.

  python controls.py      (from this folder; needs node and npx esbuild; writes ../controls.json)

Nothing here asks a classifier anything. review_run.py does, with facts.json and controls.json.
"""
import io, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
TMP = tempfile.mkdtemp(prefix='gx-dock-controls-')

# Which broken build shows each rule being broken. Chosen so the difference is in what the fact prints.
PAIRS = {
    'E2': 'alone-beside-self-allowed',
    'E3': 'group-onto-itself-allowed',
    'E5': 'weights-length-unchecked',
    'E6': 'open-ignores-unavailable',
    'E7': 'unavailable-app-ignored',
    'E8': 'open-singleton-second-allowed',
    'E9': 'close-unclosable-allowed',
    'E11': 'rule4-sum-unchecked',
    'E13': 'rule9-key-ignored',
    'E14': 'registry-duplicate-allowed',
    'E15': 'registry-single-and-many-allowed',
    'A1': 'center-not-activated',
    'A2': 'wrap-order-swapped',
    'A3': 'side-drop-half-wrong',
    'A4': 'one-child-split-kept',
    'A5': 'weights-not-normalised',
    'A7': 'divider-pair-sum-lost',
    'A8': 'focus-active-group-lost',
    'A9': 'open-not-activated',
    'A10': 'open-duplicates-open-panel',
    'A11': 'fix6-centre-uses-stored-size',
    'A12': 'alias-not-applied',
    'A13': 'unavailable-list-empty',
    'A14': 'rule3-maximised-unchecked',
}

src = io.open(os.path.join(HERE, 'mutate_dock.py'), encoding='utf-8').read()
ns = {'__file__': os.path.join(HERE, 'mutate_dock.py')}
exec(src.split('only = set(sys.argv[1:])')[0], ns)
MUTANTS = {name: (path, old, new) for name, path, old, new in ns['MUTANTS']}
SHELL = os.name == 'nt'


def facts_now():
    """Bundle facts.ts against the source as it is now and run it. Returns (facts by id, crash text or None)."""
    bundle = os.path.join(TMP, 'facts.mjs')
    out = os.path.join(TMP, 'facts.json')
    if os.path.exists(out):
        os.remove(out)
    built = subprocess.run(f'npx esbuild docs/evidence/workspace-manager/tools/facts.ts --bundle --platform=node --format=esm --outfile="{bundle}"',
                           cwd=WT, shell=True, capture_output=True)
    if built.returncode != 0:
        return {}, 'the broken source does not build: ' + built.stderr.decode('utf-8', 'replace')[-200:]
    ran = subprocess.run(['node', bundle, out], cwd=WT, capture_output=True)
    if ran.returncode != 0 or not os.path.exists(out):
        lines = [l for l in ran.stderr.decode('utf-8', 'replace').splitlines() if 'Error' in l]
        return {}, 'THREW ' + (lines[0].strip() if lines else 'the program stopped')
    return {f['id']: f for f in json.load(open(out, encoding='utf-8'))}, None


true_facts, crash = facts_now()
assert crash is None, crash
controls, dropped = {}, []
for fact_id, mutant in PAIRS.items():
    path, old, new = MUTANTS[mutant]
    backup = path + '.ctlbak'
    shutil.copyfile(path, backup)
    try:
        text = io.open(path, encoding='utf-8', newline='').read()
        crlf = '\r\n' in text
        o = old.replace('\n', '\r\n') if crlf else old
        n = new.replace('\n', '\r\n') if crlf else new
        assert text.count(o) == 1, (mutant, text.count(o))
        io.open(path, 'w', encoding='utf-8', newline='').write(text.replace(o, n))
        broken, crash = facts_now()
    finally:
        shutil.copyfile(backup, path)
        os.remove(backup)
    outcome = crash if crash is not None else broken[fact_id]['outcome']
    if outcome == true_facts[fact_id]['outcome']:
        dropped.append((fact_id, mutant))
        print('DROPPED (no visible difference):', fact_id, mutant, flush=True)
        continue
    controls[fact_id] = {'mutant': mutant, 'outcome': outcome}
    print('control', fact_id, mutant, '->', outcome[:110].replace('\n', ' '), flush=True)

# The source must be as it was: the facts made now must equal the facts made at the start.
after, crash = facts_now()
assert crash is None and after == true_facts, 'the source was not restored'
json.dump({'controls': controls, 'dropped': dropped}, open(os.path.join(HERE, '..', 'controls.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
json.dump(list(true_facts.values()), open(os.path.join(HERE, '..', 'facts.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
shutil.rmtree(TMP, ignore_errors=True)
print(f'{len(controls)} controls, {len(dropped)} dropped; facts.json rewritten from the restored source')
