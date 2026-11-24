import os, shutil, subprocess, sys, tempfile

WT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
OUT = tempfile.mkdtemp(prefix="gx-registry-mutants-")  # the logs of each run; not kept
R = os.path.join(WT, "Editor", "src", "command-registry.ts")
M = os.path.join(WT, "Editor", "src", "app-menu.ts")
P = os.path.join(WT, "Editor", "web", "main.ts")
TESTS = "npx vitest run Editor/tests/command-registry.test.ts Editor/tests/app-menu.test.ts Editor/tests/save-model.test.ts Editor/tests/arrange.test.ts"

MUTANTS = [
    # what a command needs
    ("scene-not-needed", R, 'const needScene: Rule = (c) => (c.sceneOpen ? undefined : "no scene is open");', 'const needScene: Rule = () => undefined;'),
    ("project-not-needed", R, 'const needProject: Rule = (c) => (c.projectOpen ? undefined : "no project is open");', 'const needProject: Rule = () => undefined;'),
    ("selection-zero-ok", R, "c.selectionCount > 0 ? undefined : \"select an object first\"", "c.selectionCount >= 0 ? undefined : \"select an object first\""),
    ("keys-zero-ok", R, "c.selectedKeyCount > 0 ? undefined", "c.selectedKeyCount >= 0 ? undefined"),
    ("copied-zero-ok", R, "c.copiedKeyCount > 0 ? undefined", "c.copiedKeyCount >= 0 ? undefined"),
    ("busy-ignored", R, 'const needIdle: Rule = (c) => (c.busy ? BUSY_REASON : undefined);', 'const needIdle: Rule = () => undefined;'),
    ("all-stops-at-last", R, "      const reason = rule(context);\n      if (reason !== undefined) return reason;\n    }\n    return undefined;", "      const reason = rule(context);\n      if (rule === rules[rules.length - 1] && reason !== undefined) return reason;\n    }\n    return undefined;"),
    ("undo-without-history", R, '"edit.undo": all(needIdle, (c) => (c.canUndo ? undefined : "there is nothing to undo")),', '"edit.undo": all(needIdle),'),
    ("redo-uses-undo", R, '(c.canRedo ? undefined : "there is nothing to redo")', '(c.canUndo ? undefined : "there is nothing to redo")'),
    ("rename-any-count", R, '"edit.rename": all(needScene, needOneObject, needIdle),', '"edit.rename": all(needScene, needSelection, needIdle),'),
    ("rename-two-ok", R, "c.selectionCount === 1 ? undefined", "c.selectionCount >= 1 ? undefined"),
    ("save-while-busy", R, '"file.save": all(needScene, needIdle),', '"file.save": all(needScene),'),
    ("next-version-no-scene", R, '"file.next-version": all(needScene, needIdle),', '"file.next-version": all(needIdle),'),
    ("save-as-needs-scene", R, '"file.save-as": needProject,', '"file.save-as": needScene,'),
    ("paste-needs-selection", R, '"motion.paste-keys": all(needScene, needCopiedKeys, needIdle),', '"motion.paste-keys": all(needScene, needKeys, needIdle),'),
    ("copy-needs-copied", R, '"motion.copy-keys": all(needScene, needKeys),', '"motion.copy-keys": all(needScene, needCopiedKeys),'),
    ("arrange-refusal-dropped", R, "RULES[`edit.line-up.${command.replace(/^line-/, \"\")}`] = all(needScene, needIdle, (c) => c.arrangeRefusal(command));", "RULES[`edit.line-up.${command.replace(/^line-/, \"\")}`] = all(needScene, needIdle);"),
    ("unbuilt-can-run", R, "  if (actionOf(command) === \"unbuilt\") return `not built yet (plan row ${command.row})`;\n", ""),
    ("unknown-id-can-run", R, "  if (command === undefined) return `there is no command ${id}`;", "  if (command === undefined) return undefined;"),
    ("changes-doc-loses-ease", R, '  "motion.easy-ease",\n  "motion.easy-ease-in",', '  "motion.easy-ease-in",'),
    # the agent's view
    ("agent-reason-dropped", R, "      : { name: command.id, label: command.label, unavailable: reason };", "      : { name: command.id, label: command.label };"),
    ("refusal-line-keeps-ellipsis", R, 'label.replace(/…$/, "")', "label"),
    # keys
    ("save-key-is-version", R, '{ chord: ctrl("s"), command: "file.save", label: "Ctrl S" },', '{ chord: ctrl("s"), command: "file.next-version", label: "Ctrl S" },'),
    ("shift-ignored", R, "s.chord.ctrl === control && s.chord.shift === press.shiftKey", "s.chord.ctrl === control"),
    ("ctrl-ignored", R, "s.chord.key === key && s.chord.ctrl === control &&", "s.chord.key === key &&"),
    ("meta-not-ctrl", R, "const control = press.ctrlKey || press.metaKey;", "const control = press.ctrlKey;"),
    ("alt-allowed", R, "  if (press.altKey) return undefined;\n", ""),
    ("case-sensitive-key", R, "const key = press.key.toLowerCase();", "const key = press.key;"),
    ("text-field-loses-key", R, 'if (press.defaultPrevented || focus.editing) return { kind: "pass" };', 'if (press.defaultPrevented) return { kind: "pass" };'),
    ("prevented-key-reused", R, 'if (press.defaultPrevented || focus.editing)', 'if (focus.editing)'),
    ("button-keeps-space-dropped", R, 'if (focus.control && shortcut.chord.key === " ") return { kind: "pass" };', ""),
    ("button-takes-every-key", R, 'if (focus.control && shortcut.chord.key === " ") return { kind: "pass" };', 'if (focus.control) return { kind: "pass" };'),
    ("refused-runs-anyway", R, "  return reason === undefined\n    ? { kind: \"run\", command: shortcut.command }", "  return true\n    ? { kind: \"run\", command: shortcut.command }"),
    ("quiet-flag-lost", R, "quiet: shortcut.quiet === true || reason === BUSY_REASON", "quiet: false"),
    ("copy-not-quiet", R, 'label: "Ctrl C", quiet: true', 'label: "Ctrl C"'),
    ("delete-not-quiet", R, 'label: "Delete", quiet: true', 'label: "Delete"'),
    ("busy-key-says-it", R, "quiet: shortcut.quiet === true || reason === BUSY_REASON", "quiet: shortcut.quiet === true"),
    ("undo-no-repeat", R, 'label: "Ctrl Z", repeats: true', 'label: "Ctrl Z"'),
    ("redo-key-no-repeat", R, 'label: "Ctrl Shift Z", repeats: true', 'label: "Ctrl Shift Z"'),
    ("every-key-repeats", R, "if (press.repeat && shortcut.repeats !== true) return { kind: \"pass\" };", ""),
    ("space-repeats", R, '{ chord: plain(" "), command: "motion.play", label: "Space" }', '{ chord: plain(" "), command: "motion.play", label: "Space", repeats: true }'),
    ("history-needs-scene", R, '  "edit.undo": all(needIdle,', '  "edit.history": needScene,\n  "edit.undo": all(needIdle,'),
    ("preset-needs-no-object", R, '"motion.preset-in": all(needScene, needObjectForPreset, needPreset, needIdle),', '"motion.preset-in": all(needScene, needPreset, needIdle),'),
    ("preset-needs-no-preset", R, '"motion.preset-out": all(needScene, needObjectForPreset, needPreset, needIdle),', '"motion.preset-out": all(needScene, needObjectForPreset, needIdle),'),
    ("page-copy-takes-selected-text", P, '  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && (window.getSelection()?.toString() ?? "") !== "") return;\n', ""),
    ("redo-alias-lost", R, '  { chord: ctrl("y"), command: "edit.redo", repeats: true },\n', ""),
    ("backspace-alias-lost", R, '  { chord: plain("backspace"), command: "motion.delete-keys", quiet: true },\n', ""),
    ("space-label-wrong", R, 'command: "motion.play", label: "Space"', 'command: "motion.play", label: "Spacebar"'),
    # the menu
    ("menu-shortcut-dropped", M, 'cmd("motion.copy-keys", "Copy selected keys", "grapix", { native: "copy-keys", shortcut: "Ctrl C" }),', 'cmd("motion.copy-keys", "Copy selected keys", "grapix", { native: "copy-keys" }),'),
    ("menu-item-lost", M, '      cmd("motion.paste-keys", "Paste keys", "grapix", { native: "paste-keys", shortcut: "Ctrl V" }),\n', ""),
    ("menu-native-wrong", M, '{ native: "easy-ease-in", shortcut: "Shift F9" }', '{ native: "easy-ease", shortcut: "Shift F9" }'),
    # the page
    ("page-key-handler-gone", P, '  document.addEventListener("keydown", onCommandKey);\n', ""),
    ("page-refusal-silent", P, "    log(refusalLine(decision.command, decision.reason), \"bad\");\n    return;\n  }\n  event.preventDefault();", "    return;\n  }\n  event.preventDefault();"),
    ("page-menu-skips-registry", P, "    if (itemId !== undefined && refusal !== undefined) {", "    if (false) {"),
    ("page-undo-unscoped", P, 'void (id === "edit.undo" ? undo(focusedPanelModule()) : redo(focusedPanelModule()));', 'void (id === "edit.undo" ? undo() : redo());'),
    ("page-delete-keys-no-clear", P, "  void runKeyEdit(planDelete([...selectedKeys]));\n  setKeySelection([]);", "  void runKeyEdit(planDelete([...selectedKeys]));"),
    ("page-ease-in-wrong", P, '    case "easy-ease-in":\n      easeKeys("in");', '    case "easy-ease-in":\n      easeKeys("both");'),
    ("page-menu-states-not-shown", P, "      showMenuStates(menu);\n", ""),
]

only = set(sys.argv[1:])
results = []
for name, path, old, new in MUTANTS:
    if only and name not in only:
        continue
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
        log = os.path.join(OUT, "mutreg_%s.log" % name)
        with open(log, "wb") as fh:
            rc = subprocess.run(TESTS, cwd=WT, stdout=fh, stderr=subprocess.STDOUT, timeout=300, shell=True).returncode
        body = open(log, "rb").read().decode("utf-8", "replace")
        if rc == 0:
            verdict = "SURVIVED"
        elif "error TS" in body or "SyntaxError" in body:
            verdict = "BUILD ERROR"
        else:
            failed = [l.strip()[:90] for l in body.splitlines() if "×" in l or " FAIL " in l]
            verdict = "KILLED by " + " | ".join(failed[:1])
        results.append((name, verdict))
    finally:
        shutil.copyfile(backup, path)
        os.remove(backup)
        print(results[-1] if results else "", flush=True)

print("---")
for name, verdict in results:
    print("%-36s %s" % (name, verdict.encode("ascii", "replace").decode("ascii")))
print("killed %d of %d" % (sum(1 for _, v in results if v.startswith("KILLED")), len(results)))
