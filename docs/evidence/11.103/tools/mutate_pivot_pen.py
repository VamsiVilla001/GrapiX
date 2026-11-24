import os, shutil, subprocess, sys, tempfile

WT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
OUT = tempfile.mkdtemp(prefix="gx-pivot-pen-mutants-")  # the logs of each run; not kept
A = os.path.join(WT, "Editor", "src", "anchor-point.ts")
V = os.path.join(WT, "Editor", "src", "pivot-panel.ts")
N = os.path.join(WT, "Editor", "src", "pen-tool.ts")
T = os.path.join(WT, "Editor", "src", "transform-tools.ts")
O = os.path.join(WT, "Editor", "src", "overlay.ts")
P = os.path.join(WT, "Editor", "web", "main.ts")
TESTS = "npx vitest run Editor/tests/anchor-point.test.ts Editor/tests/pivot-panel.test.ts Editor/tests/pen-tool.test.ts Editor/tests/transform-tools.test.ts Editor/tests/tool-ribbon.test.ts Editor/tests/overlay.test.ts Editor/tests/command-registry.test.ts"

MUTANTS = [
    # the arithmetic
    ("local-sin-sign", A, "x: (dx * cos + dy * sin) / placement.scaleX", "x: (dx * cos - dy * sin) / placement.scaleX"),
    ("local-no-scale", A, "x: (dx * cos + dy * sin) / placement.scaleX, y: (-dx * sin + dy * cos) / placement.scaleY", "x: (dx * cos + dy * sin), y: (-dx * sin + dy * cos)"),
    ("local-zero-scale-allowed", A, "  if (placement.scaleX === 0 || placement.scaleY === 0) return undefined;\n", ""),
    ("scene-sin-sign", A, "return { x: sx * cos - sy * sin, y: sx * sin + sy * cos };", "return { x: sx * cos + sy * sin, y: sx * sin + sy * cos };"),
    ("scene-no-scale", A, "  const sx = lx * placement.scaleX;\n  const sy = ly * placement.scaleY;", "  const sx = lx;\n  const sy = ly;"),
    ("edits-ignore-keep-in-place", A, "    if (keepInPlace) {\n      const moved", "    if (false) {\n      const moved"),
    ("edits-anchor-and-not-or", A, "if (Math.abs(ax - from.anchorX) > NOISE || Math.abs(ay - from.anchorY) > NOISE) {\n    edits.push", "if (Math.abs(ax - from.anchorX) > NOISE && Math.abs(ay - from.anchorY) > NOISE) {\n    edits.push"),
    ("edits-lose-y", A, "      if (Math.abs(y - from.y) > NOISE) edits.push({ edit: \"setObjectField\", objectIds: [id], field: { name: \"y\", value: y } } as SceneEdit);\n", ""),
    ("edits-x-uses-y", A, "const x = tidy(from.x + moved.x);", "const x = tidy(from.x + moved.y);"),
    ("grid-top-right-x", A, '{ id: "top-right", label: "Top right", fx: 1, fy: 0 }', '{ id: "top-right", label: "Top right", fx: 0, fy: 0 }'),
    ("grid-bottom-y", A, '{ id: "bottom", label: "Bottom", fx: 0.5, fy: 1 }', '{ id: "bottom", label: "Bottom", fx: 0.5, fy: 0.5 }'),
    ("grid-left-fy", A, '{ id: "left", label: "Left", fx: 0, fy: 0.5 }', '{ id: "left", label: "Left", fx: 0, fy: 0 }'),
    # the plan
    ("plan-locked-allowed", A, "  if (locked.length > 0) {", "  if (false) {"),
    ("plan-locked-group-allowed", A, "      if (group?.locked === true) return {", "      if (false) return {"),
    ("plan-group-allowed", A, "  const nothing = objects.filter((object) => NO_BOX.has(object.type) || object.type === \"mesh\");\n  if (nothing.length > 0) {", "  const nothing = objects.filter((object) => false);\n  if (nothing.length > 0) {"),
    ("plan-mesh-allowed", A, "NO_BOX.has(object.type) || object.type === \"mesh\");\n  if (nothing.length > 0) {\n    return {\n      refused: NO_BOX", "NO_BOX.has(object.type));\n  if (nothing.length > 0) {\n    return {\n      refused: NO_BOX"),
    ("plan-flat-allowed", A, "  if (keepInPlace) {\n    const flat", "  if (false) {\n    const flat"),
    ("plan-selection-in-group-allowed", A, "    if (grouped.length > 0) {", "    if (false) {"),
    ("plan-unknown-place-allowed", A, "    if (place === undefined) return { refused: `${request.place} is not a place on the box.` };\n    // The point is on the canvas", "    if (place === undefined) return { refused: \"\" };\n    // The point is on the canvas"),
    ("plan-no-box-allowed", A, "          if (box === undefined) return {", "          if (false) return {"),
    ("plan-reset-not-origin", A, '          target = { x: 0, y: 0 };', '          target = { x: 1, y: 1 };'),
    ("plan-nudge-sign", A, "target = { x: from.anchorX + request.dx, y: from.anchorY + request.dy };", "target = { x: from.anchorX - request.dx, y: from.anchorY + request.dy };"),
    ("plan-point-ignores-x", A, "target = { x: request.x ?? from.anchorX, y: request.y ?? from.anchorY };", "target = { x: from.anchorX, y: request.y ?? from.anchorY };"),
    ("plan-offset-dropped", A, "            x: box.left + place.fx * box.width + (request.offset?.x ?? 0),", "            x: box.left + place.fx * box.width,"),
    ("plan-already-there-silent", A, "  if (edits.length === 0) return { refused: \"The pivot is already there; nothing was changed.\" };\n", ""),
    ("plan-not-finite-allowed", A, "      if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return { refused: \"The pivot must be a number.\" };\n", ""),
    ("plan-selection-bounds-left-only", A, "    const right = Math.max(...boxes.map((box) => box.x + box.width));", "    const right = Math.max(...boxes.map((box) => box.x));"),
    ("plan-selection-ignores-offset", A, "      x: left + place.fx * (right - left) + (request.offset?.x ?? 0),", "      x: left + place.fx * (right - left),"),
    # keys
    ("keyed-always-plain", A, "if (keyedFields.length === 0 && !turnKeyed) return pivotEdits(object.id, from, target, keepInPlace);", "if (true) return pivotEdits(object.id, from, target, keepInPlace);"),
    ("keyed-ignores-keep-in-place", A, "  const keyedFields = keepInPlace ? ([\"x\", \"y\"] as const)", "  const keyedFields = true ? ([\"x\", \"y\"] as const)"),
    ("keyed-default-modify", A, "  const mode = options.keyed ?? \"insert\";", "  const mode = options.keyed ?? \"modify\";"),
    ("keyed-frame-unchecked", A, "  if (!Number.isSafeInteger(frame) || frame < 0) return { refused: \"The playhead is not on a whole frame.\" };\n", ""),
    ("keyed-modify-turned-allowed", A, "    if (turned !== undefined) {", "    if (false) {"),
    ("keyed-modify-sign", A, "keyframe: { ...(key as object), value: tidy(key.value + by) } }", "keyframe: { ...(key as object), value: tidy(key.value - by) } }"),
    ("keyed-modify-unkeyed-skipped", A, "        if (Math.abs(by) > NOISE) edits.push({ edit: \"setObjectField\", objectIds: [object.id], field: { name: field, value: tidy(base + by) } } as SceneEdit);\n", ""),
    ("keyed-insert-uses-stored", A, "  const shown = (options.view ?? document).objects.find((candidate) => candidate.id === object.id) ?? object;", "  const shown = object;"),
    ("keyed-insert-no-autokey", A, "frame: frame as unknown as bigint, autoKey: true }", "frame: frame as unknown as bigint, autoKey: false }"),
    ("keyed-insert-wrong-frame", A, "frame: frame as unknown as bigint, autoKey: true }", "frame: 0 as unknown as bigint, autoKey: true }"),
    ("keyed-anchor-unchanged-edits", A, "  if (Math.abs(ax - from.anchorX) <= NOISE && Math.abs(ay - from.anchorY) <= NOISE) return [];\n", ""),
    # the panel's view
    ("view-place-tolerance", V, "const ON_PLACE = 0.01;", "const ON_PLACE = 5;"),
    ("view-same-x-always", V, "const sameX = points.every((p) => p.x === points[0]!.x);", "const sameX = true;"),
    ("view-same-y-always", V, "const sameY = points.every((p) => p.y === points[0]!.y);", "const sameY = true;"),
    ("view-roots-dropped", V, "  const objects = selectionRoots(document, selectedIds).flatMap((id) => {", "  const objects = selectedIds.flatMap((id) => {"),
    ("view-place-lost", V, "    ...(place === undefined ? {} : { place: place.id }),", ""),
    # the pen
    ("pen-constrain-step", N, "  const step = Math.PI / 4;", "  const step = Math.PI / 2;"),
    ("pen-near-first-two", N, "  if (state.closed || state.points.length < 3) return false;", "  if (state.closed || state.points.length < 2) return false;"),
    ("pen-near-first-strict", N, "return Math.hypot(at.x - first.x, at.y - first.y) <= tolerance;", "return Math.hypot(at.x - first.x, at.y - first.y) < tolerance - 1;"),
    ("pen-add-to-closed", N, "  if (state.closed || state.points.length >= MAX_POINTS) return state;", "  if (state.points.length >= MAX_POINTS) return state;"),
    ("pen-add-no-limit", N, "state.closed || state.points.length >= MAX_POINTS) return state;", "state.closed) return state;"),
    ("pen-shift-ignored", N, "const place = shift && last !== undefined ? constrain(last, at) : at;", "const place = at;"),
    ("pen-pull-not-opposite", N, "outX: tidy(dx), outY: tidy(dy), inX: tidy(-dx), inY: tidy(-dy)", "outX: tidy(dx), outY: tidy(dy), inX: tidy(dx), inY: tidy(dy)"),
    ("pen-pull-small-kept", N, "    Math.hypot(dx, dy) < MIN_PULL\n      ? corner(point)", "    false\n      ? corner(point)"),
    ("pen-pull-closed", N, "  if (point === undefined || state.closed) return state;", "  if (point === undefined) return state;"),
    ("pen-close-two", N, "  return state.points.length >= 3 ? { ...state, closed: true } : state;", "  return state.points.length >= 2 ? { ...state, closed: true } : state;"),
    ("pen-remove-closed-drops-point", N, "  if (state.closed) return { ...state, closed: false };", "  if (state.closed) return { points: state.points.slice(0, -1), closed: false };"),
    ("pen-finish-one-point", N, "return state.points.length >= 2 ? undefined : \"A path needs", "return state.points.length >= 1 ? undefined : \"A path needs"),
    ("pen-closed-two-points", N, "return state.points.length >= 3 ? undefined : \"A closed shape needs at least three points.\";", "return undefined;"),
    ("pen-bezier-tangents-swapped", N, "    inTangents: state.points.map((p) => ({ x: p.inX, y: p.inY })),\n    outTangents: state.points.map((p) => ({ x: p.outX, y: p.outY })),", "    inTangents: state.points.map((p) => ({ x: p.outX, y: p.outY })),\n    outTangents: state.points.map((p) => ({ x: p.inX, y: p.inY })),"),
    ("pen-bezier-closed-flag", N, "    closed: state.closed,\n    vertices", "    closed: false,\n    vertices"),
    ("pen-id-always-one", N, "    const candidate = `shape-${n}`;\n    if (!taken.has(candidate)) return candidate;", "    const candidate = `shape-${n}`;\n    return candidate;"),
    ("pen-open-no-stroke", N, "  if (!state.closed) {\n    edits.push(", "  if (false) {\n    edits.push("),
    ("pen-closed-gets-stroke", N, "  if (!state.closed) {\n    edits.push(", "  if (true) {\n    edits.push("),
    ("pen-open-keeps-fill", N, "      { edit: \"setPaint\", objectIds: [id], slot: \"fill\" } as SceneEdit,\n", ""),
    ("pen-stroke-width", N, "width: 6, style:", "width: 0, style:"),
    ("pen-stroke-dash-sent", N, "miterLimit: 4 } } as unknown as SceneEdit,", "miterLimit: 4, dash: [], dashOffset: 0 } } as unknown as SceneEdit,"),
    ("pen-label-kind", N, "return `Drew a ${state.closed ? \"closed shape\" : \"line\"} of ${state.points.length} points`;", "return `Drew a ${state.closed ? \"line\" : \"closed shape\"} of ${state.points.length} points`;"),
    ("pen-sketch-first-flag", N, "vertices: points.map((p, i) => ({ x: p.x, y: p.y, first: i === 0 })),", "vertices: points.map((p, i) => ({ x: p.x, y: p.y, first: false })),"),
    ("pen-sketch-closing-lost", N, "    closing,\n  };", "    closing: false,\n  };"),
    ("pen-sketch-rubber-when-closed", N, "cursor === undefined || last === undefined || state.closed", "cursor === undefined || last === undefined"),
    ("pen-sketch-handles-out-lost", N, "      ...(p.outX !== 0 || p.outY !== 0 ? [{ x1: p.x, y1: p.y, x2: p.x + p.outX, y2: p.y + p.outY }] : []),\n", ""),
    ("pen-sketch-no-z", N, "if (state.closed && points.length > 1) d += ` ${segment(points[points.length - 1]!, points[0]!)} Z`;", "if (state.closed && points.length > 1) d += \"\";"),
    # the Pivot tool
    ("tool-pivot-anchor-sign", T, "const ax = tidy(item.anchorX + local.x);", "const ax = tidy(item.anchorX - local.x);"),
    ("tool-pivot-no-anchor", T, "          out.push({ id: item.id, field: \"anchorX\", value: ax }, { id: item.id, field: \"anchorY\", value: ay });\n", ""),
    ("tool-pivot-no-position", T, "      push(item, \"x\", item.x + dx);\n      push(item, \"y\", item.y + dy);\n      if (drag.tool === \"pivot\") {", "      if (drag.tool !== \"pivot\") {\n        push(item, \"x\", item.x + dx);\n        push(item, \"y\", item.y + dy);\n      }\n      if (drag.tool === \"pivot\") {"),
    ("tool-pivot-edits-split", T, "  const pivots = [...anchors].map(", "  const pivots = [].concat(...[]).map("),
    ("tool-pivot-preview-no-anchor", T, "...(ax === undefined && ay === undefined ? {} : { anchor:", "...(true ? {} : { anchor:"),
    ("tool-pivot-mesh-allowed", T, "    const nothing = objects.filter((object) => NO_BOX.has(object.type) || object.type === \"mesh\");\n    if (nothing.length > 0) {\n      return {\n        refused: NO_BOX.has(nothing[0]!.type)\n          ? `${named(nothing)} draws nothing of its own, so it has no pivot to move.", "    const nothing = objects.filter((object) => NO_BOX.has(object.type));\n    if (nothing.length > 0) {\n      return {\n        refused: NO_BOX.has(nothing[0]!.type)\n          ? `${named(nothing)} draws nothing of its own, so it has no pivot to move."),
    ("tool-pivot-keys-message", T, "Use the Pivot panel, which can add a key at the playhead or move the keys.", "Change it with its keys."),
    # the overlay marker
    ("overlay-pivot-always", O, "if (state.pivots === true && !NO_BOX_KINDS.has(object.type)) {", "if (!NO_BOX_KINDS.has(object.type)) {"),
    ("overlay-pivot-on-group", O, "if (state.pivots === true && !NO_BOX_KINDS.has(object.type)) {", "if (state.pivots === true) {"),
    ("overlay-pivot-at-origin", O, "primitives.push({ kind: \"pivot\", objectId, point: { x: object.x, y: object.y } });", "primitives.push({ kind: \"pivot\", objectId, point: { x: 0, y: 0 } });"),
    ("overlay-pen-lost", O, "  if (state.pen !== undefined && state.pen.vertices.length > 0) primitives.push({ kind: \"pen\", sketch: state.pen });\n", ""),
    ("overlay-shape-box", O, "    case \"shape\": {\n      const paths", "    case \"nothing\": {\n      const paths"),
    # the page
    ("page-pivot-keyed-ignored", P, "const keyed = ui.pivotKeyedModify.checked ? \"modify\" : \"insert\";", "const keyed = \"insert\";"),
    ("page-pivot-frame-zero", P, "frame: currentFrame, view: previewScene ?? scene", "frame: 0, view: previewScene ?? scene"),
    ("page-pivot-stored-view", P, "view: previewScene ?? scene });\n  if (isRefused(plan))", "view: scene });\n  if (isRefused(plan))"),
    ("page-pivot-nudge-step", P, "void applyPivot({ kind: \"nudge\", dx: dx * step, dy: dy * step });", "void applyPivot({ kind: \"nudge\", dx, dy });"),
    ("page-pivot-scope-ignored", P, "kind: ui.pivotScope.value === \"selection\" ? \"selection\" : \"grid\", place, offset: offset()", "kind: \"grid\", place, offset: offset()"),
    ("page-pivot-error-hidden", P, "    ui.pivotError.hidden = false;\n    log(`Pivot:", "    log(`Pivot:"),
    ("page-pen-close-lost", P, "  if (nearFirst(pen, at, penTolerance())) {\n    pen = closePath(pen);\n    finishPen();\n    return;\n  }", ""),
    ("page-pen-pull-lost", P, "    pen = pullHandles(pen, at);", "    penHover = at;"),
    ("page-pen-enter-lost", P, "  if (event.key === \"Enter\") finishPen();\n  else if", "  if (false) finishPen();\n  else if"),
    ("page-pen-escape-keeps", P, "  else if (event.key === \"Escape\") cancelPen();", "  else if (event.key === \"Escape\") penHover = undefined;"),
    ("page-pen-double-click-keeps-dup", P, "Math.hypot(last.x - before.x, last.y - before.y) < 1) pen = removeLast(pen);", "Math.hypot(last.x - before.x, last.y - before.y) < -1) pen = removeLast(pen);"),
    ("page-pen-not-selected", P, "      for (const effect of effects) if (effect.effect === \"objectCreated\") return [effect.objectId];\n      return undefined;", "      return undefined;"),
    ("page-pen-leave-always-finish", P, "function leavePen(): void {\n  if (pen.points.length >= 2) finishPen();", "function leavePen(): void {\n  finishPen();"),
    ("page-pen-leave-never", P, "  if (activeTool === \"pen\" && tool !== \"pen\") leavePen();\n", ""),
    ("keyed-turn-ignored", A, "const turnKeyed = keepInPlace && (", "const turnKeyed = false && ("),
    ("selection-uses-stored", A, "new Map((options.view ?? document).objects.map((candidate) => [candidate.id, candidate]))", "new Map(document.objects.map((candidate) => [candidate.id, candidate]))"),
    ("selection-from-stored-place", A, "const from = placementOf(drawn.get(object.id) ?? object);\n      const local = toLocalDelta", "const from = placementOf(object);\n      const local = toLocalDelta"),
    ("overlay-no-pick-padding", O, "const padX = Math.max(0, (MIN_PICK - bounds.width) / 2);", "const padX = 0;"),
    ("overlay-no-pick-padding-y", O, "const padY = Math.max(0, (MIN_PICK - bounds.height) / 2);", "const padY = 0;"),
    ("page-pen-double-click-guard", P, "  if (event.timeStamp - penFinishedAt < 500) return;\n", ""),
    ("page-pen-dblclick-guard", P, "if (activeTool === \"pen\" && event.timeStamp - penFinishedAt >= 500) finishPen();", "if (activeTool === \"pen\") finishPen();"),
    ("page-pen-scene-guard", P, "  if (pen.points.length > 0 && penScene !== activeSession(workspace)?.key) cancelPen();\n", ""),
    ("page-pen-scene-finish-guard", P, "  if (penScene !== activeSession(workspace)?.key) {\n    log(", "  if (false) {\n    log("),
    ("page-pen-sketch-other-scene", P, " && penScene === activeSession(workspace)?.key ? { pen:", " ? { pen:"),
    ("page-pen-key-gate", P, "  if (pen.points.length === 0) return false;\n", ""),
    ("page-pen-path-not-given-back", P, "      pen = kept;\n", "      pen = EMPTY_PEN;\n"),
    ("page-pivot-no-queue", P, "  pivotQueue = pivotQueue.then(() => sendPivot(request));\n  return pivotQueue;", "  return sendPivot(request);"),
    ("page-pen-tolerance", P, "return box.width > 0 ? (10 * canvasWidth) / box.width : 10;", "return 10;"),
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
        log = os.path.join(OUT, "mutpp_%s.log" % name)
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
