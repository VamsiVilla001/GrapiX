import os, shutil, subprocess

WT = r"D:\Project KK\Personal projects\GrapiX\agent\worktree"
OUT = os.path.dirname(os.path.abspath(__file__))
RS = os.path.join(WT, "services", "editor", "src", "command.rs")
SM = os.path.join(WT, "Editor", "src", "save-model.ts")
MAIN = os.path.join(WT, "Editor", "web", "main.ts")
MENU = os.path.join(WT, "Editor", "src", "app-menu.ts")
env = dict(os.environ, CARGO_TARGET_DIR="D:/Project KK/Personal projects/GrapiX/agent/tmp/target-fx")
env.pop("TAURI_CONFIG", None)
RUST = ["cargo", "test", "-p", "gx-editor", "--lib", "command::"]
WEB = "npx vitest run Editor/tests/save-model.test.ts"

MUTANTS = [
    ("old-version-written", RS, "                    projects.write_scene(&origin.project, &document)?;\n                    // Only now", "                    projects.write_scene(&origin.project, &session.document)?;\n                    projects.write_scene(&origin.project, &document)?;\n                    // Only now", RUST),
    ("id-not-changed", RS, "                    document.id = scene_id.clone();\n", "", RUST),
    ("name-not-numbered", RS, "                    document.name = versioned_name(&document.name, number);\n", "", RUST),
    ("revision-kept", RS, "                    document.revision = None;\n                    projects.write_scene", "                    projects.write_scene", RUST),
    ("history-kept", RS, "                    session.log.clear();\n                    session.redo.clear();\n                    session.folded = 0;\n", "", RUST),
    ("base-not-replaced", RS, "                    session.base = document.clone();\n", "", RUST),
    ("origin-not-rebound", RS, "                    session.origin = Some(origin.clone());\n                    // The file", "                    // The file", RUST),
    ("old-path-kept", RS, "                    session.path = None;\n                    session.dirty = false;\n                    session.project_dirty = false;\n                    saved_revision", "                    session.dirty = false;\n                    session.project_dirty = false;\n                    saved_revision", RUST),
    ("still-dirty", RS, "                    session.path = None;\n                    session.dirty = false;\n                    session.project_dirty = false;\n", "                    session.path = None;\n", RUST),
    ("project-still-dirty", RS, "                    session.dirty = false;\n                    session.project_dirty = false;\n                    saved_revision", "                    session.dirty = false;\n                    saved_revision", RUST),
    ("effect-lost", RS, "                    saved_revision = Some(Revision(0));\n                    EditEffect::Stored { origin }\n                } else if", "                    saved_revision = Some(Revision(0));\n                    EditEffect::None\n                } else if", RUST),
    ("list-read-outside-lock", RS, "                    let _write = projects.lock_scenes(&origin.project)?;\n                    let taken = projects.list_scenes(&origin.project)?;\n                    let (scene_id, number)", "                    let taken = projects.list_scenes(&origin.project)?;\n                    let (scene_id, number)", RUST),
    ("file-old-written", RS, "                    write_scene_file(&next, &session.document)?;\n", "                    write_scene_file(&next, &session.document)?;\n                    write_scene_file(&path, &session.document)?;\n", RUST),
    ("file-path-not-moved", RS, "                    session.path = Some(next);\n", "", RUST),
    ("file-still-dirty", RS, "                    session.path = Some(next);\n                    session.dirty = false;\n", "                    session.path = Some(next);\n", RUST),
    ("unsaved-saved-anyway", RS, "                    return Err(Refusal::SessionUnbound { session: key }.into());\n                }\n            }\n        };", "                    EditEffect::None\n                }\n            }\n        };", RUST),
    ("number-not-after-current", RS, "(number.map_or(2, |number| number + 1)..=MAX_VERSION)\n        .map(|number| (format!", "(2..=MAX_VERSION)\n        .map(|number| (format!", RUST),
    ("taken-not-passed-over", RS, ".find(|(id, _)| !taken(id))", ".next()", RUST),
    ("path-taken-not-passed-over", RS, "(!candidate.exists()).then(|| candidate.display().to_string())", "Some(candidate.display().to_string())", RUST),
    ("zero-is-a-number", RS, "if number >= 1 && at > 0 {", "if at > 0 {", RUST),
    ("empty-base-allowed", RS, "if number >= 1 && at > 0 {", "if number >= 1 {", RUST),
    ("any-suffix-is-a-number", RS, "if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {", "if !digits.is_empty() {", RUST),
    ("two-digit-pad-dropped", RS, "format!(\"{base}_v{number:03}\"), number))", "format!(\"{base}_v{number}\"), number))", RUST),
    ("name-trim-dropped", RS, "    let name = name.trim();\n    let (base, _) = split_version(name, ' ');", "    let (base, _) = split_version(name, ' ');", RUST),
    ("shortcut-ignores-editing", SM, "if (editing || !(press.ctrlKey || press.metaKey) || press.altKey) return undefined;", "if (!(press.ctrlKey || press.metaKey) || press.altKey) return undefined;", WEB),
    ("shortcut-ignores-alt", SM, "if (editing || !(press.ctrlKey || press.metaKey) || press.altKey) return undefined;", "if (editing || !(press.ctrlKey || press.metaKey)) return undefined;", WEB),
    ("shortcut-without-ctrl", SM, "if (editing || !(press.ctrlKey || press.metaKey) || press.altKey) return undefined;", "if (editing || press.altKey) return undefined;", WEB),
    ("shift-is-plain-save", SM, "return press.shiftKey ? \"next-version\" : \"save\";", "return \"save\";", WEB),
    ("plain-save-is-version", SM, "return press.shiftKey ? \"next-version\" : \"save\";", "return \"next-version\";", WEB),
    ("file-before-stored", SM, "  if (state.stored) return \"stored\";\n  if (state.file) return \"file\";", "  if (state.file) return \"file\";\n  if (state.stored) return \"stored\";", WEB),
    ("project-before-file", SM, "  if (state.file) return \"file\";\n  return state.project ? \"project\" : \"dialog\";", "  if (state.project) return \"project\";\n  if (state.file) return \"file\";\n  return \"dialog\";", WEB),
    ("first-save-ignores-file", SM, "return !state.stored && !state.file;", "return !state.stored;", WEB),
    ("label-always-file", SM, "if (effect.effect === \"stored\") return", "if (effect.effect === \"never\") return", WEB),
    ("menu-save-wrong-key", MENU, "native: \"save\", shortcut: \"Ctrl S\"", "native: \"save\", shortcut: \"Ctrl Alt S\"", WEB),
    ("menu-version-waits", MENU, "native: \"save-next-version\", shortcut: \"Ctrl Shift S\", basedOn", "row: \"11.30\", shortcut: \"Ctrl Shift S\", basedOn", WEB),
    ("page-plain-save-makes-version", MAIN, "{ command: \"saveScene\", session: session.key, to: { to: \"origin\" } },\n        { label: `Saved", "{ command: \"saveScene\", session: session.key, to: { to: \"nextVersion\" } },\n        { label: `Saved", WEB),
]

only = set(__import__("sys").argv[1:])
results = []
for name, path, old, new, test in MUTANTS:
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
        log = os.path.join(OUT, "mutver_%s.log" % name)
        with open(log, "wb") as fh:
            rc = subprocess.run(test, cwd=WT, env=env, stdout=fh, stderr=subprocess.STDOUT, timeout=900, shell=isinstance(test, str)).returncode
        body = open(log, "rb").read().decode("utf-8", "replace")
        if rc == 0:
            verdict = "SURVIVED"
        elif "error[E" in body or "could not compile" in body or "error TS" in body:
            verdict = "BUILD ERROR"
        elif isinstance(test, str):
            failed = [l.strip()[:100] for l in body.splitlines() if "\u00d7" in l or " FAIL " in l]
            verdict = "KILLED by " + " | ".join(failed[:2])
        else:
            failed = sorted(set(l.split("::")[-1].split(" ")[0] for l in body.splitlines() if l.startswith("test ") and l.endswith("FAILED")))
            verdict = "KILLED by " + ", ".join(failed)
        results.append((name, verdict))
    finally:
        shutil.copyfile(backup, path)
        os.remove(backup)
        print(results[-1] if results else "", flush=True)

print("---")
for name, verdict in results:
    print("%-32s %s" % (name, verdict.encode("ascii", "replace").decode("ascii")))
