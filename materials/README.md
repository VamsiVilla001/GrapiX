# Sample source assets

Small real image assets used to exercise the Material Manager import pipeline
(image validation, content-hashed storage, alpha detection, textured
materials). They are intentionally simple and generic.

| File | What it is | Alpha |
| --- | --- | --- |
| `frame.png` | Red rectangular border / frame overlay | yes (transparent interior) |
| `Mask.png` | Black rectangles on transparent — a matte / mask shape | yes |

Import them from the Material Manager (Import button, or drag-and-drop). They
are copied into the project's content-hashed asset store under `data/assets/`
(which is gitignored); these originals stay here as the source of truth.
