import assert from "node:assert/strict";
import test from "node:test";
import { nextUniqueObjectName } from "../src/store/objectNaming";

test("new objects receive stable one-based names", () => {
  assert.equal(nextUniqueObjectName([], "Quad"), "Quad 1");
  assert.equal(nextUniqueObjectName([{ name: "Quad 1" }], "Quad"), "Quad 2");
});

test("object names are unique without regard to case", () => {
  assert.equal(
    nextUniqueObjectName([{ name: "quad 1" }, { name: "QUAD 2" }], "Quad"),
    "Quad 3"
  );
});

test("duplicates continue the source object's numeric sequence", () => {
  assert.equal(
    nextUniqueObjectName([{ name: "Quad 1" }, { name: "Quad 2" }], "Quad 2 Copy"),
    "Quad 3"
  );
});

test("blank generated names use the Object base", () => {
  assert.equal(nextUniqueObjectName([], "   "), "Object 1");
});
