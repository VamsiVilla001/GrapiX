# 11.65 Engine preview in the Editor: first build (18 Nov 2026)

Design reviewed by Jev and Laya (text only): `jev-laya-design.json`. Route: a closed `preview` request on the asset plane (Jev 0.96, Laya agreed);
cadence: latest only (0.76, agreed); stale frames labelled out of date (0.98; Laya preferred blank, not taken).

- `pv-1.png`: the Preview panel in the running Editor: `ENGINE  Current  589 ms`, the rectangle drawn by the engine.
- `pv-5-engine-shadow.png`: after applying Lower-third shadow and making it large and orange in Effect Controls: the engine draws the soft shadow
  beside the rectangle, which the Draft viewport cannot draw (it says "1 object(s) not drawn in the Draft view (see the Engine preview)").
- The first run showed a broken image: the CSP allowed only `'self'` and `data:` images, so the engine frame's `blob:` URL was blocked; fixed in
  `Editor/shell/tauri.conf.json`.

Timing: 0.6 to 1.0 s per frame on the debug engine against the row's 250 ms. **Not met and not measured**: a release build on the reference machine with the
method recorded is still owed.
