import os, shutil, subprocess, sys, tempfile

WT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
OUT = tempfile.mkdtemp(prefix="gx-path-mutants-")  # the logs of each run; not kept
G = os.path.join(WT, "Editor", "src", "path-geometry.ts")
E = os.path.join(WT, "Editor", "src", "path-edit.ts")
PT = os.path.join(WT, "Editor", "src", "pen-tool.ts")
OV = os.path.join(WT, "Editor", "src", "overlay.ts")
P = os.path.join(WT, "Editor", "web", "main.ts")
RG = os.path.join(WT, "Shared", "contracts", "src", "path_geometry.rs")
RE = os.path.join(WT, "Shared", "contracts", "src", "render_edit.rs")
TS_TESTS = "npx vitest run Editor/tests/path-geometry.test.ts Editor/tests/path-edit.test.ts Editor/tests/pen-tool.test.ts Editor/tests/path-tools.test.ts Editor/tests/tool-ribbon.test.ts Editor/tests/overlay.test.ts"
RS_TESTS = "cargo test -p gx-contracts --lib -- path_geometry edit_path"

MUTANTS = [
    # ---- the Editor's geometry
    ("ts-split-wrong-left", G, "return { left: { p0: c.p0, p1: a, p2: d, p3: m }, right: { p0: m, p1: e, p2: cc, p3: c.p3 } };", "return { left: { p0: c.p0, p1: a, p2: b, p3: m }, right: { p0: m, p1: e, p2: cc, p3: c.p3 } };"),
    ("ts-point-weights", G, "const w1 = 3 * u * u * t;", "const w1 = 2 * u * u * t;"),
    ("ts-derivative-scale", G, "const a = scale(sub(c.p1, c.p0), 3 * u * u);", "const a = scale(sub(c.p1, c.p0), 2 * u * u);"),
    ("ts-second-derivative", G, "const a = scale(add(sub(c.p2, scale(c.p1, 2)), c.p0), 6 * u);", "const a = scale(add(sub(c.p2, scale(c.p1, 3)), c.p0), 6 * u);"),
    ("ts-curvature-sign", G, "return (d1.x * d2.y - d1.y * d2.x) / (speed * speed * speed);", "return (d1.y * d2.x - d1.x * d2.y) / (speed * speed * speed);"),
    ("ts-curvature-zero-speed", G, "  if (speed < 1e-12) return 0;\n  return (d1.x", "  return (d1.x"),
    ("ts-bounds-ignores-roots", G, "const ts = [0, 1, ...derivativeRoots(c.p0.x, c.p1.x, c.p2.x, c.p3.x), ...derivativeRoots(c.p0.y, c.p1.y, c.p2.y, c.p3.y)];", "const ts = [0, 1];"),
    ("ts-bounds-y-roots-lost", G, ", ...derivativeRoots(c.p0.y, c.p1.y, c.p2.y, c.p3.y)];", "];"),
    ("ts-root-open-interval", G, "if (t > 0 && t < 1) roots.push(t);", "if (t >= 0 && t <= 2) roots.push(t);"),
    ("ts-linear-root", G, "if (Math.abs(b) > 1e-14) keep(-k / b);", "if (Math.abs(b) > 1e-14) keep(k / b);"),
    ("ts-arclength-no-recursion", G, "if (depth >= 24 || Math.abs(left + right - whole) <= tolerance) return left + right;", "return left + right;"),
    ("ts-arclength-reversed-range", G, "  if (t1 <= t0) return 0;\n  return walk", "  return walk"),
    ("ts-tatlength-clamp-end", G, "  if (distance >= whole) return 1;\n", ""),
    ("ts-tatlength-clamp-start", G, "  if (distance <= 0) return 0;\n  if (distance >= whole) return 1;", "  if (distance >= whole) return 1;"),
    ("ts-nearest-ends-lost", G, "for (const t of [0, 1, ...stationaryParameters(c, q)]) {", "for (const t of stationaryParameters(c, q)) {"),
    ("ts-nearest-keeps-worst", G, "if (best === undefined || distance < best.distance) best = { t, point, distance };", "if (best === undefined || distance > best.distance) best = { t, point, distance };"),
    ("ts-sign-changes-count", G, "if (last !== 0 && s !== last) count++;", "if (last !== 0 && s !== last) count += 2;"),
    ("ts-walk-ends-lost", G, "    roots.push(lo, hi);\n", ""),
    ("ts-halve-right", G, "right.unshift(row[row.length - 1]!);", "right.unshift(row[0]!);"),
    ("ts-refine-sign", G, "if (Math.sign(fm) === start) a = mid;\n      else b = mid;", "if (Math.sign(fm) === start) b = mid;\n      else a = mid;"),
    ("ts-insert-margin", G, "t <= SPLIT_MARGIN || t >= 1 - SPLIT_MARGIN", "t < 0 || t > 1"),
    ("ts-insert-out-handle", G, "outTangents[a] = sub(left.p1, left.p0);", "outTangents[a] = sub(right.p1, right.p0);"),
    ("ts-insert-in-handle", G, "inTangents[b] = sub(right.p2, right.p3);", "inTangents[b] = sub(left.p2, left.p3);"),
    ("ts-insert-new-in", G, "inTangents.splice(at, 0, sub(left.p2, middle));", "inTangents.splice(at, 0, sub(middle, left.p2));"),
    ("ts-insert-new-out", G, "outTangents.splice(at, 0, sub(right.p1, middle));", "outTangents.splice(at, 0, sub(middle, right.p1));"),
    ("ts-insert-closing-index", G, "const at = a + 1;", "const at = b;"),
    ("ts-delete-closed-least", G, "if (path.closed && left < 3)", "if (path.closed && left < 2)"),
    ("ts-delete-open-least", G, "if (left < 2) return refuse(\"a path keeps two vertices\");", "if (left < 1) return refuse(\"a path keeps two vertices\");"),
    ("ts-delete-range", G, "indices.some((i) => !(i >= 0 && i < n))", "indices.some((i) => !(i >= 0))"),
    ("ts-delete-empty", G, "if (indices.length === 0 || ", "if ("),
    ("ts-smooth-needs-opposite", G, "return Math.abs(cross) < 1e-6 && dot(a, b) < 0;", "return Math.abs(cross) < 1e-6;"),
    ("ts-smooth-no-handles", G, "  if (la <= NO_HANDLE || lb <= NO_HANDLE) return false;\n  const cross", "  const cross"),
    ("ts-convert-third", G, "length(sub(next, here)) / 3", "length(sub(next, here)) / 2"),
    ("ts-convert-in-sign", G, "scale(dir, -length(sub(here, prev)) / 3)", "scale(dir, length(sub(here, prev)) / 3)"),
    ("ts-convert-keeps-handles", G, "if (hasHandles(path, index)) {\n    return { ...clonePath(path), inTangents: replaceAt(path.inTangents, index, ORIGIN), outTangents: replaceAt(path.outTangents, index, ORIGIN) };", "if (hasHandles(path, index)) {\n    return { ...clonePath(path), inTangents: replaceAt(path.inTangents, index, ORIGIN), outTangents: path.outTangents };"),
    ("ts-handle-mirror-sign", G, "if (coupling === \"mirror\") farVector = scale(vector, -1);", "if (coupling === \"mirror\") farVector = vector;"),
    ("ts-handle-smooth-length", G, "farVector = scale(vector, -length(far[index]!) / l);", "farVector = scale(vector, -1);"),
    ("ts-handle-zero-guard", G, "else if (coupling === \"smooth\" && l > NO_HANDLE)", "else if (coupling === \"smooth\")"),
    ("ts-handle-side-swap", G, "inTangents: side === \"in\" ? nextNear : nextFar,", "inTangents: side === \"in\" ? nextFar : nextNear,"),
    ("ts-move-all", G, "vertices: path.vertices.map((p, i) => (set.has(i) ? add(p, delta) : { ...p })),", "vertices: path.vertices.map((p) => add(p, delta)),"),
    ("ts-reshape-weight", G, "const a = 3 * u * u * t;\n  const b = 3 * u * t * t;", "const a = 3 * u * t;\n  const b = 3 * u * t * t;"),
    ("ts-reshape-guard", G, "if (weight < 1e-12) return refuse(", "if (weight < -1) return refuse("),
    ("ts-reshape-smooth", G, "isSmooth(path, from) ? \"smooth\" : \"none\"", "\"none\""),
    ("ts-reshape-share-b", G, "scale(delta, b / weight)", "scale(delta, a / weight)"),
    ("ts-reverse-handles", G, "inTangents: ordered.map((i) => ({ ...path.outTangents[i]! })),", "inTangents: ordered.map((i) => ({ ...path.inTangents[i]! })),"),
    ("ts-reverse-closed-first", G, "const ordered = path.closed ? [0, ...order.filter((i) => i !== 0)] : order;", "const ordered = order;"),
    ("ts-first-vertex-open", G, "if (!path.closed) return refuse(\"only a closed path has a first vertex to change\");", ""),
    ("ts-first-vertex-turn", G, "[...list.slice(index), ...list.slice(0, index)]", "[...list.slice(0, index), ...list.slice(index)]"),
    ("ts-close-needs-three", G, "if (closed && path.vertices.length < 3)", "if (closed && path.vertices.length < 2)"),
    ("ts-snap-zero-step", G, "if (l === 0 || !(degrees > 0)) return to;", "if (l === 0) return to;"),
    ("ts-straight-chord", G, "return off(c.p1) <= tolerance && off(c.p2) <= tolerance;", "return off(c.p1) <= tolerance;"),
    ("ts-valid-lengths", G, "if (path.inTangents.length !== n || path.outTangents.length !== n) return false;", ""),
    # ---- the Editor's path editing
    ("edit-handle-radius", E, "if (Math.hypot(end.x - at.x, end.y - at.y) <= radius) return { kind: \"handle\"", "if (Math.hypot(end.x - at.x, end.y - at.y) <= radius * 4) return { kind: \"handle\""),
    ("edit-handle-unselected", E, "      if (!isSelected(selected, subpath, index)) continue;\n      const vertex", "      const vertex"),
    ("edit-vertex-before-handle", E, "if (Math.abs(offset.x) + Math.abs(offset.y) < 1e-6) continue;\n        const end = canvasOf", "if (true) continue;\n        const end = canvasOf"),
    ("edit-segment-first", E, "if (best !== undefined) return best.hit;\n  for (const { subpath, path } of target.paths) {\n    for (let segment", "for (const { subpath, path } of target.paths) {\n    for (let segment"),
    ("edit-nearest-vertex", E, "if (distance <= radius && (best === undefined || distance < best.distance)) best = { hit: { kind: \"vertex\"", "if (distance <= radius && best === undefined) best = { hit: { kind: \"vertex\""),
    ("edit-canvas-space", E, "const moved = toSceneDelta(placement, q.x - placement.anchorX, q.y - placement.anchorY);", "const moved = toSceneDelta(placement, q.x, q.y);"),
    ("edit-object-space", E, "return delta === undefined ? undefined : { x: placement.anchorX + delta.x, y: placement.anchorY + delta.y };", "return delta === undefined ? undefined : { x: delta.x, y: delta.y };"),
    ("edit-locked-allowed", E, "  if (object.locked) return { refused: `${object.name} is locked.", "  if (false) return { refused: `${object.name} is locked."),
    ("edit-group-allowed", E, "  if (parents.has(object.id)) return", "  if (false) return"),
    ("edit-multi-allowed", E, "  if (selectedIds.length > 1) return", "  if (false) return"),
    ("edit-shift-toggle", E, "const next = isSelected(selected, hit.subpath, hit.index) ? selected : shift ? [...selected, here] : [here];", "const next = isSelected(selected, hit.subpath, hit.index) ? selected : [here];"),
    ("edit-shift-snap-move", E, "const moved = modifiers.shift ? snapAngle({ x: 0, y: 0 }, delta, MOVE_ANGLE) : delta;", "const moved = delta;"),
    ("edit-alt-breaks", E, "const coupling = modifiers.alt ? \"none\" : isSmooth(path, hit.index) ? \"smooth\" : \"none\";", "const coupling = isSmooth(path, hit.index) ? \"smooth\" : \"none\";"),
    ("edit-handle-angle", E, "export const HANDLE_ANGLE = 15;", "export const HANDLE_ANGLE = 45;"),
    ("edit-handle-aim", E, "const vector = round({ x: aim.x - vertex.x, y: aim.y - vertex.y });", "const vector = round({ x: aim.x, y: aim.y });"),
    ("edit-moving-scope", E, "moving: next.filter((s) => s.subpath === hit.subpath) }", "moving: [here] }"),
    ("edit-click-slop", E, "export const CLICK_SLOP = 3;", "export const CLICK_SLOP = 30;"),
    ("edit-delete-refusal", E, "if (applyOp(path, { op: \"deleteVertices\", indices: [hit.index] }) === undefined) return { refused: capital(whyNot) };", ""),
    ("edit-convert-label", E, "const smooth = !hasHandles(path, hit.index);", "const smooth = hasHandles(path, hit.index);"),
    ("edit-add-needs-segment", E, "if (hit?.kind !== \"segment\") return { refused: \"Click on the curve where the vertex should go.\" };", ""),
    ("edit-delete-first-subpath", E, "const subpath = selected[0]!.subpath;\n  const indices = selected.filter((s) => s.subpath === subpath)", "const subpath = selected[0]!.subpath;\n  const indices = selected"),
    ("edit-sketch-handles-all", E, "      if (!chosen) return;\n", ""),
    ("edit-sketch-no-close", E, "    if (path.closed) d += \" Z\";\n", ""),
    ("edit-apply-op-delete", E, "return deleteVertices(path, op.indices);", "return deleteVertices(path, [op.indices[0]!]);"),
    ("edit-marquee-box", E, "if (p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height)", "if (p.x >= box.x && p.x <= box.x + box.width)"),
    ("edit-edit-target", E, "target: { kind: \"shape\", subpath }", "target: { kind: \"shape\", subpath: 0 }"),
    # ---- the pen's spec modifiers
    ("pen-shift-angle", PT, "export const SHIFT_ANGLE = 15;", "export const SHIFT_ANGLE = 45;"),
    ("pen-alt-keeps-in", PT, "const pulled = options.alt === true ? { ...point, ...out } : { ...point, ...out, inX: tidy(-dx), inY: tidy(-dy) };", "const pulled = { ...point, ...out, inX: tidy(-dx), inY: tidy(-dy) };"),
    ("pen-shift-pull", PT, "const aim = options.shift === true ? constrain(point, to, options.degrees ?? SHIFT_ANGLE) : to;\n  const dx = aim.x - point.x;", "const aim = to;\n  const dx = aim.x - point.x;"),
    ("pen-move-last", PT, "{ ...point, x: tidy(point.x + delta.x), y: tidy(point.y + delta.y) }", "{ ...point, x: tidy(point.x + delta.x), y: point.y }"),
    ("pen-close-pull-in", PT, "const arriving = { inX: tidy(-dx), inY: tidy(-dy) };", "const arriving = { inX: tidy(dx), inY: tidy(dy) };"),
    ("pen-close-alt", PT, "const leaving = options.alt === true ? {} : { outX: tidy(dx), outY: tidy(dy) };", "const leaving = { outX: tidy(dx), outY: tidy(dy) };"),
    ("pen-close-three", PT, "  if (state.points.length < 3) return state;\n  const first", "  const first"),
    ("pen-resume-reverse", PT, "return { points: points.reverse().map((p) => ({ ...p, inX: p.outX, inY: p.outY, outX: p.inX, outY: p.inY })), closed: false };", "return { points: points.reverse(), closed: false };"),
    ("pen-resume-closed", PT, "if (path.closed || path.vertices.length < 2) return undefined;", "if (path.vertices.length < 2) return undefined;"),
    ("pen-resume-edit", PT, "edit: \"setShapePath\", shapeId, path: toBezier(state), compoundPaths: []", "edit: \"setShapePath\", shapeId, path: toBezier(state), compoundPaths: [{}]"),
    # ---- the page
    ("page-path-send-keep", P, "if (!keeps) pathSelected = [];", ""),
    ("page-path-radius", P, "const pathRadius = (): number => PICK_RADIUS * overlayUnit();", "const pathRadius = (): number => PICK_RADIUS;"),
    ("page-path-preview-sent", P, "  void runEdits([editPathEdit(id, subpath, op)], { label: `${label} of ${target.object.name}` }, \"viewport\")", "  void runEdits([editPathEdit(id, subpath, op), editPathEdit(id, subpath, op)], { label: `${label} of ${target.object.name}` }, \"viewport\")"),
    ("page-path-esc-drag", P, "      pathGesture = undefined;\n      pathPreview = undefined;\n      marquee = undefined;\n    } else if (pathSelected.length > 0) pathSelected = [];", "    } else if (pathSelected.length > 0) pathSelected = [];"),
    ("page-path-delete-key", P, "if ((event.key === \"Delete\" || event.key === \"Backspace\") && pathSelected.length > 0) {", "if (false) {"),
    ("page-path-double-add", P, "const planned = clickOp(hit.kind === \"vertex\" ? \"convert\" : \"add\", hit, target);", "const planned = clickOp(\"add\", hit, target);"),
    ("page-pen-space", P, "if (event.key === \" \" && penPull !== undefined) {", "if (false) {"),
    ("page-pen-esc-drag", P, "      } else pen = removeLast(pen);\n    } else if (pen.points.length >= 2) finishPen();", "      } else pen = removeLast(pen);\n    } else if (pen.points.length >= 2) cancelPen();"),
    ("page-pen-resume-placed", P, "const placed = object.x === 0 && object.y === 0 && object.rotation === 0 && object.scaleX === 1 && object.scaleY === 1 && object.anchor === undefined;", "const placed = true;"),
    ("page-pen-close-release", P, "  if (penClosing) {\n    penClosing = false;\n    finishPen();\n    return;\n  }\n  renderOverlayLayer();", "  renderOverlayLayer();"),
    ("page-overlay-sketch", P, "      ...pathSketchFor(active),\n", ""),
    # ---- the overlay
    ("overlay-box-handles-stay", OV, "if (!object.locked && state.pathEdit === undefined) {", "if (!object.locked) {"),
    ("overlay-path-vertex-selected", OV, "class: `overlay-path-vertex${v.selected ? \" is-selected\" : \"\"}`,", "class: \"overlay-path-vertex\","),
]

RUST = [
    ("rs-split-p2", RG, "p1: a,\n            p2: d,\n            p3: m,", "p1: a,\n            p2: b,\n            p3: m,"),
    ("rs-point-weight", RG, "(u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t)", "(u * u * u, 2.0 * u * u * t, 3.0 * u * t * t, t * t * t)"),
    ("rs-bounds-roots", RG, "    derivative_roots(c.p0.x, c.p1.x, c.p2.x, c.p3.x, &mut ts);\n", ""),
    ("rs-arclength-depth", RG, "if depth >= 24 || (left + right - whole).abs() <= tolerance {", "if true {"),
    ("rs-nearest-ends", RG, "for t in [0.0, 1.0].into_iter().chain(stationary_parameters(c, q)) {", "for t in stationary_parameters(c, q) {"),
    ("rs-nearest-worst", RG, "if best.is_none_or(|b| distance < b.distance) {\n            best = Some(Nearest", "if best.is_none_or(|b| distance > b.distance) {\n            best = Some(Nearest"),
    ("rs-sign-count", RG, "if last != 0 && s != last {\n            count += 1;", "if last != 0 && s != last {\n            count += 2;"),
    ("rs-halve", RG, "right[5 - k] = row[row.len() - 1];", "right[5 - k] = row[0];"),
    ("rs-refine-sign", RG, "if fm.signum() == start {\n                a = mid;\n            } else {\n                b = mid;\n            }", "if fm.signum() == start {\n                b = mid;\n            } else {\n                a = mid;\n            }"),
    ("rs-insert-margin", RG, "if !t.is_finite() || t <= SPLIT_MARGIN || t >= 1.0 - SPLIT_MARGIN {", "if !t.is_finite() {"),
    ("rs-insert-out", RG, "next.out_tangents[a] = sub(left.p1, left.p0);", "next.out_tangents[a] = sub(right.p1, right.p0);"),
    ("rs-insert-in", RG, "next.in_tangents[b] = sub(right.p2, right.p3);", "next.in_tangents[b] = sub(left.p2, left.p3);"),
    ("rs-insert-index", RG, "let at = a + 1;", "let at = b;"),
    ("rs-delete-closed", RG, "if path.closed && left < 3 {", "if path.closed && left < 2 {"),
    ("rs-delete-open", RG, "if left < 2 {\n        return Err(\"a path keeps two vertices\");", "if left < 1 {\n        return Err(\"a path keeps two vertices\");"),
    ("rs-delete-empty", RG, "if indices.is_empty() || indices.iter().any(|&i| i >= n) {\n        return Err(\"there is no such vertex\");\n    }\n    let mut drop", "if indices.iter().any(|&i| i >= n) {\n        return Err(\"there is no such vertex\");\n    }\n    let mut drop"),
    ("rs-smooth-opposite", RG, "cross.abs() < 1e-6 && dot(a, b) < 0.0", "cross.abs() < 1e-6"),
    ("rs-convert-third", RG, "length(sub(f, here)) / 3.0", "length(sub(f, here)) / 2.0"),
    ("rs-convert-in", RG, "scale(dir, -length(sub(here, p)) / 3.0)", "scale(dir, length(sub(here, p)) / 3.0)"),
    ("rs-handle-mirror", RG, "Coupling::Mirror => scale(vector, -1.0),", "Coupling::Mirror => vector,"),
    ("rs-handle-smooth", RG, "Coupling::Smooth if l > NO_HANDLE => scale(vector, -length(far_now) / l),", "Coupling::Smooth if l > NO_HANDLE => scale(vector, -1.0),"),
    ("rs-move-dedupe", RG, "if !done[i] {\n            next.vertices[i] = add(path.vertices[i], delta);\n            done[i] = true;\n        }", "next.vertices[i] = add(next.vertices[i], delta);"),
    ("rs-reshape-weight", RG, "let a = 3.0 * u * u * t;\n    let b = 3.0 * u * t * t;\n    let weight", "let a = 3.0 * u * t;\n    let b = 3.0 * u * t * t;\n    let weight"),
    ("rs-reshape-share", RG, "add(first.in_tangents[to], scale(delta, b / weight)),", "add(first.in_tangents[to], scale(delta, a / weight)),"),
    ("rs-reverse-handles", RG, "in_tangents: order.iter().map(|&i| path.out_tangents[i]).collect(),", "in_tangents: order.iter().map(|&i| path.in_tangents[i]).collect(),"),
    ("rs-reverse-first", RG, "    if path.closed && n > 0 {\n        order.retain(|&i| i != 0);\n        order.insert(0, 0);\n    }\n", ""),
    ("rs-first-open", RG, "    if !path.closed {\n        return Err(\"only a closed path has a first vertex to change\");\n    }\n", ""),
    ("rs-close-three", RG, "if closed && path.vertices.len() < 3 {", "if closed && path.vertices.len() < 2 {"),
    ("rs-edit-subpath-field", RE, "format!(\"compoundPaths[{}]\", subpath - 1)", "format!(\"compoundPaths[{}]\", subpath)"),
    ("rs-edit-mask-write", RE, "masks[mask].path = op.apply(&current.path).map_err(|why| invalid(field, why))?;\n            set_object_masks(scene, object_id, &masks)", "set_object_masks(scene, object_id, &masks)"),
    ("rs-edit-main-first", RE, "let main = paths.remove(0);\n            set_shape_path(scene, object_id, &main, &paths, None)", "let main = paths.pop().unwrap();\n            set_shape_path(scene, object_id, &main, &paths, None)"),
]

only = set(sys.argv[1:])
results = []
for name, path, old, new in MUTANTS + RUST:
    if only and name not in only and not any(name.startswith(o) for o in only):
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
        log = os.path.join(OUT, "mut_%s.log" % name)
        command = RS_TESTS if name.startswith("rs-") else TS_TESTS
        with open(log, "wb") as fh:
            rc = subprocess.run(command, cwd=WT, stdout=fh, stderr=subprocess.STDOUT, timeout=900, shell=True).returncode
        body = open(log, "rb").read().decode("utf-8", "replace")
        if rc == 0:
            verdict = "SURVIVED"
        elif "error TS" in body or "SyntaxError" in body or "error[E" in body or "error: could not compile" in body:
            verdict = "BUILD ERROR"
        else:
            failed = [l.strip()[:90] for l in body.splitlines() if "×" in l or " FAIL " in l or "FAILED" in l]
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
