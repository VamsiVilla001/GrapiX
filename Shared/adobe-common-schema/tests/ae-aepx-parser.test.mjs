import assert from "node:assert/strict";
import test from "node:test";
import { parseAepxToManifest } from "../dist/ae/aepxParser.js";

/**
 * AEPX direct import, the no-After-Effects path.
 *
 * These pin the contract the converter and report rely on: composition geometry and rate,
 * a text layer's typography, an animated transform's keyframes and bezier tangents, a mask's
 * mode resolved from PF_MaskMode, an effect's match name preserved, and an expression kept
 * with its sampled flag. The fixture is a hand-written AEPX in the PropertyList shape AE
 * writes; the parser reads by key, so a missing subtree degrades to a warning rather than a
 * thrown parse.
 */

const FIXTURE = `<?xml version="1.0"?>
<Project>
  <ItemList>
    <Item>
      <type>Composition</type>
      <name>Main Comp</name>
      <id>comp-1</id>
      <width>1920</width>
      <height>1080</height>
      <frameRate>25</frameRate>
      <duration>8</duration>
      <bgColor><red>0.1</red><green>0.2</green><blue>0.3</blue></bgColor>
      <workAreaStart>0</workAreaStart>
      <workAreaDuration>8</workAreaDuration>
      <displayStartTime>0</displayStartTime>
      <LayerList>
        <Layer>
          <name>Title</name>
          <objectType>3</objectType>
          <flags>1</flags>
          <inPoint>0</inPoint><outPoint>8</outPoint><startTime>0</startTime>
          <stretch>1</stretch>
          <blendingMode>normal</blendingMode>
          <Text>
            <text>Championship Final</text>
            <font>Inter</font>
            <fontStyle>Bold</fontStyle>
            <fontSize>72</fontSize>
            <fillColor><red>1</red><green>1</green><blue>1</blue></fillColor>
            <justification>center</justification>
            <tracking>20</tracking>
            <leading>80</leading>
          </Text>
          <StreamList>
            <Stream>
              <stream>position</stream>
              <KeyframeList>
                <Keyframe><time>0</time><value><v>960</v><v>540</v></value><interpolation>bezier</interpolation>
                  <outTangent><x>0.5</x><y>0</y></outTangent></Keyframe>
                <Keyframe><time>2</time><value><v>960</v><v>200</v></value><interpolation>linear</interpolation></Keyframe>
              </KeyframeList>
            </Stream>
            <Stream>
              <stream>opacity</stream>
              <expression>wiggle(2, 50)</expression>
              <KeyframeList>
                <Keyframe><time>0</time><value>100</value><interpolation>linear</interpolation></Keyframe>
                <Keyframe><time>1</time><value>80</value><interpolation>linear</interpolation></Keyframe>
              </KeyframeList>
            </Stream>
          </StreamList>
        </Layer>
        <Layer>
          <name>Background</name>
          <objectType>0</objectType>
          <flags>1</flags>
          <blendingMode>normal</blendingMode>
          <sourceItemId>asset-1</sourceItemId>
          <MaskList>
            <Mask>
              <name>Vignette</name>
              <mode>2</mode>
              <inverted>true</inverted>
              <opacity>75</opacity>
              <feather><x>40</x><y>40</y></feather>
              <expansion>-5</expansion>
            </Mask>
          </MaskList>
          <EffectList>
            <Effect>
              <name>Gaussian Blur</name>
              <matchName>ADBE Gaussian Blur 2</matchName>
              <enabled>true</enabled>
              <ParameterList>
                <Parameter><name>Blurriness</name><value>25</value></Parameter>
              </ParameterList>
            </Effect>
          </EffectList>
        </Layer>
      </LayerList>
    </Item>
    <Item>
      <type>Footage</type>
      <name>bg.mov</name>
      <id>asset-1</id>
      <filePath>/footage/bg.mov</filePath>
    </Item>
  </ItemList>
</Project>`;

test("an AEPX parses into a manifest with composition geometry and rate", () => {
  const manifest = parseAepxToManifest(FIXTURE, "TournamentGraphics", "/projects/TournamentGraphics.aepx");
  assert.equal(manifest.producer, "aepx-direct");
  assert.equal(manifest.compositions.length, 1);
  const comp = manifest.compositions[0];
  assert.equal(comp.name, "Main Comp");
  assert.equal(comp.width, 1920);
  assert.equal(comp.height, 1080);
  assert.equal(comp.frameRate, 25);
  assert.equal(comp.duration, 8);
  assert.equal(comp.backgroundColor, "#1a334d");
});

test("a text layer keeps its typography", () => {
  const manifest = parseAepxToManifest(FIXTURE, "P", "/p.aepx");
  const text = manifest.compositions[0].layers.find((layer) => layer.type === "text");
  assert.ok(text?.text);
  assert.equal(text.text.content, "Championship Final");
  assert.equal(text.text.fontFamily, "Inter");
  assert.equal(text.text.fontStyle, "Bold");
  assert.equal(text.text.fontSize, 72);
  assert.equal(text.text.align, "center");
  assert.equal(text.text.tracking, 20);
  // The font is reported for missing-font detection.
  assert.ok(manifest.fonts.some((font) => font.family === "Inter"));
});

test("an animated transform carries keyframes and bezier tangents", () => {
  const manifest = parseAepxToManifest(FIXTURE, "P", "/p.aepx");
  const text = manifest.compositions[0].layers.find((layer) => layer.type === "text");
  const position = text.streams.find((stream) => stream.property === "position");
  assert.ok(position);
  assert.equal(position.keyframes.length, 2);
  assert.deepEqual(position.keyframes[0].value, [960, 540]);
  assert.equal(position.keyframes[0].interpolation, "bezier");
  assert.deepEqual(position.keyframes[0].outTangent, { x: 0.5, y: 0 });
});

test("an expression is preserved with its sampled flag, never dropped", () => {
  const manifest = parseAepxToManifest(FIXTURE, "P", "/p.aepx");
  const text = manifest.compositions[0].layers.find((layer) => layer.type === "text");
  const opacity = text.streams.find((stream) => stream.property === "opacity");
  assert.equal(opacity.expression, "wiggle(2, 50)");
  assert.equal(opacity.expressionSampled, true, "sampled keyframes accompany the source");
});

test("a mask resolves its PF_MaskMode and an effect keeps its match name", () => {
  const manifest = parseAepxToManifest(FIXTURE, "P", "/p.aepx");
  const bg = manifest.compositions[0].layers.find((layer) => layer.name === "Background");
  assert.equal(bg.masks[0].mode, "subtract");
  assert.equal(bg.masks[0].inverted, true);
  assert.equal(bg.effects[0].matchName, "ADBE Gaussian Blur 2");
  assert.equal(bg.effects[0].status, "baked");
});

test("footage becomes an asset ref with its source path", () => {
  const manifest = parseAepxToManifest(FIXTURE, "P", "/p.aepx");
  const footage = manifest.assets.find((asset) => asset.name === "bg.mov");
  assert.equal(footage.sourcePath, "/footage/bg.mov");
  assert.equal(footage.mediaType, "video");
  assert.equal(footage.missing, false);
});

test("a malformed document yields a manifest with a warning, not a throw", () => {
  const manifest = parseAepxToManifest("<not xml", "P", "/p.aepx");
  assert.equal(manifest.compositions.length, 0);
  assert.ok(manifest.warnings.length > 0);
});
