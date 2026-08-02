# Design File Import

GrapiX imports Photoshop, Illustrator-compatible, SVG, and Figma designs through
one normalized document pipeline:

```text
source → format adapter → normalized design document → GrapiX scenes/assets
       → compatibility validation → import report
```

The normalized document is format-neutral and contains pages, artboards, nested
nodes, editable text, paths, paints, masks, effects, reusable components, assets,
fonts, guides, layout metadata, and source-specific metadata. Format adapters do
not mutate the selected source file.

## Entry points

- `POST /api/import/design-file` accepts a binary PSD, AI/PDF, SVG, or exported
  Figma JSON file. `fileName` and serialized import options are query parameters.
- `POST /api/import/figma` accepts a Figma Dev Mode/design link and optional node
  IDs. The project service connects to the official Figma Desktop MCP server on
  loopback; no personal access token enters GrapiX.
- The editor exposes the workflow at **File → Import Design File…** and
  **Project → Import PSD, AI or Figma…**.

The dialog first analyzes the design, shows its pages/artboards and layer tree,
then lets the user choose which scenes and layers to apply. Applying an import is
one scene-history transaction. Additional selected artboards are stored as
templates.

## Format behavior

### Photoshop

PSD layers are parsed with `ag-psd`. Groups, artboards, text, shape/vector data,
pixel data, masks, clipping metadata, blend state, guides, smart-object links,
adjustments, alpha-mask data, and layer effects are retained. Extracted raster
data is encoded as PNG and stored through the existing GrapiX asset system.

A **bitmap** layer mask keeps its alpha channel as a stored asset, referenced by
`ObjectMask.alphaAssetId`. Neither renderer samples mask alpha yet, so the mask is
authored with `mode: "none"` and the layer renders unmasked: the only path
available is the layer's own bounding box, and clipping to that would hide or
reveal the whole layer rather than its masked shape. **Status: Partial** - the
data round-trips, the shape does not render.

A Photoshop **clipping mask** (a layer clipped to the one below it) becomes a mask
bound to the base layer's *bounds*, because clipping to its alpha needs mask-alpha
sampling. That is exact for a rectangular or shape base and an approximation for a
text base, and every instance is reported. **Status: Partial.**

Blend modes resolve through `blendModes.ts` to the six modes both renderers
implement. Photoshop's contrast family (overlay, soft/hard/vivid/linear/pin light,
hard mix) approximates to `screen`; the component family (hue, saturation, color,
luminosity, difference, exclusion, divide, subtract) has no approximation and stays
`normal`. Each substitution is reported. An importer may never author `overlay`,
`subtract` or the alpha-mask modes: they are declared in the contract and rendered
by nothing.

Layer geometry imports as position plus size with the pivot at the object origin.
Photoshop's `referencePoint` is a document-space free-transform reference, not a
pivot, and is preserved as source metadata only.

### Illustrator

SVG-compatible AI data is converted into editable text, paths, groups, symbols,
gradients, strokes, and clipping masks. PDF-compatible AI files are imported per
page with a reference raster and extracted editable text. For full editable
vector fidelity, save/export the Illustrator document with SVG-compatible data.

### Figma

The file-upload adapter accepts exported REST-compatible Figma JSON and converts
pages, frames, groups, components, instances, vectors, text, image fills, masks,
paints, effects, constraints, layout grids, auto-layout parameters, variables,
and component metadata into editable GrapiX objects.

A Figma **link** imports through one of two transports, chosen by
`FigmaDesignImportSource.transport` (`auto` by default):

**`rest` — native document JSON, editable layers.** The file key and node IDs are
parsed out of the link, so any flavour works as copied: `/design`, legacy `/file`,
`/proto`, `/board`, a `/branch/<key>` link (the branch is addressed as its own
file), a bare file key, and `?node-id=1-2` in URL form including instance ids
(`I1-2;3-4`). GrapiX then calls
`GET /v1/files/{key}/nodes?ids=…&geometry=paths` (or the whole file when the link
names no node) and `GET /v1/files/{key}/images` to resolve `imageRef` fills, and
feeds the result through the same adapter as an exported document. Requires a
personal access token with the `file_content:read` scope, or an OAuth bearer; the
token is supplied per request or read from `FIGMA_ACCESS_TOKEN`/`FIGMA_TOKEN` in
the project service environment, and is never written to the project, the scene, or
the report. REST failures are reported as the thing to change: 401 invalid token,
403 missing scope or no file access, 404 wrong key/branch, 429 rate limit.

**`desktop-mcp` — no token, rasterized.** Uses the official Figma Desktop MCP
server (`http://127.0.0.1:3845/mcp`) with `get_metadata` and `get_screenshot`. The
server exposes sparse XML and a rendered screenshot only, so each node becomes a
scene-sized image and the report records the raster fallback. This is a limitation
of the MCP surface, not of the importer.

`auto` picks REST when a token is available and Desktop MCP otherwise. Asking for
`rest` with no token fails with that explanation rather than silently rasterizing.

#### Figma coordinates

Figma reports `absoluteBoundingBox` in **page** space, so a frame can sit at
y = 4875 on a busy page. Both Figma routes normalize against the imported root:

- the selected root frame is the scene origin, at `x: 0, y: 0`;
- the canvas is that frame's own `width` × `height` — a page coordinate never
  contributes to a dimension (a frame at y = 4875 with height 1080 gives a 1080-high
  scene, not 5955);
- every other node is expressed relative to the root:
  `localX = node.absoluteX - root.absoluteX`, applied at each level of nesting;
- importing a whole page, where no single frame was selected, uses the top-left
  corner of the root frames' common bounds as the origin and their extent as the
  canvas;
- the frame's page position is retained as source metadata
  (`sourceData.pagePosition` on the MCP route) and is never used for layout.

#### Assets an import puts on air

The render engine registers assets by SHA-256 and refuses a scene carrying one
without a checksum, so an import emits the checksum and byte size of everything it
stored:

- extracted rasters, masks and image fills are stored and carry `checksum`;
- an asset that could not be stored — a remote link kept by `assetMode: "link"`, or a
  Figma `imageRef` that neither the file's image map nor a node render could resolve —
  is `MISSING` with no checksum, and is reported. Playout skips it, so the rest of the
  scene still reaches air with that texture absent;
- the authoring source document (the PSD/AI/Figma JSON) stays in the project store but
  is **not** a scene asset: it is referenced by
  `dataContext.__designImport.sourceAssetIds`. Shipping a 93 MB PSD to the renderer
  costs a full upload per take and renders nothing.

## Fallback and reporting

Each import returns a structured report listing imported items, converted
properties, missing fonts/assets, unsupported effects, rasterized objects,
visual differences, errors, and warnings.

The compatibility order is:

1. exact editable GrapiX feature;
2. closest editable feature;
3. preserved nested/source metadata;
4. affected-layer raster fallback;
5. never flatten the full document implicitly.

Imported effect and responsive-layout parameters remain editable in the Scene
Inspector. The compatibility report explicitly marks effects whose current
canvas/native renderer output is not yet equivalent to the source application.
PDF-compatible Illustrator appearance is similarly reported when a reference
raster is required.

The report describes the scene that was produced, not the source file:

- an effect switched **off** in the source application is round-tripped on the
  object but never reported, because a disabled effect owes no pixels;
- issues raised for layers that selection, the hidden-layer filter, or hierarchy
  flattening then removed are pruned, so nothing points at a layer that is not in
  the scene;
- a missing font is reported only when imported text still references its family.

## Tests

Fixture coverage lives in `Editor/services/project-api/tests/design-import.test.mjs` and
includes PSD, SVG-compatible AI, SVG, and exported Figma JSON. The tests cover
nested layers, editable text, vector geometry, extracted images, masks,
clipping, gradients/alpha stops, effects, components, missing fonts, option
filtering, scene serialization, and structural visual fingerprints.
