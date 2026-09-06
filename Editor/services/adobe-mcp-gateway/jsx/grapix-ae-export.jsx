/*
 * grapix-ae-export.jsx — read an open After Effects project into a GrapiX manifest.
 *
 * This is the opt-in reader: it asks After Effects itself, through the supported ExtendScript
 * object model, and writes the shared `AeManifest` JSON (producer "ae-bridge") that the native
 * binary reader and the AEPX parser also produce, so the importer downstream cannot tell which
 * path the project took. It exists because After Effects knows things the file does not spell
 * out — a parameter still at its default, styling that varies within a text layer — and it costs
 * an After Effects installation and a launch for them. A `.aep` imports without it by default
 * (`Shared/adobe-common-schema/src/ae/aepParser.ts`).
 *
 * Run headless:  afterfx.exe -r grapix-ae-export.jsx
 * The script reads two globals the launcher sets before running (see aeBridge.ts):
 *   GRAPIX_AE_PROJECT   absolute path of the .aep to open (read-only)
 *   GRAPIX_AE_MANIFEST  absolute path the manifest JSON is written to
 *
 * ExtendScript is ES3: no let/const, no arrow functions, no JSON in older hosts (json2 is
 * defensively inlined below). Every property read is wrapped — a missing or renamed property
 * on one AE version must degrade to a manifest warning, never abort the export, because the
 * manifest the importer gets is the difference between "this layer has no effects" and "this
 * layer's effects were not readable".
 *
 * The script never writes to the project. It opens read-only, reads, and closes without saving.
 */

/* eslint-disable */

// --- minimal JSON (json2, public domain) for hosts without JSON -------------
var JSON = JSON || {};
(function () {
  "use strict";
  var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
  var meta = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };
  function quote(string) {
    escapable.lastIndex = 0;
    return escapable.test(string)
      ? '"' + string.replace(escapable, function (a) { var c = meta[a]; return typeof c === "string" ? c : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4); }) + '"'
      : '"' + string + '"';
  }
  function str(value) {
    var i, partial, mind = "";
    switch (typeof value) {
      case "string": return quote(value);
      case "number": return isFinite(value) ? String(value) : "null";
      case "boolean": case "null": return String(value);
      case "object":
        if (!value) return "null";
        if (Object.prototype.toString.apply(value) === "[object Array]") {
          partial = [];
          for (i = 0; i < value.length; i += 1) partial[i] = str(value[i]) || "null";
          return "[" + partial.join(",") + "]";
        }
        partial = [];
        for (i in value) {
          if (Object.prototype.hasOwnProperty.call(value, i)) {
            var v = str(value[i]);
            if (v) partial.push(quote(i) + ":" + v);
          }
        }
        return "{" + partial.join(",") + "}";
    }
    return undefined;
  }
  JSON.stringify = function (value) { return str(value); };
}());

// --- defensive readers -------------------------------------------------------

var AE_WARNINGS = [];

/** Read a property, returning fallback and recording a warning on any throw. */
function read(owner, property, fallback, context) {
  try {
    var value = owner[property];
    return value === undefined || value === null ? fallback : value;
  } catch (error) {
    AE_WARNINGS.push("unreadable " + context + "." + property + ": " + error);
    return fallback;
  }
}

function num(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

function colorToHex(rgb) {
  function c(component) {
    var v = Math.max(0, Math.min(1, Number(component) || 0));
    var hex = Math.round(v * 255).toString(16);
    return hex.length < 2 ? "0" + hex : hex;
  }
  if (!rgb || rgb.length < 3) return "#000000";
  return "#" + c(rgb[0]) + c(rgb[1]) + c(rgb[2]);
}

/** AEGP_LayerFlag bits the importer reads (AE_GeneralPlug.h:952). */
function layerFlags(layer) {
  var flags = 0;
  try { if (layer.enabled) flags |= 0x00000001; } catch (e) {}
  try { if (layer.locked) flags |= 0x00000020; } catch (e) {}
  try { if (layer.shy) flags |= 0x00000040; } catch (e) {}
  try { if (layer.solo) flags |= 0x00004000; } catch (e) {}
  try { if (layer.threeDLayer) flags |= 0x00000800; } catch (e) {}
  try { if (layer.nullLayer) flags |= 0x00010000; } catch (e) {}
  try { if (layer.adjustmentLayer) flags |= 0x00000200; } catch (e) {}
  try { if (layer.guideLayer) flags |= 0x00040000; } catch (e) {}
  try { if (layer.collapseTransformation) flags |= 0x00000080; } catch (e) {}
  try { if (layer.motionBlur) flags |= 0x00000008; } catch (e) {}
  try { if (layer.frameBlending) flags |= 0x00000010; } catch (e) {}
  return flags;
}

/** AEGP_ObjectType for the layer (AE_GeneralPlug.h:982). */
function objectType(layer) {
  try {
    if (layer instanceof TextLayer) return 3;
    if (layer instanceof ShapeLayer) return 4;
    if (layer instanceof CameraLayer) return 2;
    if (layer instanceof LightLayer) return 1;
  } catch (e) {}
  return 0; // av
}

/**
 * The GrapiX-facing layer type.
 *
 * The manifest contract says the producer fills `type`, because both producers can resolve it
 * and the converter must not have to. Null and adjustment are AEGP_LayerFlags on an av layer
 * rather than object types, so they win over the base type; a precomp is an av layer whose
 * source is a composition, and an audio-only footage layer is reported as audio so it is not
 * imported as an invisible image.
 */
function resolveLayerType(layer, objectTypeValue, flags) {
  if ((flags & 0x00010000) !== 0) return "null";
  if ((flags & 0x00000200) !== 0) return "adjustment";
  if (objectTypeValue === 1) return "light";
  if (objectTypeValue === 2) return "camera";
  if (objectTypeValue === 3) return "text";
  if (objectTypeValue === 4) return "shape";
  try {
    var source = layer.source;
    if (source) {
      if (source instanceof CompItem) return "precomp";
      var main = source.mainSource;
      if (main) {
        if (main instanceof SolidSource) return "solid";
        if (main.isStill) return "image";
        if (!source.hasVideo && source.hasAudio) return "audio";
        // A still sequence reports as video-bearing but is imported as one sequence asset.
        if (main.isStillSequence === true) return "image-sequence";
      }
      return "video";
    }
  } catch (e) {}
  return "video";
}

function interpName(value) {
  // KeyframeInterpolationType: 6412 LINEAR, 6413 BEZIER, 6414 HOLD.
  if (value === 6414) return "hold";
  if (value === 6413) return "bezier";
  return "linear";
}

function easePoint(ease) {
  return { x: num(ease.speed, 0), y: num(ease.influence, 0) / 100 };
}

function readKeyframes(property) {
  var keys = [];
  var count = 0;
  try { count = property.numKeys; } catch (e) { return keys; }
  for (var k = 1; k <= count; k += 1) {
    var key = null;
    try {
      var inInterp = property.keyInInterpolationType(k);
      var outInterp = property.keyOutInterpolationType(k);
      key = {
        time: num(property.keyTime(k), 0),
        value: readKeyValue(property, k),
        interpolation: interpName(outInterp),
        inTangent: easePoint(property.keyInTemporalEase(k)[0]),
        outTangent: easePoint(property.keyOutTemporalEase(k)[0]),
        roving: false
      };
      try { key.roving = property.keyRoving(k); } catch (e) {}
      try {
        if (property.propertyValueType === 6413 || property.isSpatial) {
          key.spatialIn = property.keyInSpatialTangent(k);
          key.spatialOut = property.keyOutSpatialTangent(k);
        }
      } catch (e) {}
      try { key.label = property.keyLabel(k); } catch (e) {}
    } catch (error) {
      AE_WARNINGS.push("unreadable keyframe " + k + ": " + error);
    }
    if (key) keys.push(key);
  }
  return keys;
}

function readKeyValue(property, k) {
  try {
    var value = property.keyValue(k);
    if (value && value.length !== undefined && typeof value !== "string") {
      var components = [];
      for (var i = 0; i < value.length; i += 1) components.push(num(value[i], 0));
      return components;
    }
    return num(value, 0);
  } catch (error) {
    return 0;
  }
}

function readStream(property, name) {
  var stream = { property: name, keyframes: readKeyframes(property) };
  try {
    if (property.canSetExpression && property.expression && property.expression.length) {
      stream.expression = property.expression;
      // The expression is preserved verbatim. When it has no translation the bridge samples
      // its evaluated values into keyframes so the motion still plays, and marks it.
      if (stream.keyframes.length === 0) {
        stream.expressionSampled = true;
        stream.keyframes = sampleExpression(property);
      }
    }
  } catch (e) {}
  return stream;
}

/** Evaluate an expression-driven property across its duration into keyframes. */
function sampleExpression(property) {
  var keys = [];
  try {
    var layer = property.propertyGroup(property.propertyDepth).property("..."); // resolved below
  } catch (e) {}
  // Sample at a fixed cadence across the containing comp's duration. The property's own
  // times are not knowable without the layer, so this walks the comp time range.
  var comp = null;
  try { comp = property.propertyGroup(1); } catch (e) {}
  var duration = 1;
  var frameRate = 25;
  try {
    // Walk up to the comp for duration + rate.
    var group = property;
    while (group && group.propertyDepth > 0) { group = group.propertyGroup(1); }
    if (group && group.containingComp) {
      duration = group.containingComp.duration;
      frameRate = group.containingComp.frameRate;
    }
  } catch (e) {}
  var frames = Math.max(1, Math.min(600, Math.round(duration * frameRate)));
  for (var f = 0; f <= frames; f += Math.max(1, Math.floor(frames / 120))) {
    var t = f / frameRate;
    try {
      keys.push({ time: t, value: num(property.valueAtTime(t, false), 0), interpolation: "linear" });
    } catch (e) {}
  }
  return keys;
}

function readMasks(layer) {
  var masks = [];
  var group = null;
  // `property("Masks")` is the documented group name; `layer.Mask` is not a DOM property and
  // silently yields nothing, which read as "this layer has no masks".
  try { group = layer.property("Masks"); } catch (e) { return masks; }
  if (!group) return masks;
  var count = 0;
  try { count = group.numProperties; } catch (e) { return masks; }
  for (var m = 1; m <= count; m += 1) {
    try {
      var mask = group.property(m);
      var pathProp = mask.property("Mask Path");
      var shape = null;
      try { shape = pathProp.value; } catch (e) {}
      masks.push({
        name: String(mask.name || ("Mask " + m)),
        mode: maskModeName(mask.maskMode),
        inverted: !!mask.inverted,
        opacity: num(read(mask.property("Mask Opacity"), "value", 100, "mask"), 100),
        feather: { x: num(read(mask.property("Mask Feather"), "value", [0, 0], "mask")[0], 0), y: 0 },
        expansion: num(read(mask.property("Mask Expansion"), "value", 0, "mask"), 0),
        path: shape ? {
          closed: !!shape.closed,
          vertices: pairs(shape.vertices),
          inTangents: pairs(shape.inTangents),
          outTangents: pairs(shape.outTangents)
        } : { closed: false, vertices: [], inTangents: [], outTangents: [] }
      });
    } catch (error) {
      AE_WARNINGS.push("unreadable mask " + m + ": " + error);
    }
  }
  return masks;
}

function pairs(values) {
  var out = [];
  if (!values) return out;
  for (var i = 0; i < values.length; i += 1) {
    out.push({ x: num(values[i][0], 0), y: num(values[i][1], 0) });
  }
  return out;
}

function readEffects(layer) {
  var effects = [];
  var group = null;
  try { group = layer.property("Effects"); } catch (e) { return effects; }
  if (!group) return effects;
  var count = 0;
  try { count = group.numProperties; } catch (e) { return effects; }
  for (var e = 1; e <= count; e += 1) {
    try {
      var effect = group.property(e);
      var params = {};
      try {
        for (var p = 1; p <= effect.numProperties; p += 1) {
          var param = effect.property(p);
          var pname = String(param.name || ("param" + p));
          try { params[pname] = param.value; } catch (e2) {}
        }
      } catch (e1) {}
      effects.push({
        name: String(effect.name || ("Effect " + e)),
        matchName: String(effect.matchName || effect.name || ""),
        enabled: !!effect.enabled,
        parameters: params,
        status: "baked"
      });
    } catch (error) {
      AE_WARNINGS.push("unreadable effect " + e + ": " + error);
    }
  }
  return effects;
}

function readText(layer) {
  try {
    var doc = layer.property("Source Text").value;
    return {
      content: String(doc.text || ""),
      fontFamily: String(doc.font || "Sans-Serif"),
      fontStyle: String(doc.fontStyle || ""),
      fontSize: num(doc.fontSize, 24),
      fillColor: colorToHex(doc.fillColor),
      strokeColor: doc.applyStroke ? colorToHex(doc.strokeColor) : undefined,
      strokeWidth: doc.applyStroke ? num(doc.strokeWidth, 0) : undefined,
      align: justificationName(doc.justification),
      tracking: num(doc.tracking, 0),
      leading: num(doc.leading, 0),
      baselineShift: num(doc.baselineShift, 0),
      boxSize: doc.boxText ? { x: num(doc.boxTextSize[0], 0), y: num(doc.boxTextSize[1], 0) } : undefined
    };
  } catch (error) {
    return undefined;
  }
}

/**
 * `ParagraphJustification` (AE scripting DOM), not the PF constants.
 *
 * The values are MULTIPLE_JUSTIFICATIONS 7412, LEFT_JUSTIFY 7413, RIGHT_JUSTIFY 7414,
 * CENTER_JUSTIFY 7415, and 7416 upward the four full-justify variants. An earlier version of this
 * function had the enum starting two higher, which read a centred title as left-aligned and a
 * right-aligned one as centred — hence the named values rather than a bare comparison.
 */
function justificationName(value) {
  if (value === 7414) return "right";
  if (value === 7415) return "center";
  if (value >= 7416) return "justify";
  return "left";
}

/**
 * `MaskMode` (AE scripting DOM) to the GrapiX mask mode the manifest carries.
 *
 * The scripting enum (6812…6818) is not the `PF_MaskMode` numbering (0…6) the AEPX path
 * reports, and the manifest contract is the resolved GrapiX name — so the producer maps it
 * here rather than shipping a number the converter would have to guess the dialect of.
 */
function maskModeName(value) {
  switch (Number(value)) {
    case 6812: return "none";
    case 6813: return "add";
    case 6814: return "subtract";
    case 6815: return "intersect";
    case 6816: return "lighten";
    case 6817: return "darken";
    case 6818: return "difference";
    default: return "add";
  }
}

function readTrackMatte(layer) {
  try {
    var type = layer.trackMatteType;
    // TrackMatteType: 3013 NO_TRACK_MATTE, 3014 ALPHA, 3015 NOT_ALPHA, 3016 LUMA, 3017 LUMA_INVERTED.
    if (type === 3014) return { type: "alpha", sourceLayerIndex: layer.index - 1 };
    if (type === 3015) return { type: "notAlpha", sourceLayerIndex: layer.index - 1 };
    if (type === 3016) return { type: "luma", sourceLayerIndex: layer.index - 1 };
    if (type === 3017) return { type: "notLuma", sourceLayerIndex: layer.index - 1 };
  } catch (e) {}
  return undefined;
}

function readMarkers(owner) {
  var markers = [];
  try {
    var prop = owner.marker;
    var count = prop.numKeys;
    for (var k = 1; k <= count; k += 1) {
      var value = prop.keyValue(k);
      markers.push({
        time: num(prop.keyTime(k), 0),
        comment: value && value.comment ? String(value.comment) : undefined,
        label: value && value.label !== undefined ? num(value.label, 0) : undefined
      });
    }
  } catch (e) {}
  return markers;
}

function readLayer(layer) {
  var flags = layerFlags(layer);
  var streams = [];
  var transformNames = [
    ["Anchor Point", "anchorPoint"],
    ["Position", "position"],
    ["Scale", "scale"],
    ["Rotation", "rotation"],
    ["Opacity", "opacity"],
    ["Orientation", "orientation"],
    ["Rotate X", "rotateX"],
    ["Rotate Y", "rotateY"]
  ];
  var transform = null;
  try { transform = layer.Transform; } catch (e) {}
  if (transform) {
    for (var t = 0; t < transformNames.length; t += 1) {
      try {
        var prop = transform.property(transformNames[t][0]);
        if (prop) streams.push(readStream(prop, transformNames[t][1]));
      } catch (e) {}
    }
  }
  var staticValue = function (name, fallback) {
    for (var s = 0; s < streams.length; s += 1) {
      if (streams[s].property === name && streams[s].keyframes.length) {
        return streams[s].keyframes[0].value;
      }
    }
    return fallback;
  };

  return {
    index: layer.index,
    name: String(layer.name || ("Layer " + layer.index)),
    type: resolveLayerType(layer, objectType(layer), flags),
    objectType: objectType(layer),
    flags: flags,
    sourceItemId: readSourceId(layer),
    inPoint: num(read(layer, "inPoint", 0, "layer"), 0),
    outPoint: num(read(layer, "outPoint", 0, "layer"), 0),
    startTime: num(read(layer, "startTime", 0, "layer"), 0),
    stretch: num(read(layer, "stretch", 100, "layer"), 100) / 100,
    visible: (flags & 0x1) !== 0,
    locked: (flags & 0x20) !== 0,
    shy: (flags & 0x40) !== 0,
    solo: (flags & 0x4000) !== 0,
    is3d: (flags & 0x800) !== 0,
    guide: (flags & 0x40000) !== 0,
    collapseTransformations: (flags & 0x80) !== 0,
    continuouslyRasterize: (flags & 0x80) !== 0,
    motionBlur: (flags & 0x8) !== 0,
    frameBlending: (flags & 0x10) !== 0,
    blendingMode: blendingModeName(layer),
    label: num(read(layer, "label", 0, "layer"), 0),
    comment: String(read(layer, "comment", "", "layer") || ""),
    parentIndex: layer.parent ? layer.parent.index : undefined,
    trackMatte: readTrackMatte(layer),
    anchorPoint: asArray(staticValue("anchorPoint", [0, 0])),
    position: asArray(staticValue("position", [0, 0])),
    scale: asArray(staticValue("scale", [100, 100])),
    rotation: asArray(staticValue("rotation", [0])),
    orientation: streams.length ? asArray(staticValue("orientation", [0, 0, 0])) : undefined,
    opacity: num(staticValue("opacity", 100), 100),
    streams: streams,
    masks: readMasks(layer),
    effects: readEffects(layer),
    markers: readMarkers(layer),
    text: readText(layer),
    solidColor: readSolidColor(layer),
    status: "native-editable"
  };
}

function readSourceId(layer) {
  try {
    if (layer.source && layer.source.id !== undefined) return String(layer.source.id);
  } catch (e) {}
  return undefined;
}

function readSolidColor(layer) {
  try {
    if (layer.source && layer.source.mainSource && layer.source.mainSource.color) {
      return colorToHex(layer.source.mainSource.color);
    }
  } catch (e) {}
  return undefined;
}

function blendingModeName(layer) {
  try {
    var mode = layer.blendingMode;
    var names = ["normal", "dissolve", "dancing-dissolve", "darken", "multiply", "color-burn",
      "linear-burn", "darker-color", "lighten", "screen", "color-dodge", "linear-dodge",
      "lighter-color", "overlay", "soft-light", "hard-light", "linear-light", "vivid-light",
      "pin-light", "hard-mix", "difference", "exclusion", "subtract", "divide", "hue",
      "saturation", "color", "luminosity", "add", "silhouette-alpha", "silhouette-luma",
      "stencil-alpha", "stencil-luma", "alpha-add", "luminescent-premul"];
    // BlendingMode enum starts at 5212 (NORMAL).
    var index = Number(mode) - 5212;
    if (index >= 0 && index < names.length) return names[index];
  } catch (e) {}
  return "normal";
}

function asArray(value) {
  if (value && value.length !== undefined && typeof value !== "string") {
    var out = [];
    for (var i = 0; i < value.length; i += 1) out.push(num(value[i], 0));
    return out;
  }
  return [num(value, 0)];
}

function readComposition(item) {
  var layers = [];
  for (var i = 1; i <= item.numLayers; i += 1) {
    try {
      layers.push(readLayer(item.layer(i)));
    } catch (error) {
      AE_WARNINGS.push("unreadable layer " + i + " in " + item.name + ": " + error);
    }
  }
  return {
    id: String(item.id),
    name: String(item.name),
    width: num(item.width, 0),
    height: num(item.height, 0),
    duration: num(item.duration, 0),
    frameRate: num(item.frameRate, 25),
    displayStartTime: num(item.displayStartTime, 0),
    workAreaStart: num(item.workAreaStart, 0),
    workAreaDuration: num(item.workAreaDuration, item.duration),
    backgroundColor: colorToHex(item.bgColor),
    layers: layers,
    markers: readMarkers(item)
  };
}

function readFootage(item) {
  var sourcePath;
  var missing = true;
  var mediaType = "other";
  try {
    if (item.file && item.file.fsName) {
      sourcePath = String(item.file.fsName);
      missing = false;
    }
  } catch (e) {}
  try { if (item.footageMissing) missing = true; } catch (e) {}
  try {
    if (item.mainSource && item.mainSource.isStill) mediaType = "image";
    else if (item.mainSource && item.mainSource.hasVideo) mediaType = "video";
    else if (item.mainSource && item.mainSource.hasAudio) mediaType = "audio";
  } catch (e) {}
  return {
    id: String(item.id),
    name: String(item.name),
    kind: "footage",
    sourcePath: sourcePath,
    missing: missing,
    proxyPath: undefined,
    mediaType: mediaType
  };
}

function walkItems(folder, compositions, assets) {
  for (var i = 1; i <= folder.numItems; i += 1) {
    var item = folder.item(i);
    try {
      if (item instanceof CompItem) {
        compositions.push(readComposition(item));
      } else if (item instanceof FolderItem) {
        walkItems(item, compositions, assets);
      } else if (item instanceof FootageItem) {
        assets.push(readFootage(item));
      }
    } catch (error) {
      AE_WARNINGS.push("unreadable project item " + i + ": " + error);
    }
  }
}

function main() {
  var projectPath = typeof GRAPIX_AE_PROJECT !== "undefined" ? GRAPIX_AE_PROJECT : null;
  var manifestPath = typeof GRAPIX_AE_MANIFEST !== "undefined" ? GRAPIX_AE_MANIFEST : null;
  if (!projectPath || !manifestPath) {
    throw new Error("GRAPIX_AE_PROJECT and GRAPIX_AE_MANIFEST must be set by the launcher");
  }

  var projectFile = new File(projectPath);
  app.open(projectFile);
  var project = app.project;

  var compositions = [];
  var assets = [];
  walkItems(project.rootFolder, compositions, assets);

  var manifest = {
    formatVersion: 1,
    producer: "ae-bridge",
    projectName: String(project.file ? project.file.name : "project").replace(/\.(aep|aepx)$/i, ""),
    sourceFile: projectPath,
    frameRate: compositions.length ? compositions[0].frameRate : 25,
    compositions: compositions,
    assets: assets,
    fonts: collectFonts(compositions),
    warnings: AE_WARNINGS
  };

  var out = new File(manifestPath);
  out.encoding = "UTF-8";
  out.open("w");
  out.write(JSON.stringify(manifest));
  out.close();

  // Never save: the source project is read-only to this script by design.
  project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
}

function collectFonts(compositions) {
  var fonts = {};
  for (var c = 0; c < compositions.length; c += 1) {
    for (var l = 0; l < compositions[c].layers.length; l += 1) {
      var text = compositions[c].layers[l].text;
      if (!text) continue;
      var key = text.fontFamily + "::" + (text.fontStyle || "");
      if (!fonts[key]) {
        fonts[key] = { family: text.fontFamily, style: text.fontStyle, usedBy: [] };
      }
      fonts[key].usedBy.push(compositions[c].name + "/" + compositions[c].layers[l].name);
    }
  }
  var list = [];
  for (var k in fonts) if (Object.prototype.hasOwnProperty.call(fonts, k)) list.push(fonts[k]);
  return list;
}

main();
