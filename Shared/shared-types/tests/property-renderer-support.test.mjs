import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONTAINER_OBJECT_TYPES,
  PROGRAM_OBJECT_TYPES,
  claimedProperties,
  isPropertyAuthorable,
  propertyRendererSupport
} from "../dist/index.js";

/**
 * The property-support contract, and its agreement with the file the Rust renderer reads.
 *
 * The Editor's audit proves the panel obeys this contract; these tests prove the contract itself is
 * coherent and that its one cross-language claim matches what the native renderer actually does.
 */

async function loadContract() {
  const path = new URL("../contracts/program-object-types.json", import.meta.url);
  return JSON.parse(await readFile(path, "utf8"));
}

test("PROGRAM_OBJECT_TYPES matches the file the Rust test reads", async () => {
  const contract = await loadContract();
  assert.deepEqual([...PROGRAM_OBJECT_TYPES].sort(), [...contract.programObjectTypes].sort());
});

test("the two halves of the interchange file partition every declared object type", async () => {
  const contract = await loadContract();
  const all = [...contract.programObjectTypes, ...contract.notRenderedByProgram].sort();
  const declared = [
    "camera", "ellipse", "group", "image", "layer", "light", "line", "marker", "mesh", "paint",
    "rect", "shape", "text"
  ];
  assert.deepEqual(all, declared, "every SceneObjectType must be on exactly one side");
  const overlap = contract.programObjectTypes.filter((type) => contract.notRenderedByProgram.includes(type));
  assert.deepEqual(overlap, []);
});

test("a type Program cannot render reports Preview-only for an unclaimed property", async () => {
  const contract = await loadContract();
  for (const type of contract.notRenderedByProgram) {
    if (CONTAINER_OBJECT_TYPES.includes(type)) continue;
    const claim = propertyRendererSupport(type, "someUnclaimedProperty");
    assert.equal(claim?.support, "preview", `${type} should downgrade to preview`);
    assert.ok(claim?.note?.includes(type));
  }
});

test("containers are exempt, because their transform reaches Program through their children", () => {
  for (const type of CONTAINER_OBJECT_TYPES) {
    assert.equal(propertyRendererSupport(type, "someUnclaimedProperty"), undefined);
  }
});

test("a property Program renders is not downgraded", () => {
  for (const type of PROGRAM_OBJECT_TYPES) {
    assert.equal(propertyRendererSupport(type, "someUnclaimedProperty"), undefined);
  }
});

test("every claim that is not `both` or `editor` carries its wording", () => {
  const types = [
    "text", "rect", "ellipse", "image", "line", "shape", "paint", "mesh", "light", "camera",
    "layer", "marker", "group"
  ];
  for (const type of types) {
    for (const property of claimedProperties(type)) {
      const claim = propertyRendererSupport(type, property);
      if (!claim || claim.support === "both" || claim.support === "editor") continue;
      assert.ok(claim.note, `${type}.${property} (${claim.support}) has no note`);
    }
  }
});

test("`neither` is the only verdict that removes authorability", () => {
  assert.equal(isPropertyAuthorable("shape", "fillRule"), true, "program-only stays authorable");
  assert.equal(isPropertyAuthorable("text", "textCase"), true, "preview-only stays authorable");
  assert.equal(isPropertyAuthorable("text", "paragraphSpacing"), false);
  assert.equal(isPropertyAuthorable("marker", "eventName"), false);
  assert.equal(isPropertyAuthorable("rect", "effects"), false);
  assert.equal(isPropertyAuthorable("rect", "locked"), true, "editor state stays authorable");
});

test("the corrected fill-rule claim does not restate the wrong one", () => {
  const claim = propertyRendererSupport("shape", "fillRule");
  assert.equal(claim?.support, "program");
  assert.match(claim?.note ?? "", /Program tessellates even-odd/);
  assert.match(claim?.note ?? "", /Preview ignores/);
});

test("dimensions are refused exactly where the geometry ignores them", () => {
  for (const type of ["line", "shape", "paint"]) {
    for (const property of ["width", "height"]) {
      assert.equal(propertyRendererSupport(type, property)?.support, "neither", `${type}.${property}`);
    }
  }
  // A rect is drawn from its dimensions, so no claim narrows them.
  assert.equal(propertyRendererSupport("rect", "width"), undefined);
});
