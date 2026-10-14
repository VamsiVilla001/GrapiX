# Reference mappings that the software renderer refuses

`unsupported-mappings-50.json` preserves the authored reference scene from
the schema-2 renderer, including all fixed-function blend and image-fit modes,
mesh content and packaged text. Those mappings previously produced placeholder
pixels or no pixels. Step 3.13 now refuses them by object name.

The pixel-gate tests retain this scene in the coverage inventory and execute
its named refusal. It is outside the renderable capture directory so an
unsupported mapping cannot be turned into a new golden image. Existing PNG
baselines stay unchanged; `gx-pixel-gate check` still reports pixel differences
from corrected glyph drawing. GPU image/material/mesh work must supply actual
rendered coverage before the reference set can establish fidelity for them.
