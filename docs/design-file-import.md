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
- `POST /api/import/figma` accepts a Figma file URL/key, personal access token,
  optional node IDs, and import options.
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

### Illustrator

SVG-compatible AI data is converted into editable text, paths, groups, symbols,
gradients, strokes, and clipping masks. PDF-compatible AI files are imported per
page with a reference raster and extracted editable text. For full editable
vector fidelity, save/export the Illustrator document with SVG-compatible data.

### Figma

The adapter accepts exported REST-compatible JSON or obtains file/node data and
image URLs from the Figma API. Pages, frames, groups, components, instances,
vectors, text, image fills, masks, paints, effects, constraints, layout grids,
auto-layout parameters, variables, and component metadata are retained.

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

## Tests

Fixture coverage lives in `Editor/services/project-api/tests/design-import.test.mjs` and
includes PSD, SVG-compatible AI, SVG, and exported Figma JSON. The tests cover
nested layers, editable text, vector geometry, extracted images, masks,
clipping, gradients/alpha stops, effects, components, missing fonts, option
filtering, scene serialization, and structural visual fingerprints.
