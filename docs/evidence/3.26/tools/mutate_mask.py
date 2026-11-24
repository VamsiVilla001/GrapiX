"""3.26 and 3.27: mutate the CPU mask fold and feather weights; each mutant must fail a named test.

Run from the repository root:  python -I docs/evidence/3.26/tools/mutate_mask.py
The file is restored after every mutant (and a .mutbak copy is kept until the end).
"""
import shutil
import subprocess
import sys

PATH = "services/render-engine/worker/src/rasterise/mask.rs"
COMMAND = ["cargo", "test", "-p", "gx-render-worker", "--lib", "--", "rasterise::mask"]

MUTANTS = [
    ("lighten-is-min", "MaskMode::Lighten => a.max(c),", "MaskMode::Lighten => a.min(c),"),
    ("darken-is-max", "MaskMode::Darken => a.min(c),", "MaskMode::Darken => a.max(c),"),
    ("difference-is-xor", "MaskMode::Difference => (a - c).abs(),", "MaskMode::Difference => a + c - 2.0 * a * c,"),
    ("add-is-sum", "MaskMode::Add => a + c - a * c,", "MaskMode::Add => (a + c).min(1.0),"),
    ("subtract-is-difference", "MaskMode::Subtract => a * (1.0 - c),", "MaskMode::Subtract => (a - c).abs(),"),
    ("initial-from-whole", "Some(m) if m.mode != MaskMode::Subtract => 0.0,", "Some(m) if m.mode == MaskMode::Add => 0.0,"),
    ("initial-none-is-empty", "        _ => 1.0,\n    }\n}\n\n/// The mode each mask folds with", "        _ => 0.0,\n    }\n}\n\n/// The mode each mask folds with"),
    ("first-darken-hides", "MaskMode::Intersect | MaskMode::Darken if Some(i) == first => MaskMode::Add,", "MaskMode::Intersect if Some(i) == first => MaskMode::Add,"),
    ("first-intersect-hides", "MaskMode::Intersect | MaskMode::Darken if Some(i) == first => MaskMode::Add,", "MaskMode::Darken if Some(i) == first => MaskMode::Add,"),
    ("linear-radius-floor", "let radius = (feather / 2.0).ceil() as usize;", "let radius = (feather / 2.0).floor() as usize;"),
    ("axis-identity-lost", "        vec![1.0]\n    } else {", "        Vec::new()\n    } else {"),
    ("y-uses-x", "&axis_weights(&mask.weights_y),", "&axis_weights(&mask.weights),"),
    ("smooth-falloff-is-box", "MaskFalloff::Smooth => feather_weights(feather),", "MaskFalloff::Smooth => falloff_weights(feather, MaskFalloff::Linear),"),
]


def main() -> int:
    shutil.copyfile(PATH, PATH + ".mutbak")
    survived = []
    try:
        for name, old, new in MUTANTS:
            source = open(PATH + ".mutbak", encoding="utf-8").read()
            if old not in source:
                print(f"{name:28} PATTERN NOT FOUND")
                survived.append(name)
                continue
            open(PATH, "w", encoding="utf-8", newline="\n").write(source.replace(old, new, 1))
            run = subprocess.run(COMMAND, capture_output=True, text=True)
            output = run.stdout + run.stderr
            if run.returncode == 0:
                print(f"{name:28} SURVIVED")
                survived.append(name)
            else:
                failed = [l.split(" ... ")[0].replace("test ", "") for l in output.splitlines() if l.startswith("test ") and "FAILED" in l]
                print(f"{name:28} killed by {failed or 'a build error'}")
    finally:
        shutil.copyfile(PATH + ".mutbak", PATH)
    print(f"killed {len(MUTANTS) - len(survived)} of {len(MUTANTS)}; survivors: {survived}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
