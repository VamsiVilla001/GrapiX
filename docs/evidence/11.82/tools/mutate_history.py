import os, shutil, subprocess, sys

WT = r"D:\Project KK\Personal projects\GrapiX\agent\worktree"
OUT = os.path.dirname(os.path.abspath(__file__))
RS = os.path.join(WT, "services", "editor", "src", "command.rs")
TS = os.path.join(WT, "Editor", "src", "history-list.ts")
MENU = os.path.join(WT, "Editor", "src", "app-menu.ts")
env = dict(os.environ, CARGO_TARGET_DIR="D:/Project KK/Personal projects/GrapiX/agent/tmp/target-fx")
env.pop("TAURI_CONFIG", None)
RUST = ["cargo", "test", "-p", "gx-editor", "--lib", "command::"]
WEB = "npx vitest run Editor/tests/history-list.test.ts"

MUTANTS = [
    ("step-off-by-one", RS, "                    })?;\n                index + 1\n", "                    })?;\n                index\n", RUST),
    ("redo-order-not-reversed", RS, "                self.redo = self.log[applied..]\n                    .iter()\n                    .rev()\n", "                self.redo = self.log[applied..]\n                    .iter()\n", RUST),
    ("redo-stack-not-rebuilt", RS, "                self.redo = self.log[applied..]\n                    .iter()\n                    .rev()\n                    .map(|entry| entry.seq)\n                    .collect();\n                Ok(true)", "                Ok(true)", RUST),
    ("noop-marks-edited", RS, "        if session.go_to(step)? {\n            session.mark_edited();\n        }\n", "        session.go_to(step)?;\n        session.mark_edited();\n", RUST),
    ("jump-not-marked-edited", RS, "        if session.go_to(step)? {\n            session.mark_edited();\n        }\n", "        session.go_to(step)?;\n", RUST),
    ("flags-not-put-back", RS, "                for (entry, active) in self.log.iter_mut().zip(before) {\n                    entry.active = active;\n                }\n", "                let _ = before;\n", RUST),
    ("skipped-steps-stay-undone", RS, "            entry.active = index < applied;\n", "            if index >= applied {\n                entry.active = false;\n            }\n", RUST),
    ("stale-step-lands-on-next", RS, ".position(|entry| step_id(entry.seq) == step)", ".position(|entry| step_id(entry.seq) >= step)", RUST),
    ("folded-not-counted", RS, "            self.folded = self.folded.saturating_add(1);\n", "", RUST),
    ("direction-always-undo", RS, "            HistoryDirection::Undo\n        } else {\n            HistoryDirection::Redo\n        };\n        for (index, entry)", "            HistoryDirection::Undo\n        } else {\n            HistoryDirection::Undo\n        };\n        for (index, entry)", RUST),
    ("direction-always-redo", RS, "            HistoryDirection::Undo\n        } else {\n            HistoryDirection::Redo\n        };\n        for (index, entry)", "            HistoryDirection::Redo\n        } else {\n            HistoryDirection::Redo\n        };\n        for (index, entry)", RUST),
    ("about-dropped", RS, "                    about: entry.edits.first().and_then(about),\n", "                    about: None,\n", RUST),
    ("undone-shown-applied", RS, "                    applied: entry.active,\n", "                    applied: true,\n", RUST),
    ("document-not-replaced", RS, "                self.document = document;\n                // Redo takes", "                let _ = document;\n                // Redo takes", RUST),
    ("only-first-edit-listed", RS, "                    edits: entry\n                        .edits\n                        .iter()\n                        .map(", "                    edits: entry\n                        .edits\n                        .iter()\n                        .take(1)\n                        .map(", RUST),
    ("current-off-by-one", TS, "current: inOrder && index === appliedCount - 1,", "current: inOrder && index === appliedCount,", WEB),
    ("holes-ignored", TS, "const inOrder = view.steps.every((step, index) => step.applied === index < appliedCount);", "const inOrder = view.steps.length >= 0;", WEB),
    ("opening-never-current", TS, "current: inOrder && appliedCount === 0,", "current: false,", WEB),
    ("same-edits-not-counted", TS, "title = rest.every((kind) => kind === first)", "title = rest.length < 0", WEB),
    ("about-lost", TS, "return step.about === undefined ? title : `${title}: ${step.about}`;", "return title;", WEB),
    ("unknown-edit-hidden", TS, "[kind] ?? kind;", "[kind] ?? \"Change\";", WEB),
    ("one-undone-not-counted", TS, "if (undone > 0) parts.push", "if (undone > 2) parts.push", WEB),
    ("limit-always-named", TS, "if (view.folded > 0) line +=", "if (view.folded >= 0) line +=", WEB),
    ("folded-not-in-opening-row", TS, "title: view.folded === 0 ? \"Scene as opened\"", "title: view.folded >= 0 ? \"Scene as opened\"", WEB),
    ("undone-rows-shown-applied", TS, "      applied: step.applied,\n", "      applied: true,\n", WEB),
    ("a-word-left-as-wire-name", TS, "  setTrim: \"Trim path\",", "  setTrim: \"setTrim\",", WEB),
    ("module-word-not-a-heading", TS, "  inspector: \"Properties\",", "  inspector: \"Inspector\",", WEB),
    ("menu-item-not-wired", MENU, "{ invoke: \"history-open\", basedOn: \"Undo/Redo History\" }", "{ row: \"11.82\", basedOn: \"Undo/Redo History\" }", WEB),
]

only = set(sys.argv[1:])
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
        log = os.path.join(OUT, "muthist_%s.log" % name)
        with open(log, "wb") as fh:
            rc = subprocess.run(test, cwd=WT, env=env, stdout=fh, stderr=subprocess.STDOUT, timeout=900, shell=isinstance(test, str)).returncode
        body = open(log, "rb").read().decode("utf-8", "replace")
        if rc == 0:
            verdict = "SURVIVED"
        elif "error[E" in body or "could not compile" in body or "error TS" in body:
            verdict = "BUILD ERROR"
        elif isinstance(test, str):
            failed = [l.strip()[:110] for l in body.splitlines() if "\u00d7" in l or " FAIL " in l]
            verdict = "KILLED by " + " | ".join(failed[:3])
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
    print("%-28s %s" % (name, verdict.encode("ascii", "replace").decode("ascii")))
