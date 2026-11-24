import os, shutil, subprocess

WT = r"D:\Project KK\Personal projects\GrapiX\agent\worktree"
OUT = os.path.dirname(os.path.abspath(__file__))
TS = os.path.join(WT, "Editor", "src", "arrange.ts")
MENU = os.path.join(WT, "Editor", "src", "app-menu.ts")
MAIN = os.path.join(WT, "Editor", "web", "main.ts")
WEB = "npx vitest run Editor/tests/arrange.test.ts"

MUTANTS = [
    ("right-edge-uses-left", TS, "      return { dx: reference.x + reference.width - (box.x + box.width), dy: 0 };", "      return { dx: reference.x - box.x, dy: 0 };"),
    ("centre-uses-edge", TS, "      return { dx: reference.x + reference.width / 2 - (box.x + box.width / 2), dy: 0 };", "      return { dx: reference.x + reference.width / 2 - box.x, dy: 0 };"),
    ("bottom-uses-top", TS, "      return { dx: 0, dy: reference.y + reference.height - (box.y + box.height) };", "      return { dx: 0, dy: reference.y - box.y };"),
    ("middle-height-ignored", TS, "      return { dx: 0, dy: reference.y + reference.height / 2 - (box.y + box.height / 2) };", "      return { dx: 0, dy: reference.y + reference.height / 2 - (box.y + box.height) };"),
    ("reference-is-first-item", TS, "const reference = outer(placed.map((item) => item.box));", "const reference = placed[0]!.box;"),
    ("outer-box-height-from-top", TS, "    height: Math.max(...boxes.map((box) => box.y + box.height)) - top,", "    height: Math.max(...boxes.map((box) => box.height)),"),
    ("rotation-ignored", TS, "const placed: Placed[] = selected.map((object) => ({ object, box: objectOverlayBounds(object) }));", "const placed: Placed[] = selected.map((object) => ({ object, box: { x: object.x, y: object.y, width: object.width, height: object.height } }));"),
    ("noise-sent", TS, "if (Math.abs(dx) > NOISE) {", "if (dx !== 0) {"),
    ("no-tidy", TS, "return Math.round(value * 1e6) / 1e6;", "return value;"),
    ("locked-allowed", TS, "const locked = selected.filter((object) => object.locked);", "const locked: SceneObject[] = [];"),
    ("boxless-allowed", TS, "const boxless = selected.filter((object) => NO_BOX.has(object.type));", "const boxless: SceneObject[] = [];"),
    ("mixed-groups-allowed", TS, "if (new Set(selected.map((object) => parents.get(object.id) ?? \"\")).size > 1) {", "if (false) {"),
    ("top-level-vs-group-allowed", TS, "selected.map((object) => parents.get(object.id) ?? \"\")", "selected.map((object) => parents.get(object.id) ?? object.id)"),
    ("spread-needs-two", TS, "if (selected.length < (spread ? 3 : 2)) {", "if (selected.length < 2) {"),
    ("line-needs-one", TS, "if (selected.length < (spread ? 3 : 2)) {", "if (selected.length < (spread ? 3 : 1)) {"),
    ("spread-by-selection-order", TS, "const ordered = [...placed].sort((a, b) => start(a) + size(a) / 2 - (start(b) + size(b) / 2));", "const ordered = [...placed];"),
    ("spread-gap-ignores-sizes", TS, "ordered.reduce((sum, item) => sum + size(item), 0)) / (ordered.length - 1);", "0) / (ordered.length - 1);"),
    ("spread-gap-off-by-one", TS, "- start(first) - ordered.reduce((sum, item) => sum + size(item), 0)) / (ordered.length - 1);", "- start(first) - ordered.reduce((sum, item) => sum + size(item), 0)) / ordered.length;"),
    ("spread-cursor-ignores-size", TS, "at += size(item) + gap;", "at += gap;"),
    ("spread-down-moves-x", TS, "edits.push(...(across ? move(item, delta, 0) : move(item, 0, delta)));", "edits.push(...move(item, delta, 0));"),
    ("spread-by-left-edge-not-centre", TS, "start(a) + size(a) / 2 - (start(b) + size(b) / 2)", "start(a) - start(b)"),
    ("nothing-to-move-sent-empty", TS, "  if (edits.length === 0) {\n    return { refused: spread", "  if (false) {\n    return { refused: spread"),
    ("word-wrong", TS, "  middle: \"middles down\",", "  middle: \"middles\","),
    ("menu-item-missing", MENU, "          cmd(\"edit.line-up.bottom\", \"Line up bottom edges\", \"grapix\", { native: \"arrange-line-bottom\" }),\n", ""),
    ("page-tag-wrong", MAIN, "arrangeLabel(command, outcome.length), \"viewport\");", "arrangeLabel(command, outcome.length));"),
]

results = []
for name, path, old, new in MUTANTS:
    backup = path + ".mutbak"
    shutil.copyfile(path, backup)
    try:
        text = open(path, encoding="utf-8", newline="").read()
        crlf = "\r\n" in text
        o = old.replace("\n", "\r\n") if crlf else old
        n = new.replace("\n", "\r\n") if crlf else new
        if text.count(o) != 1:
            results.append((name, "NOT-APPLIED (pattern count %d)" % text.count(o)))
            continue
        open(path, "w", encoding="utf-8", newline="").write(text.replace(o, n))
        log = os.path.join(OUT, "mutarr_%s.log" % name)
        with open(log, "wb") as fh:
            rc = subprocess.run(WEB, cwd=WT, stdout=fh, stderr=subprocess.STDOUT, timeout=300, shell=True).returncode
        body = open(log, "rb").read().decode("utf-8", "replace")
        if rc == 0:
            verdict = "SURVIVED"
        elif "error TS" in body:
            verdict = "BUILD ERROR"
        else:
            failed = [l.strip()[:100] for l in body.splitlines() if "\u00d7" in l or " FAIL " in l]
            verdict = "KILLED by " + " | ".join(failed[:2])
        results.append((name, verdict))
    finally:
        shutil.copyfile(backup, path)
        os.remove(backup)
        print(results[-1] if results else "", flush=True)

print("---")
for name, verdict in results:
    print("%-32s %s" % (name, verdict.encode("ascii", "replace").decode("ascii")))
