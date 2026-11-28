import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const fixture = new URL("../../../../tests/reference-scenes/colour-ramp-50.json", import.meta.url);
const properties = [
  ["caption", "text", "size", 16, 28],
  ["caption", "text", "lineHeight", 0.9, 1.6],
  ["caption", "text", "letterSpacing", -50, 200],
  ["caption", "text", "baselineShift", -5, 10],
  ["ramp-red", "rect", "radius", 0, 15],
  ["path", "shape", "strokeWidth", 2, 9],
  ["path", "shape", "trimStart", 0, 60],
  ["path", "shape", "trimEnd", 40, 100],
];

async function previewFor(mutation) {
  const plugins = mutation ? [{
    name: "preview-mutation",
    setup(builder) {
      builder.onLoad({ filter: /preview-playback\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        const [original, replacement] = mutation;
        assert.equal(source.split(original).length, 2, "unique mutation target");
        return { contents: source.replace(original, replacement), loader: "ts" };
      });
    },
  }] : [];
  const bundled = await build({
    stdin: {
      contents: "export { previewSceneAt } from './Editor/src/preview-playback';",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins,
  });
  const encoded = Buffer.from(bundled.outputFiles[0].text).toString("base64");
  return (await import("data:text/javascript;base64," + encoded)).previewSceneAt;
}

function channel(objectId, property, low, high) {
  return {
    objectId,
    property,
    keys: [
      { frame: 0, value: low, easing: "linear" },
      { frame: 10, value: high, easing: "linear" },
    ],
  };
}

async function verify(mutation) {
  const preview = await previewFor(mutation);
  const document = JSON.parse(readFileSync(fixture, "utf8"));
  const propertyKinds = Object.fromEntries(properties.map(([, kind, property]) => [property, [kind]]));
  const surface = {
    properties: Object.keys(propertyKinds),
    propertyKinds,
    objectKinds: ["text", "rect", "shape"],
    easings: ["linear"],
  };
  document.timeline.channels = properties.map(([id, , property, low, high]) => channel(id, property, low, high));

  for (const frame of [0, 5, 10]) {
    const actual = preview(document, frame, surface);
    assert.deepEqual(actual.issues, []);
    for (const [id, , property, low, high] of properties) {
      const object = actual.document.objects.find(({ id: objectId }) => objectId === id);
      assert.equal(object[property], low + (high - low) * (frame / 10), "evaluated property at frame");
    }
  }

  document.timeline.channels = [channel("path", "size", 16, 28)];
  assert.deepEqual(
    preview(document, 5, surface).issues,
    ["animation preview does not support property size on path"],
    "wrong kind must be named",
  );
}

await verify();
console.log("Editor preview matched the CPU and GPU witnesses for eight properties at frames 0, 5 and 10.");
for (const [name, mutation, assertion] of [
  ["evaluate at frame zero", ["evaluateChannel(channel, frame)", "evaluateChannel(channel, 0)"], /evaluated property at frame/],
  ["accept wrong object kind", [
    "!supportsScalarProperty(surface, object.type, channel.property)",
    "!surface.properties.includes(channel.property)",
  ], /wrong kind must be named/],
]) {
  await assert.rejects(verify(mutation), assertion);
  console.log("Caught mutation " + name);
}

