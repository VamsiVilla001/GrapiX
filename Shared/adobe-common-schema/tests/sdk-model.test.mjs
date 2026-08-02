import { test } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_BLEND_MODES, IMPLEMENTED_MASK_MODES } from "@grapix/shared-types";

import {
  AE_KEY_INTERP,
  AE_KEY_INTERP_TO_EASING,
  AE_LAYER_FLAG,
  AE_LAYER_STREAM,
  AE_MASK_MODE,
  AE_MASK_MODE_TO_GRAPIX,
  AE_OBJECT_TYPE,
  AE_STREAM_COMPONENTS,
  AE_STREAM_TO_GRAPIX_PROPERTIES,
  AE_STREAM_TYPE,
  PS_LAYER_TYPE_FIDELITY,
  PS_LAYER_TYPE_TO_GRAPIX,
  readAeLayerFlags,
  resolvePhotoshopBlendMode
} from "../dist/index.js";

test("AE stream indices match the SDK header, because a bridge sends the raw index", () => {
  // AE_GeneralPlug.h:1266. Adobe appends to this list rather than reordering it, so these
  // indices are the wire contract: shifting one animates the wrong property.
  assert.equal(AE_LAYER_STREAM.anchorPoint, 0);
  assert.equal(AE_LAYER_STREAM.position, 1);
  assert.equal(AE_LAYER_STREAM.scale, 2);
  assert.equal(AE_LAYER_STREAM.rotation, 3);
  assert.equal(AE_LAYER_STREAM.opacity, 4);
  assert.equal(AE_LAYER_STREAM.rotateX, 8);
  assert.equal(AE_LAYER_STREAM.rotateY, 9);
});

test("AE aliases ROTATION and ROTATE_Z to one index, and so do we", () => {
  // AE_GeneralPlug.h:1271 — `AEGP_LayerStream_ROTATE_Z = AEGP_LayerStream_ROTATION`.
  // Treating them as two streams would double-key Z rotation on every 3D layer.
  assert.equal(AE_LAYER_STREAM.rotateZ, AE_LAYER_STREAM.rotation);
});

test("a multi-component AE stream expands into the GrapiX channels it drives", () => {
  // AE animates position as one 2D/3D stream; GrapiX animates x, y and zDepth separately.
  assert.deepEqual(AE_STREAM_TO_GRAPIX_PROPERTIES[AE_LAYER_STREAM.position], ["x", "y", "zDepth"]);
  assert.deepEqual(AE_STREAM_TO_GRAPIX_PROPERTIES[AE_LAYER_STREAM.scale], ["scaleX", "scaleY", "scaleZ"]);
  assert.deepEqual(AE_STREAM_TO_GRAPIX_PROPERTIES[AE_LAYER_STREAM.opacity], ["opacity"]);
  assert.deepEqual(AE_STREAM_TO_GRAPIX_PROPERTIES[AE_LAYER_STREAM.rotation], ["rotationZ"]);
});

test("stream component counts follow AEGP_StreamType, so no axis is silently dropped", () => {
  // AE_GeneralPlug.h:1438. Reading a ThreeD_SPATIAL position as a scalar loses Y and Z.
  assert.equal(AE_STREAM_COMPONENTS[AE_STREAM_TYPE.threeDSpatial], 3);
  assert.equal(AE_STREAM_COMPONENTS[AE_STREAM_TYPE.twoD], 2);
  assert.equal(AE_STREAM_COMPONENTS[AE_STREAM_TYPE.oneD], 1);
  assert.equal(AE_STREAM_COMPONENTS[AE_STREAM_TYPE.color], 4);
  assert.equal(AE_STREAM_COMPONENTS[AE_STREAM_TYPE.noData], 0);
});

test("every AE keyframe interpolation maps to an easing GrapiX understands", () => {
  // AE_GeneralPlug.h:1390.
  assert.equal(AE_KEY_INTERP.linear, 1);
  assert.equal(AE_KEY_INTERP.bezier, 2);
  assert.equal(AE_KEY_INTERP.hold, 3);
  for (const value of Object.values(AE_KEY_INTERP)) {
    assert.ok(AE_KEY_INTERP_TO_EASING[value], `interp ${value} has no easing`);
  }
  assert.equal(AE_KEY_INTERP_TO_EASING[AE_KEY_INTERP.hold], "hold");
});

test("every AE mask mode reachable from the UI has an exact GrapiX equivalent", () => {
  // AE_Effect.h:1917. PF_NUM_USER_MASKMODES excludes ACCUM, which AE's UI cannot produce.
  for (const [name, value] of Object.entries(AE_MASK_MODE)) {
    if (name === "accum") continue;
    const mapped = AE_MASK_MODE_TO_GRAPIX[value];
    assert.ok(mapped, `PF_MaskMode ${name} (${value}) is unmapped`);
    assert.ok(IMPLEMENTED_MASK_MODES.includes(mapped), `${mapped} is not implemented by the renderers`);
  }
});

test("PF_MaskMode_ACCUM is deliberately unmapped rather than aliased to add", () => {
  // It is a real add rather than a screen and is not exposed in AE's UI. Mapping it to
  // `add` would render a different composite than AE and never say so.
  assert.equal(AE_MASK_MODE_TO_GRAPIX[AE_MASK_MODE.accum], undefined);
});

test("layer flags are read bitwise, and guide layers stay distinct from hidden ones", () => {
  // AE_GeneralPlug.h:952. A guide layer is visible in the comp and excluded from render.
  const guide = readAeLayerFlags(AE_LAYER_FLAG.videoActive | AE_LAYER_FLAG.guideLayer);
  assert.equal(guide.visible, true);
  assert.equal(guide.isGuide, true);

  const hidden = readAeLayerFlags(AE_LAYER_FLAG.locked);
  assert.equal(hidden.visible, false);
  assert.equal(hidden.locked, true);
  assert.equal(hidden.isGuide, false);

  const solo3d = readAeLayerFlags(AE_LAYER_FLAG.videoActive | AE_LAYER_FLAG.solo | AE_LAYER_FLAG.layerIs3d);
  assert.equal(solo3d.solo, true);
  assert.equal(solo3d.is3d, true);
  assert.equal(solo3d.isNull, false);
});

test("AE object types cover the layer kinds a composition can contain", () => {
  // AE_GeneralPlug.h:982.
  assert.equal(AE_OBJECT_TYPE.av, 0);
  assert.equal(AE_OBJECT_TYPE.light, 1);
  assert.equal(AE_OBJECT_TYPE.camera, 2);
  assert.equal(AE_OBJECT_TYPE.text, 3);
  assert.equal(AE_OBJECT_TYPE.vector, 4);
});

test("every Photoshop layer type maps to a GrapiX kind and declares its fidelity", () => {
  for (const psType of Object.keys(PS_LAYER_TYPE_TO_GRAPIX)) {
    assert.ok(PS_LAYER_TYPE_FIDELITY[psType], `${psType} declares no fidelity`);
  }
  assert.equal(PS_LAYER_TYPE_FIDELITY.textLayer, "Native");
  assert.equal(PS_LAYER_TYPE_FIDELITY.smartObject, "Converted");
  assert.equal(PS_LAYER_TYPE_FIDELITY.adjustmentLayer, "Rasterised");
});

test("a resolved Photoshop blend mode is always one both renderers implement", () => {
  for (const mode of ["normal", "multiply", "screen", "darken", "lighten", "linearDodge", "colorBurn", "hardMix"]) {
    const resolved = resolvePhotoshopBlendMode(mode);
    assert.ok(
      IMPLEMENTED_BLEND_MODES.includes(resolved.mode),
      `${mode} resolved to ${resolved.mode}, which is not implemented in both renderers`
    );
  }
});

test("only exact blend equivalences are Native; the rest carry a warning", () => {
  assert.deepEqual(resolvePhotoshopBlendMode("multiply"), { mode: "multiply", status: "Native" });
  assert.deepEqual(resolvePhotoshopBlendMode("linearDodge"), { mode: "add", status: "Native" });

  const overlay = resolvePhotoshopBlendMode("overlay");
  assert.equal(overlay.mode, "normal");
  assert.equal(overlay.status, "Converted");
  assert.match(overlay.warning, /no GrapiX equivalent/);

  const nonsense = resolvePhotoshopBlendMode("notABlendMode");
  assert.equal(nonsense.status, "Unsupported");
  assert.match(nonsense.warning, /not a Photoshop blend mode/);
});
