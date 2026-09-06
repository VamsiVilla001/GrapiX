import { SCENE_KEYFRAME_EASINGS, applyEasing } from "../../Shared/shared-types/dist/index.js";
import { writeFileSync } from "node:fs";

const times = Array.from({ length: 33 }, (_, i) => i / 32);
const easings = {};
for (const name of SCENE_KEYFRAME_EASINGS) {
  easings[name] = times.map((t) => {
    const v = applyEasing(name, t);
    if (v === undefined) throw new Error("no implementation for " + name);
    return v;
  });
}
const fixture = {
  $comment: "Conformance vectors for the easing specification. Generated once from Shared/shared-types/src/easing.ts and checked in. Both the TypeScript evaluator and services/render-engine/src/easing.rs must reproduce every value to 1e-9. NEVER regenerate this file to make a test pass - a changed number means a changed curve, and every scene already authored against it then animates differently.",
  sampleCount: times.length,
  tolerance: 1e-9,
  times,
  easings
};
writeFileSync(new URL("../../Shared/animation-engine/fixtures/easing-vectors.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
console.log("easings:", Object.keys(easings).length, "| samples each:", times.length);
for (const n of ["linear","hold","ease","ease-in","ease-out-bounce","ease-in-out-elastic"]) {
  console.log(" ", n.padEnd(20), easings[n].slice(0,3).map(v=>v.toFixed(6)).join(" "), "...", easings[n].at(-1).toFixed(6));
}
