import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAepToManifest, RifxFormatError } from "../dist/ae/aepParser.js";

/**
 * Native `.aep` import — reading a binary After Effects project without After Effects.
 *
 * Two kinds of test, because the format has two kinds of confidence.
 *
 * **Against real After Effects output.** `fixtures/aep/*.aep` are the test projects from
 * `boltframe/aftereffects-aep-parser` (MIT), saved by After Effects itself. Every number asserted
 * here is one that project's own suite asserts, so a wrong offset in this reader fails against a
 * value After Effects wrote rather than against our own opinion: composition geometry, frame rate,
 * duration and background, the seventeen single-switch layers, the solid and placeholder footage
 * items, the seven expression controls, and the text layer's document.
 *
 * **Against the specification, synthetically.** No fixture contains a keyframe or a mask — the
 * reference projects only exercise metadata — so those layouts are pinned by building the chunk
 * tree byte by byte from the documented structure. That is weaker evidence than an AE-authored
 * file and it is deliberately marked as such, but it does catch the regression that matters: a
 * change to the keyframe or mask decoding that stops matching the layout it was written against.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "aep");
const load = (name) => parseAepToManifest(new Uint8Array(readFileSync(path.join(FIXTURES, name))), name.replace(/\.aep$/, ""), path.join(FIXTURES, name));

test("a project's item tree, ids and types survive the read", () => {
  const manifest = load("Item-01.aep");

  assert.equal(manifest.producer, "aep-native");
  assert.deepEqual(manifest.warnings, [], "a project After Effects wrote must read without degradation");
  assert.deepEqual(
    manifest.compositions.map((composition) => [composition.id, composition.name]),
    [["48", "Comp 01"], ["59", "Comp 02"]]
  );
});

test("composition geometry, rate, duration and background are read from cdta", () => {
  const [first, second] = load("Item-01.aep").compositions;

  assert.equal(first.width, 351);
  assert.equal(first.height, 856);
  assert.equal(first.frameRate, 21);
  assert.equal(first.duration, 31);
  // Background is stored as three bytes; 0f4b52 is what After Effects wrote.
  assert.equal(first.backgroundColor, "#0f4b52");
  // An open work area (the 0xffffffff sentinel) means "to the end of the composition".
  assert.equal(first.workAreaStart, 0);
  assert.equal(first.workAreaDuration, 31);

  assert.equal(second.width, 452);
  assert.equal(second.height, 639);
  // 29.97 is stored as an integer plus a 16-bit fraction, not as a rational.
  assert.ok(Math.abs(second.frameRate - 29.97) < 0.0001, `frame rate ${second.frameRate}`);
  assert.ok(Math.abs(second.duration - 71.338004671338) < 1e-9, `duration ${second.duration}`);
  assert.equal(second.backgroundColor, "#91ce55");
});

test("footage items carry their size, their missing flag, and the name AE hides in opti", () => {
  const assets = load("Item-01.aep").assets;
  const byId = Object.fromEntries(assets.map((asset) => [asset.id, asset]));

  assert.equal(byId["71"].name, "Missing Footage");
  assert.equal(byId["71"].missing, true, "a placeholder is footage After Effects could not find");
  assert.equal(byId["73"].name, "Green Solid");
  assert.equal(byId["73"].missing, undefined, "a solid is not missing media");
  // AE writes an interior NUL where this name has a space; cutting at the first NUL would
  // truncate it to "Red Solid".
  assert.equal(byId["72"].name, "Red Solid 1");
});

test("a solid layer resolves its type and colour through its source item", () => {
  const [composition] = load("Item-01.aep").compositions;
  const [nullLayer, shapeLayer] = composition.layers;

  assert.equal(nullLayer.name, "Null 1");
  assert.equal(nullLayer.type, "null");
  assert.equal(nullLayer.sourceItemId, "78");
  assert.equal(nullLayer.solidColor, "#ffffff");
  assert.equal(shapeLayer.type, "shape");
  assert.equal(shapeLayer.sourceItemId, undefined, "a shape layer draws itself and has no source");
});

test("every layer switch is read from the right bit of ldta", () => {
  const [composition] = load("Layer-01.aep").compositions;
  const byName = Object.fromEntries(composition.layers.map((layer) => [layer.name, layer]));

  // Each layer in this project isolates one switch; its name says which.
  assert.equal(byName["Transformations Collapsed"].continuouslyRasterize, true);
  assert.equal(byName["Transformations Collapsed"].collapseTransformations, false, "on a shape layer the bit means continuously rasterize");
  assert.equal(byName["Motion Blur"].motionBlur, true);
  assert.equal(byName["Locked"].locked, true);
  assert.equal(byName["Shy"].shy, true);
  assert.equal(byName["Solo"].solo, true);
  assert.equal(byName["Guide"].guide, true);
  assert.equal(byName["3D"].is3d, true);
  assert.equal(byName["Frame Mix"].frameBlending, true);
  assert.equal(byName["Pixel Motion"].frameBlending, true);
  assert.equal(byName["Default"].motionBlur, false);
  assert.equal(byName["Default"].shy, false);
  assert.equal(byName["Default"].locked, false);

  // An adjustment layer carries the null bit too; reading them in the wrong order loses it.
  assert.equal(byName["Adjustment"].type, "adjustment");
  assert.equal(byName["Solo"].type, "null");
});

test("layer timing is read as the rationals AE stores, not as raw ticks", () => {
  const [composition] = load("Layer-01.aep").compositions;
  const layer = composition.layers[0];

  assert.equal(layer.inPoint, 0);
  assert.equal(layer.outPoint, 60, "the layer spans the whole 60 second composition");
  assert.equal(layer.startTime, 0);
  assert.equal(layer.stretch, 100, "unstretched is 100 percent, not the raw 1/1");
});

test("a transform property AE omitted reads as the default it omitted, not as zero", () => {
  const [composition] = load("Layer-01.aep").compositions;
  const shape = composition.layers[0];
  const nullLayer = composition.layers[1];

  // After Effects writes no ADBE Position for an untouched layer, and leaves the split-position
  // properties present holding zero. Believing those zeros puts every layer in the corner.
  assert.deepEqual(shape.position, [960, 540, 0], "position defaults to the composition centre");
  assert.deepEqual(shape.anchorPoint, [0, 0, 0], "a shape layer anchors at its own origin");
  assert.deepEqual(nullLayer.anchorPoint, [50, 50, 0], "an AV layer anchors at the centre of its 100x100 source");
  assert.deepEqual(shape.scale, [100, 100, 100]);
  assert.equal(shape.opacity, 100);
  assert.equal(shape.blendingMode, "normal", "transfer mode 2 is Normal, not Dissolve");
});

test("the effect stack keeps its match names, display names and stored parameters", () => {
  const [composition] = load("Property-01.aep").compositions;
  const [controls, text] = composition.layers;

  assert.deepEqual(
    controls.effects.map((effect) => effect.matchName),
    [
      "ADBE Checkbox Control",
      "ADBE Slider Control",
      "ADBE Point Control",
      "ADBE Point3D Control",
      "ADBE Color Control",
      "ADBE Angle Control",
      "ADBE Layer Control"
    ]
  );
  assert.deepEqual(
    controls.effects.map((effect) => effect.name),
    ["Checkbox Control", "Slider Control", "Point Control", "3D Point Control", "Color Control", "Angle Control", "Layer Control"]
  );
  // GrapiX cannot evaluate an After Effects effect, so every one arrives as a baked appearance.
  assert.ok(controls.effects.every((effect) => effect.status === "baked"));
  assert.equal(text.effects.length, 0);
});

test("a text layer's document is decoded out of the COS payload", () => {
  const manifest = load("Property-01.aep");
  const [, text] = manifest.compositions[0].layers;

  assert.equal(text.type, "text");
  // After Effects separates lines with CR; the manifest carries newlines.
  assert.equal(text.text.content, "Text Layer\n");
  assert.equal(text.text.fontFamily, "BritannicBold");
  assert.equal(text.text.fontSize, 185);
  assert.equal(text.text.fillColor, "#ffffff");
  // COS justification 2 is CENTER_JUSTIFY; off by one here silently left-aligns centred titles.
  assert.equal(text.text.align, "center");
  assert.deepEqual(manifest.fonts, [{ family: "BritannicBold", style: undefined, usedBy: ["Comp 01/Text Layer"] }]);
});

test("a file that is not a RIFX project is refused, not guessed at", () => {
  assert.throws(() => parseAepToManifest(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), "x", "x.aep"), RifxFormatError);
  // A RIFX container that is not an After Effects project is equally refused.
  const notAep = concat([ascii("RIFX"), u32(4), ascii("WAVE")]);
  assert.throws(() => parseAepToManifest(notAep, "x", "x.aep"), RifxFormatError);
});

// ---------------------------------------------------------------------------
// Synthetic chunk trees
//
// These build the bytes the specification describes, for the two structures no fixture in this
// repository contains. Weaker evidence than an AE-authored file, and pinned here so that the
// decoding cannot drift from the layout it was written against.
// ---------------------------------------------------------------------------

const ascii = (text) => new Uint8Array([...text].map((character) => character.charCodeAt(0)));

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const bytes = (length, fill = 0) => new Uint8Array(length).fill(fill);

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function s32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

function f32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, false);
  return out;
}

function f64(...values) {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, value, false));
  return out;
}

/** A leaf chunk, padded to an even length exactly as RIFF requires. */
function chunk(type, data) {
  const parts = [ascii(type), u32(data.length), data];
  if (data.length % 2 === 1) parts.push(bytes(1));
  return concat(parts);
}

const list = (id, ...children) => chunk("LIST", concat([ascii(id), concat(children)]));

/** A NUL-terminated match name, as `tdmn` stores it. */
const tdmn = (matchName) => chunk("tdmn", concat([ascii(matchName), bytes(1)]));

const FPS = 25;
const TIME_SCALE = 4;
/** frame rate * 256 * time scale, the unit keyframe times count in. */
const TIMEBASE = FPS * 256 * TIME_SCALE;

function cdta({ width = 1920, height = 1080, duration = 10 } = {}) {
  const data = bytes(204);
  const view = new DataView(data.buffer);
  view.setUint16(0, 1, false); // resolution factor
  view.setUint16(2, 1, false);
  view.setUint16(5, TIME_SCALE, false);
  view.setUint32(8, TIMEBASE, false);
  view.setUint32(16, 600, false); // standard timebase
  view.setUint32(36, 0xffffffff, false); // work area runs to the end
  view.setUint32(44, duration * TIMEBASE, false);
  view.setUint32(48, TIMEBASE, false);
  view.setUint16(140, width, false);
  view.setUint16(142, height, false);
  view.setUint16(156, FPS, false);
  return chunk("cdta", data);
}

function ldta({ id = 1, type = 0, sourceId = 0, outPoint = 10, blendingMode = 2 } = {}) {
  const data = bytes(160);
  const view = new DataView(data.buffer);
  view.setUint32(0, id, false);
  view.setUint16(4, 2, false); // best quality
  view.setInt32(8, 1, false); // stretch 1/1
  view.setUint32(16, 1, false); // start time divisor
  view.setUint32(24, 1, false); // in point divisor
  view.setInt32(28, outPoint, false);
  view.setUint32(32, 1, false);
  data[39] = 0x07; // visible + audio + effects active
  view.setUint32(40, sourceId, false);
  data[99] = blendingMode;
  view.setUint32(108, 1, false); // stretch divisor
  data[131] = type;
  return chunk("ldta", data);
}

/** `tdb4`: component count, the spatial and animated flags. */
function tdb4({ dimensions = 1, animated = false, spatial = false, color = false } = {}) {
  const data = bytes(124);
  const view = new DataView(data.buffer);
  view.setUint16(0, 0xdb99, false);
  view.setUint16(2, dimensions, false);
  data[5] = spatial ? 0x08 : 0x01;
  if (color) data[59] |= 0x01;
  data[68] = animated ? 1 : 0;
  return chunk("tdb4", data);
}

/** `lhd3` + `ldat`: the keyframe list header and its packed items. */
function keyframeList(itemTypeRaw, items) {
  const itemSize = items[0].length;
  const header = bytes(32);
  const view = new DataView(header.buffer);
  header.set(ascii("\u0000\u00d0\u000b\u00ee"), 0);
  view.setUint16(10, items.length, false);
  view.setUint16(18, itemSize, false);
  header[23] = itemTypeRaw;
  return list("list", chunk("lhd3", header), chunk("ldat", concat(items)));
}

/** A keyframe's common 8-byte header. */
const keyHeader = ({ seconds, inInterpolation = 1, outInterpolation = 1, label = 0, flags = 0x07 }) =>
  concat([s32(Math.round(seconds * TIMEBASE)), new Uint8Array([inInterpolation, outInterpolation, label, flags])]);

/** A one-dimensional keyframe: value, then in/out speed and influence. */
const scalarKey = (options) =>
  concat([keyHeader(options), f64(options.value, options.inSpeed ?? 0, options.inInfluence ?? 0, options.outSpeed ?? 0, options.outInfluence ?? 0)]);

/** A spatial keyframe: flags, scalar eases, then value and the two spatial tangents. */
const positionKey = (options) =>
  concat([
    keyHeader(options),
    bytes(8),
    f64(0, options.inSpeed ?? 0, options.inInfluence ?? 0, options.outSpeed ?? 0, options.outInfluence ?? 0),
    f64(...options.value),
    f64(...(options.spatialIn ?? [0, 0])),
    f64(...(options.spatialOut ?? [0, 0]))
  ]);

const property = (matchName, ...children) => concat([tdmn(matchName), list("tdbs", chunk("tdsb", u32(1)), ...children)]);

function project(...layerChildren) {
  const item = list(
    "Item",
    chunk("idta", concat([u16(4), bytes(14), u32(1), bytes(64)])),
    chunk("Utf8", ascii("Comp")),
    cdta(),
    list("Layr", ldta(), chunk("Utf8", ascii("Layer 1")), list("tdgp", ...layerChildren))
  );
  const body = concat([ascii("Egg!"), list("Fold", item)]);
  return concat([ascii("RIFX"), u32(body.length), body]);
}

test("an animated position decodes to seconds, values, ease and spatial tangents", () => {
  const bytesIn = project(
    tdmn("ADBE Transform Group"),
    list(
      "tdgp",
      property(
        "ADBE Position",
        tdb4({ dimensions: 2, animated: true, spatial: true }),
        chunk("cdat", f64(0, 0)),
        keyframeList(4, [
          positionKey({ seconds: 0, value: [100, 200], outInterpolation: 2, outSpeed: 12, outInfluence: 40, spatialOut: [5, 6] }),
          positionKey({ seconds: 2, value: [300, 400], inInterpolation: 2, inSpeed: 8, inInfluence: 75, spatialIn: [-5, -6] })
        ])
      ),
      tdmn("ADBE Group End")
    ),
    tdmn("ADBE Group End")
  );

  const [composition] = parseAepToManifest(bytesIn, "synthetic", "synthetic.aep").compositions;
  const stream = composition.layers[0].streams.find((candidate) => candidate.property === "position");

  assert.ok(stream, "an animated position must produce a position stream");
  assert.equal(stream.keyframes.length, 2);
  assert.equal(stream.keyframes[0].time, 0);
  assert.equal(stream.keyframes[1].time, 2, "keyframe times are timebase units, read back as seconds");
  assert.deepEqual(stream.keyframes[0].value, [100, 200]);
  assert.deepEqual(stream.keyframes[1].value, [300, 400]);
  assert.equal(stream.keyframes[0].interpolation, "bezier");
  // Ease travels as the bridge writes it: speed on x, influence as a fraction on y.
  assert.deepEqual(stream.keyframes[0].outTangent, { x: 12, y: 0.4 });
  assert.deepEqual(stream.keyframes[1].inTangent, { x: 8, y: 0.75 });
  assert.deepEqual(stream.keyframes[0].spatialOut, [5, 6]);
  assert.deepEqual(stream.keyframes[1].spatialIn, [-5, -6]);
  // The static value is still the layer's position; the keyframes are the animation over it.
  assert.deepEqual(composition.layers[0].position, [0, 0]);
});

test("a one-dimensional property decodes its scalar keyframes and hold interpolation", () => {
  const bytesIn = project(
    tdmn("ADBE Transform Group"),
    list(
      "tdgp",
      property(
        "ADBE Opacity",
        tdb4({ dimensions: 1, animated: true }),
        chunk("cdat", f64(100, 0, 0, 0, 0)),
        keyframeList(4, [
          scalarKey({ seconds: 0, value: 0, outInterpolation: 3 }),
          scalarKey({ seconds: 1, value: 100, inInterpolation: 1, outInterpolation: 1, label: 4 })
        ])
      ),
      tdmn("ADBE Group End")
    ),
    tdmn("ADBE Group End")
  );

  const [composition] = parseAepToManifest(bytesIn, "synthetic", "synthetic.aep").compositions;
  const layer = composition.layers[0];
  const stream = layer.streams.find((candidate) => candidate.property === "opacity");

  assert.equal(layer.opacity, 100, "the static value comes from cdat");
  assert.ok(stream);
  assert.deepEqual(stream.keyframes.map((key) => [key.time, key.value]), [[0, 0], [1, 100]]);
  assert.equal(stream.keyframes[0].interpolation, "hold");
  assert.equal(stream.keyframes[1].label, 4);
});

test("an expression is carried unevaluated rather than being dropped or sampled", () => {
  const bytesIn = project(
    tdmn("ADBE Transform Group"),
    list(
      "tdgp",
      property("ADBE Opacity", tdb4({ dimensions: 1 }), chunk("cdat", f64(50)), chunk("Utf8", ascii("wiggle(2, 30)"))),
      tdmn("ADBE Group End")
    ),
    tdmn("ADBE Group End")
  );

  const [composition] = parseAepToManifest(bytesIn, "synthetic", "synthetic.aep").compositions;
  const stream = composition.layers[0].streams.find((candidate) => candidate.property === "opacity");

  assert.equal(stream.expression, "wiggle(2, 30)");
  assert.equal(stream.expressionSampled, false, "GrapiX has no expression engine; nothing was sampled");
  assert.deepEqual(stream.keyframes, []);
});

test("a mask reads its mode, inversion and bezier path out of mkif and shph", () => {
  // A square, normalised into a 0..100 bounding box: the reader denormalises to layer pixels.
  const points = concat([
    concat([f32(0), f32(0)]), concat([f32(0), f32(0)]), concat([f32(0), f32(0)]),
    concat([f32(1), f32(0)]), concat([f32(1), f32(0)]), concat([f32(1), f32(0)]),
    concat([f32(1), f32(1)]), concat([f32(1), f32(1)]), concat([f32(1), f32(1)])
  ]);
  const shapeHeader = bytes(20);
  const shapeView = new DataView(shapeHeader.buffer);
  shapeView.setFloat32(4, 0, false); // top-left x
  shapeView.setFloat32(8, 0, false); // top-left y
  shapeView.setFloat32(12, 100, false); // bottom-right x
  shapeView.setFloat32(16, 100, false); // bottom-right y

  const shapePoints = bytes(32);
  const pointsView = new DataView(shapePoints.buffer);
  pointsView.setUint16(10, 9, false); // nine control points
  pointsView.setUint16(18, 8, false); // eight bytes each
  shapePoints[23] = 4;

  const bytesIn = project(
    tdmn("ADBE Mask Parade"),
    list(
      "tdgp",
      tdmn("ADBE Mask Atom"),
      // The switches sit beside the property group: inverted, locked, then the mode.
      chunk("mkif", concat([new Uint8Array([1, 0]), bytes(4), u16(2)])),
      list(
        "tdgp",
        chunk("tdsn", chunk("Utf8", ascii("Vignette"))),
        tdmn("ADBE Mask Shape"),
        list(
          "om-s",
          list("tdbs", chunk("tdsb", u32(1)), tdb4({ dimensions: 1 })),
          list("omks", list("shap", chunk("shph", shapeHeader), list("list", chunk("lhd3", shapePoints), chunk("ldat", points))))
        ),
        property("ADBE Mask Opacity", tdb4({ dimensions: 1 }), chunk("cdat", f64(75))),
        property("ADBE Mask Feather", tdb4({ dimensions: 2 }), chunk("cdat", f64(12, 34))),
        property("ADBE Mask Offset", tdb4({ dimensions: 1 }), chunk("cdat", f64(3))),
        tdmn("ADBE Group End")
      ),
      tdmn("ADBE Group End")
    ),
    tdmn("ADBE Group End")
  );

  const [composition] = parseAepToManifest(bytesIn, "synthetic", "synthetic.aep").compositions;
  const [mask] = composition.layers[0].masks;

  assert.ok(mask, "the mask parade must yield a mask");
  assert.equal(mask.name, "Vignette");
  assert.equal(mask.mode, "subtract");
  assert.equal(mask.inverted, true);
  assert.equal(mask.opacity, 75);
  assert.deepEqual(mask.feather, { x: 12, y: 34 });
  assert.equal(mask.expansion, 3);
  assert.equal(mask.path.closed, true);
  assert.deepEqual(mask.path.vertices, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
  assert.deepEqual(mask.path.outTangents[0], { x: 0, y: 0 }, "tangents are stored relative to their vertex");
});

test("a chunk that runs past its container degrades to a warning instead of throwing", () => {
  const item = list(
    "Item",
    chunk("idta", concat([u16(4), bytes(14), u32(1), bytes(64)])),
    chunk("Utf8", ascii("Comp")),
    cdta()
  );
  const truncated = concat([ascii("Egg!"), list("Fold", item), ascii("junk"), u32(0xffff)]);
  const manifest = parseAepToManifest(concat([ascii("RIFX"), u32(truncated.length), truncated]), "x", "x.aep");

  assert.equal(manifest.compositions.length, 1, "everything readable before the break is kept");
  assert.ok(
    manifest.warnings.some((warning) => warning.includes("ended early")),
    `expected a truncation warning, got ${JSON.stringify(manifest.warnings)}`
  );
});
