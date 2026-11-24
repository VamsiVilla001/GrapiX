import os, shutil, subprocess, sys, tempfile

WT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
OUT = tempfile.mkdtemp(prefix="gx-tools-mutants-")  # the logs of each run; not kept
T = os.path.join(WT, "Editor", "src", "transform-tools.ts")
R = os.path.join(WT, "Editor", "src", "command-registry.ts")
P = os.path.join(WT, "Editor", "web", "main.ts")
H = os.path.join(WT, "Editor", "web", "index.html")
TESTS = "npx vitest run Editor/tests/transform-tools.test.ts Editor/tests/tool-ribbon.test.ts Editor/tests/command-registry.test.ts Editor/tests/app-menu.test.ts"

MUTANTS = [
    # starting a drag
    ("no-selection-allowed", T, '  if (objects.length === 0) return { refused: "Select an object first." };', ""),
    ("locked-allowed", T, "  if (locked.length > 0) {", "  if (false) {"),
    ("locked-wording", T, "Unlock ${locked.length === 1 ? \"it\" : \"them\"} first; nothing was changed.", "Unlock first."),
    ("locked-group-allowed", T, "      if (group?.locked === true) {", "      if (false) {"),
    ("locked-group-parent-only", T, "    for (let at = parents.get(object.id), seen = new Set<string>(); at !== undefined && !seen.has(at); at = parents.get(at)) {\n      seen.add(at);\n      const group = byId.get(at);\n      if (group?.locked === true) {", "    for (let at = parents.get(object.id), seen = new Set<string>(); at !== undefined && !seen.has(at); at = undefined) {\n      seen.add(at);\n      const group = byId.get(at);\n      if (group?.locked === true) {"),
    ("group-check-dropped", T, "  if (inGroup.length > 0) {", "  if (false) {"),
    ("move-blocked-in-plain-group", T, "const blocked = tool === \"move\" ? inGroup.filter(turned) : inGroup;", "const blocked = inGroup;"),
    ("rotate-allowed-in-group", T, "const blocked = tool === \"move\" ? inGroup.filter(turned) : inGroup;", "const blocked = tool === \"move\" ? inGroup.filter(turned) : [];"),
    ("turned-ignores-rotation", T, "group.rotation !== 0 || group.scaleX !== 1 || group.scaleY !== 1", "group.scaleX !== 1 || group.scaleY !== 1"),
    ("turned-ignores-scale-y", T, "group.rotation !== 0 || group.scaleX !== 1 || group.scaleY !== 1", "group.rotation !== 0 || group.scaleX !== 1"),
    ("turned-only-parent", T, "at = parents.get(at)) {\n        seen.add(at);\n        const group = byId.get(at);\n        if (group !== undefined &&", "at = undefined) {\n        seen.add(at);\n        const group = byId.get(at);\n        if (group !== undefined &&"),
    ("animated-allowed", T, "    const animated = TOOL_FIELDS[tool].find((field) => isAnimated(document, object.id, field));", "    const animated = undefined as string | undefined;"),
    ("animated-empty-channel", T, "channel.property === field && channel.keys.length > 0", "channel.property === field"),
    ("animated-any-object", T, "channel.objectId === id && channel.property === field", "channel.property === field"),
    ("move-fields-lose-y", T, '  move: ["x", "y"],', '  move: ["x"],'),
    ("rotate-fields-lose-position", T, '  rotate: ["rotation", "x", "y"],', '  rotate: ["rotation"],'),
    ("selection-roots-dropped", T, "  const objects = selectionRoots(document, selectedIds).flatMap((id) => {", "  const objects = selectedIds.flatMap((id) => {"),
    ("centre-from-start", T, "  const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };", "  const centre = start;"),
    ("centre-ignores-box", T, "  return NO_BOX.has(object.type) ? { x: object.x, y: object.y, width: 0, height: 0 } : objectOverlayBounds(object);", "  return { x: object.x, y: object.y, width: 0, height: 0 };"),
    ("centre-from-stored", T, "boxOf(drawn.get(object.id) ?? object)", "boxOf(object)"),
    ("start-on-middle-allowed", T, "  if (tool !== \"move\" && Math.hypot(start.x - centre.x, start.y - centre.y) < MIN_RADIUS) {", "  if (false) {"),
    ("start-on-middle-move-too", T, "  if (tool !== \"move\" && Math.hypot(", "  if (Math.hypot("),
    ("start-guard-off-by-one", T, "Math.hypot(start.x - centre.x, start.y - centre.y) < MIN_RADIUS", "Math.hypot(start.x - centre.x, start.y - centre.y) <= MIN_RADIUS"),
    # move
    ("move-no-shift-lock", T, "    if (modifiers.shift) {\n      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;\n      else dx = 0;\n    }", ""),
    ("move-shift-wrong-axis", T, "      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;\n      else dx = 0;", "      if (Math.abs(dx) >= Math.abs(dy)) dx = 0;\n      else dy = 0;"),
    ("move-y-inverted", T, "      push(item, \"y\", item.y + dy);", "      push(item, \"y\", item.y - dy);"),
    ("move-from-origin", T, "    let dx = current.x - drag.start.x;", "    let dx = current.x;"),
    # rotate
    ("rotate-counter", T, "drag.turn.total += wrapDegrees(angle - drag.turn.angle);", "drag.turn.total += wrapDegrees(drag.turn.angle - angle);"),
    ("rotate-no-wrap", T, "drag.turn.total += wrapDegrees(angle - drag.turn.angle);", "drag.turn.total += angle - drag.turn.angle;"),
    ("rotate-turn-not-added", T, "drag.turn.total += wrapDegrees(angle - drag.turn.angle);", "drag.turn.total = wrapDegrees(angle - drag.turn.angle);"),
    ("rotate-angle-not-moved", T, "      drag.turn.angle = angle;\n", ""),
    ("rotate-from-fixed-start", T, "      drag.turn.total += wrapDegrees(angle - drag.turn.angle);\n      drag.turn.angle = angle;", "      drag.turn.total = wrapDegrees(angle - angleTo(drag.centre, drag.start));"),
    ("rotate-middle-gives-angle", T, "    if (radius > NOISE) {", "    if (true) {"),
    ("rotate-no-snap", T, "      sweep = Math.round((first.rotation + sweep) / SNAP_DEGREES) * SNAP_DEGREES - first.rotation;", ""),
    ("rotate-snap-sweep-only", T, "      sweep = Math.round((first.rotation + sweep) / SNAP_DEGREES) * SNAP_DEGREES - first.rotation;", "      sweep = Math.round(sweep / SNAP_DEGREES) * SNAP_DEGREES;"),
    ("rotate-snap-size", T, "export const SNAP_DEGREES = 15;", "export const SNAP_DEGREES = 10;"),
    ("rotate-replaces-rotation", T, "      push(item, \"rotation\", item.rotation + sweep);", "      push(item, \"rotation\", sweep);"),
    ("rotate-no-orbit", T, "      push(item, \"x\", drag.centre.x + relX * cos - relY * sin);\n      push(item, \"y\", drag.centre.y + relX * sin + relY * cos);\n", ""),
    ("rotate-orbit-direction", T, "      push(item, \"y\", drag.centre.y + relX * sin + relY * cos);", "      push(item, \"y\", drag.centre.y - relX * sin + relY * cos);"),
    ("wrap-keeps-minus-180", T, "  return wrapped === -180 ? 180 : wrapped;", "  return wrapped;"),
    # scale
    ("scale-factor-inverted", T, "const factor = Math.max(MIN_SCALE, radius / startRadius);", "const factor = Math.max(MIN_SCALE, startRadius / radius);"),
    ("scale-no-floor", T, "const factor = Math.max(MIN_SCALE, radius / startRadius);", "const factor = radius / startRadius;"),
    ("scale-snaps-back-near-middle", T, "  const factor = Math.max(MIN_SCALE, radius / startRadius);", "  if (radius < MIN_RADIUS) return out;\n  const factor = Math.max(MIN_SCALE, radius / startRadius);"),
    ("scale-replaces-scale", T, "    push(item, \"scaleX\", item.scaleX * factor);", "    push(item, \"scaleX\", factor);"),
    ("scale-one-axis", T, "    push(item, \"scaleY\", item.scaleY * factor);\n", ""),
    ("scale-no-position", T, "    push(item, \"x\", drag.centre.x + (item.x - drag.centre.x) * factor);\n    push(item, \"y\", drag.centre.y + (item.y - drag.centre.y) * factor);\n", ""),
    ("scale-position-by-start", T, "    push(item, \"x\", drag.centre.x + (item.x - drag.centre.x) * factor);", "    push(item, \"x\", item.x * factor);"),
    # what is sent and shown
    ("unchanged-fields-sent", T, "    if (Math.abs(rounded - item[field]) > NOISE) out.push({ id: item.id, field, value: rounded });", "    out.push({ id: item.id, field, value: rounded });"),
    ("compare-before-rounding", T, "    if (Math.abs(rounded - item[field]) > NOISE) out.push({ id: item.id, field, value: rounded });", "    if (Math.abs(value - item[field]) > NOISE) out.push({ id: item.id, field, value: rounded });"),
    ("edits-lose-object", T, "    objectIds: [change.id],", "    objectIds: [],"),
    ("edits-wrong-field", T, "    field: { name: change.field, value: change.value },", "    field: { name: \"x\", value: change.value },"),
    ("preview-writes-document", T, "  return {\n    ...document,\n    objects: document.objects.map((object) => {", "  document.objects.forEach((object) => Object.assign(object, Object.fromEntries((byObject.get(object.id) ?? []).map((c) => [c.field, c.value]))));\n  return {\n    ...document,\n    objects: document.objects.map((object) => {"),
    ("preview-all-objects", T, "      return own === undefined ? object : ({ ...object, ...Object.fromEntries(own.map((c) => [c.field, c.value])) } as SceneObject);", "      return ({ ...object, ...Object.fromEntries((own ?? changes).map((c) => [c.field, c.value])) } as SceneObject);"),
    ("label-move-wrong", T, "return `Moved ${who} by ${tidy(dx)}, ${tidy(dy)}`;", "return `Moved ${who}`;"),
    ("label-scale-percent", T, "return `Scaled ${who} to ${Math.round(grown * 100)}%`;", "return `Scaled ${who} to ${grown}%`;"),
    # the registry, the ribbon and the page
    ("tool-needs-no-scene", R, '  "edit.move": needScene,\n', ""),
    ("v-key-lost", R, '  { chord: plain("v"), command: "edit.pointer", label: "V", quiet: true },\n', ""),
    ("w-key-is-rotate", R, '{ chord: plain("w"), command: "edit.move", label: "W", quiet: true }', '{ chord: plain("w"), command: "edit.rotate", label: "W", quiet: true }'),
    ("letter-keys-noisy", R, '{ chord: plain("w"), command: "edit.move", label: "W", quiet: true }', '{ chord: plain("w"), command: "edit.move", label: "W" }'),
    ("ribbon-button-lost", H, '          <button id="tool-rotate" type="button" title="Rotate (E)" aria-label="Rotate tool" data-icon="tool-rotate" data-tool="rotate" data-menu-item="edit.rotate" aria-pressed="false"></button>\n', ""),
    ("align-wrong-action", H, 'data-native="arrange-line-right" data-menu-item="edit.line-up.right"', 'data-native="arrange-line-left" data-menu-item="edit.line-up.right"'),
    ("page-no-hit-select", P, "    if (hit !== undefined && !isSelectedOrInsideSelected(hit)) setSelection([hit]);\n", ""),
    ("page-group-child-reselects", P, "    if (selection.includes(at)) return true;\n    seen.add(at);", "    seen.add(at);"),
    ("page-additive-takes-tool", P, "  if (activeTool !== \"select\" && scene && !additive) {", "  if (activeTool !== \"select\" && scene) {"),
    ("page-refusal-never-told", P, "      log(`${toolWords(activeTool)}: ${overlayDrag.refusal}`, \"bad\");\n", ""),
    ("page-refusal-told-every-move", P, "    if (overlayDrag.told !== true) {\n      overlayDrag.told = true;", "    if (true) {\n      overlayDrag.told = true;"),
    ("page-refusal-blocks-click", P, "  if (drag.refusal !== undefined && drag.moved) {", "  if (drag.refusal !== undefined) {"),
    ("page-refusal-lets-drag-through", P, "  if (overlayDrag.refusal !== undefined) {\n    // Dragging", "  if (false) {\n    // Dragging"),
    ("page-playback-not-paused", P, "  if (tool !== undefined && playback !== undefined) pausePreview(\"moving an object\");", ""),
    ("page-preview-not-drawn", P, "    viewport?.updateDocument(toolPreview);\n    viewport?.render();\n    renderOverlayLayer();\n    return;", "    return;"),
    ("page-preview-not-rendered", P, "    viewport?.updateDocument(toolPreview);\n    viewport?.render();", "    viewport?.updateDocument(toolPreview);"),
    ("page-drop-not-rendered", P, "    viewport?.updateDocument(previewScene);\n    viewport?.render();\n  }\n  renderOverlayLayer();", "    viewport?.updateDocument(previewScene);\n  }\n  renderOverlayLayer();"),
    ("page-begin-uses-stored", P, "beginToolDrag(activeTool, scene, selection, start, previewScene)", "beginToolDrag(activeTool, scene, selection, start)"),
    ("page-commit-unbatched", P, "void runEdits(toolDragEdits(changes), toolDragLabel(drag.tool, changes), \"viewport\").finally(dropToolPreview);", "for (const edit of toolDragEdits(changes)) void runEdits([edit], toolDragLabel(drag.tool, changes), \"viewport\");"),
    ("page-cancel-commits", P, "const changes = cancelled ? [] : toolDragChanges(", "const changes = toolDragChanges("),
    ("page-escape-clears-selection", P, "    if (!dropped) setSelection([]);", "    setSelection([]);"),
    ("page-escape-after-release-clears", P, "const dropped = overlayDrag?.tool !== undefined || toolPreview !== null;", "const dropped = overlayDrag?.tool !== undefined;"),
    ("page-tool-not-gated", P, "      if (id !== undefined && commandUnavailable(id, commandContext()) !== undefined) return;\n      setActiveTool(", "      setActiveTool("),
    ("page-ribbon-stuck-busy", P, "    showRibbonStates();\n  }\n}\n\n/// The module a panel's gestures belong to", "  }\n}\n\n/// The module a panel's gestures belong to"),
    ("page-ribbon-states-lost", P, "  showRibbonStates();\n  // Every edit", "  // Every edit"),
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
        log = os.path.join(OUT, "muttool_%s.log" % name)
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
