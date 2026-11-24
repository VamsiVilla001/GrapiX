import os, shutil, subprocess, sys, tempfile

WT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
OUT = tempfile.mkdtemp(prefix="gx-view-mutants-")  # the logs of each run; not kept
C = os.path.join(WT, "Editor", "src", "viewport-camera.ts")
O = os.path.join(WT, "Editor", "src", "overlay.ts")
R = os.path.join(WT, "Editor", "src", "command-registry.ts")
M = os.path.join(WT, "Editor", "src", "app-menu.ts")
P = os.path.join(WT, "Editor", "web", "main.ts")
H = os.path.join(WT, "Editor", "web", "index.html")
TESTS = "npx vitest run Editor/tests/viewport-camera.test.ts Editor/tests/viewport-view.test.ts Editor/tests/tool-ribbon.test.ts Editor/tests/command-registry.test.ts Editor/tests/app-menu.test.ts Editor/tests/overlay.test.ts"

MUTANTS = [
    # the camera
    ("zoom-min-lost", C, "return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));", "return Math.min(MAX_ZOOM, zoom);"),
    ("zoom-max-lost", C, "return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));", "return Math.max(MIN_ZOOM, zoom);"),
    ("zoom-nan-not-fit", C, "  if (!Number.isFinite(zoom)) return 1;\n", ""),
    ("pan-limit-no-margin", C, "(paneSize + pictureSize * zoom) / 2 - KEEP_IN_VIEW", "(paneSize + pictureSize * zoom) / 2"),
    ("pan-limit-ignores-zoom", C, "(paneSize + pictureSize * zoom) / 2 - KEEP_IN_VIEW", "(paneSize + pictureSize) / 2 - KEEP_IN_VIEW"),
    ("pan-limit-negative-allowed", C, "Math.max(0, (paneSize + pictureSize * zoom) / 2 - KEEP_IN_VIEW)", "((paneSize + pictureSize * zoom) / 2 - KEEP_IN_VIEW)"),
    ("pan-x-unclamped", C, "    panX: Math.min(x, Math.max(-x, Number.isFinite(camera.panX) ? camera.panX : 0)),", "    panX: camera.panX,"),
    ("pan-nan-allowed", C, "Number.isFinite(camera.panX) ? camera.panX : 0", "camera.panX"),
    ("zoom-at-wrong-fixed-point", C, "{ zoom, panX: at.x - ratio * (at.x - camera.panX), panY: at.y - ratio * (at.y - camera.panY) }", "{ zoom, panX: camera.panX * ratio, panY: camera.panY * ratio }"),
    ("zoom-at-y-uses-x", C, "panY: at.y - ratio * (at.y - camera.panY)", "panY: at.x - ratio * (at.x - camera.panY)"),
    ("zoom-at-no-change-check", C, "  if (zoom === camera.zoom) return camera;\n", ""),
    ("zoom-at-ratio-inverted", C, "  const ratio = zoom / camera.zoom;", "  const ratio = camera.zoom / zoom;"),
    ("pan-by-sign", C, "{ ...camera, panX: camera.panX + dx, panY: camera.panY + dy }", "{ ...camera, panX: camera.panX - dx, panY: camera.panY + dy }"),
    ("pan-by-unclamped", C, "return clampPan({ ...camera, panX: camera.panX + dx, panY: camera.panY + dy }, pane, picture);", "return { ...camera, panX: camera.panX + dx, panY: camera.panY + dy };"),
    ("wheel-direction", C, "return Math.exp(-Math.max(-600, Math.min(600, deltaY)) * 0.0015);", "return Math.exp(Math.max(-600, Math.min(600, deltaY)) * 0.0015);"),
    ("wheel-unlimited", C, "Math.max(-600, Math.min(600, deltaY))", "deltaY"),
    ("wheel-zero-not-one", C, "  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;\n", ""),
    ("percent-about-picture", C, "percent / 100 / (fitScale * camera.zoom), { x: 0, y: 0 }", "percent / 100 / (fitScale * camera.zoom), { x: camera.panX, y: camera.panY }"),
    ("percent-wrong-base", C, "percent / 100 / (fitScale * camera.zoom)", "percent / 100 / fitScale"),
    ("percent-no-fit-guard", C, "  if (!(fitScale > 0)) return camera;\n  return zoomAt", "  return zoomAt"),
    ("label-no-rounding", C, "return `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;", "return `${percent}%`;"),
    ("label-decimal-always", C, "percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10", "Math.round(percent * 10) / 10"),
    ("label-no-fit-guard", C, "  if (!(fitScale > 0)) return \"\";\n", ""),
    ("transform-always", C, "  return camera.zoom === 1 && camera.panX === 0 && camera.panY === 0\n    ? \"\"", "  return false\n    ? \"\""),
    ("transform-order", C, "`translate(${round(camera.panX)}px, ${round(camera.panY)}px) scale(${round(camera.zoom)})`", "`scale(${round(camera.zoom)}) translate(${round(camera.panX)}px, ${round(camera.panY)}px)`"),
    ("fit-ignores-pan", C, "  return camera.zoom === 1 && camera.panX === 0 && camera.panY === 0;\n}", "  return camera.zoom === 1;\n}"),
    ("zoom-step", C, "export const ZOOM_STEP = 1.25;", "export const ZOOM_STEP = 2;"),
    # the overlay unit
    ("overlay-unit-ignored", O, "x: String(primitive.point.x - 5 * model.unit),", "x: String(primitive.point.x - 5),"),
    ("overlay-unit-width", O, "width: String(10 * model.unit),", "width: \"10\","),
    ("overlay-unit-invalid", O, "const unit = state.unit !== undefined && Number.isFinite(state.unit) && state.unit > 0 ? state.unit : 1;", "const unit = state.unit ?? 1;"),
    ("overlay-unit-pen-vertex", O, "const size = (v.first ? 14 : 10) * model.unit;", "const size = v.first ? 14 : 10;"),
    ("overlay-unit-pivot", O, "r: String(9 * model.unit) }", "r: \"9\" }"),
    # the commands
    ("hand-key-lost", R, '  { chord: plain("h"), command: "edit.hand", label: "H", quiet: true },\n', ""),
    ("zoom-key-is-hand", R, '{ chord: plain("z"), command: "edit.zoom", label: "Z", quiet: true }', '{ chord: plain("z"), command: "edit.hand", label: "Z", quiet: true }'),
    ("fit-key-lost", R, '  { chord: ctrl("0"), command: "layout.fit", label: "Ctrl 0" },\n', ""),
    ("fit-key-repeats", R, '{ chord: ctrl("0"), command: "layout.fit", label: "Ctrl 0" }', '{ chord: ctrl("0"), command: "layout.fit", label: "Ctrl 0", repeats: true }'),
    ("zoom-in-no-repeat", R, '{ chord: ctrl("="), command: "layout.zoom-in", label: "Ctrl =", repeats: true }', '{ chord: ctrl("="), command: "layout.zoom-in", label: "Ctrl =" }'),
    ("zoom-in-plus-alias-lost", R, '  { chord: ctrl("+", true), command: "layout.zoom-in", repeats: true },\n', ""),
    ("zoom-out-no-repeat", R, '{ chord: ctrl("-"), command: "layout.zoom-out", label: "Ctrl -", repeats: true }', '{ chord: ctrl("-"), command: "layout.zoom-out", label: "Ctrl -" }'),
    ("actual-size-key-wrong", R, '{ chord: ctrl("1"), command: "layout.zoom-100", label: "Ctrl 1" }', '{ chord: ctrl("1"), command: "layout.fit", label: "Ctrl 1" }'),
    ("view-needs-no-scene", R, '  "layout.zoom-in": needScene,\n', ""),
    ("hand-needs-no-scene", R, '  "edit.hand": needScene,\n', ""),
    ("menu-fit-native", M, 'cmd("layout.fit", "Fit to window", "grapix", { native: "view-fit", shortcut: "Ctrl 0" }),', 'cmd("layout.fit", "Fit to window", "grapix", { native: "view-zoom-100", shortcut: "Ctrl 0" }),'),
    ("menu-zoom-item-lost", M, '      cmd("layout.zoom-out", "Zoom out", "grapix", { native: "view-zoom-out", shortcut: "Ctrl -" }),\n', ""),
    # the page
    ("page-footer-fit-lost", H, 'data-menu-item="layout.fit" data-native="view-fit">Fit</button>', 'data-menu-item="layout.fit" data-native="view-zoom-in">Fit</button>'),
    ("page-hand-button-lost", H, '          <button id="tool-hand" type="button"', '          <button id="tool-hand-x" type="button"'),
    ("page-middle-pan-lost", P, "(event.button === 1 || (event.button === 0 && activeTool === \"hand\"))", "(event.button === 0 && activeTool === \"hand\")"),
    ("page-hand-pans-any-tool", P, "(event.button === 1 || (event.button === 0 && activeTool === \"hand\"))", "(event.button === 1 || event.button === 0)"),
    ("page-zoom-click-out-lost", P, "zoomView(event.altKey ? 1 / ZOOM_STEP : ZOOM_STEP, paneOffset(event.clientX, event.clientY));", "zoomView(ZOOM_STEP, paneOffset(event.clientX, event.clientY));"),
    ("page-zoom-click-centre", P, "zoomView(event.altKey ? 1 / ZOOM_STEP : ZOOM_STEP, paneOffset(event.clientX, event.clientY));", "zoomView(event.altKey ? 1 / ZOOM_STEP : ZOOM_STEP);"),
    ("page-pan-move-lost", P, "function onOverlayPointerMove(event: PointerEvent): void {\n  if (panning !== undefined && panning.pointerId === event.pointerId) {\n    movePan(event);\n    return;\n  }\n", "function onOverlayPointerMove(event: PointerEvent): void {\n"),
    ("page-pan-end-lost", P, "  if (panning !== undefined && panning.pointerId === event.pointerId) {\n    endPan(event);\n    return;\n  }\n", ""),
    ("page-pan-start-from-camera", P, "panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera };", "panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: FIT };"),
    ("page-pan-not-captured", P, "  ui.overlay.setPointerCapture(event.pointerId);\n  ui.overlay.dataset.panning = \"true\";", "  ui.overlay.dataset.panning = \"true\";"),
    ("page-pan-cursor-stuck", P, "  panning = undefined;\n  delete ui.overlay.dataset.panning;", "  panning = undefined;"),
    ("page-wheel-passive", P, ".addEventListener(\"wheel\", onViewWheel, { passive: false })", ".addEventListener(\"wheel\", onViewWheel)"),
    ("page-wheel-no-scene-guard", P, "  if (!scene) return;\n  event.preventDefault();\n  // A line or a page", "  event.preventDefault();\n  // A line or a page"),
    ("page-wheel-lines-as-pixels", P, "event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1)", "event.deltaY"),
    ("page-wheel-shift-lost", P, "  if (event.shiftKey && !event.ctrlKey) {\n    const { pane, picture } = viewSizes();", "  if (false) {\n    const { pane, picture } = viewSizes();"),
    ("page-wheel-centre", P, "zoomView(wheelFactor(pixels), paneOffset(event.clientX, event.clientY));", "zoomView(wheelFactor(pixels));"),
    ("page-pane-offset-corner", P, "x: clientX - (stage.left + stage.width / 2), y: clientY - (stage.top + stage.height / 2)", "x: clientX - stage.left, y: clientY - stage.top"),
    ("page-sizes-scaled", P, "picture: { width: ui.canvas.offsetWidth, height: ui.canvas.offsetHeight },", "picture: { width: ui.canvas.getBoundingClientRect().width, height: ui.canvas.getBoundingClientRect().height },"),
    ("page-backdrop-scaled", P, "ui.viewportBackdrop.style.width = `${ui.canvas.offsetWidth}px`;", "ui.viewportBackdrop.style.width = `${ui.canvas.getBoundingClientRect().width}px`;"),
    ("page-clamp-lost", P, "  camera = clampPan(camera, pane, picture);\n  const surface = viewSurface();", "  const surface = viewSurface();"),
    ("page-readout-lost", P, "  ui.viewerZoomReadout.textContent = zoomLabel(camera, fitScale()) || \"100%\";\n", ""),
    ("page-observer-no-camera", P, "new ResizeObserver(() => {\n  applyBackdrop();\n  syncCamera();\n}).observe(ui.canvas);", "new ResizeObserver(() => {\n  applyBackdrop();\n}).observe(ui.canvas);"),
    ("page-scene-keeps-camera", P, "  if (sceneKey !== cameraScene) {\n    cameraScene = sceneKey;\n    camera = FIT;\n    syncCamera();\n  }", "  if (sceneKey !== cameraScene) {\n    cameraScene = sceneKey;\n    syncCamera();\n  }"),
    ("page-fit-native", P, "    case \"view-fit\":\n      setCamera(FIT);", "    case \"view-fit\":\n      zoomView(1);"),
    ("page-zoom-in-native-out", P, "    case \"view-zoom-in\":\n      zoomView(ZOOM_STEP);", "    case \"view-zoom-in\":\n      zoomView(1 / ZOOM_STEP);"),
    ("page-actual-size-lost", P, "setCamera(atPercent(camera, 100, fitScale(), pane, picture));", "setCamera(camera);"),
    ("page-unit-lost", P, "      unit: overlayUnit(),\n", ""),
    ("page-unit-inverted", P, "return active !== null && box.width > 0 ? active.canvas.width / box.width : 1;", "return active !== null && box.width > 0 ? box.width / active.canvas.width : 1;"),
    ("page-footer-states-lost", P, ".creation-tools button[data-menu-item], .viewer-footer button[data-menu-item]", ".creation-tools button[data-menu-item]"),
    ("page-pen-dies-for-hand", P, "if (activeTool === \"pen\" && tool !== \"pen\" && tool !== \"hand\" && tool !== \"zoom\") leavePen();", "if (activeTool === \"pen\" && tool !== \"pen\") leavePen();"),
    ("page-drag-tool-with-hand", P, "if ((activeTool === \"move\" || activeTool === \"rotate\" || activeTool === \"scale\" || activeTool === \"pivot\") && scene && !additive) {", "if (activeTool !== \"select\" && activeTool !== \"pen\" && scene && !additive) {"),
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
        log = os.path.join(OUT, "mutview_%s.log" % name)
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
