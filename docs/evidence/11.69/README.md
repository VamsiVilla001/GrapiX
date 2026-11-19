# 11.69 Effects & Presets and Effect Controls: first build (18 Nov 2026)

- `fx-1-browser.png`: the Effects & Presets panel in the running Editor, searching "glow": the Soft glow preset, VR Glow marked not ported,
  Glow usable; "16 of 306 effects render on the GrapiX engine".
- `fx-2-controls.png`: Effect Controls after applying Glow to a rectangle: on/off, up, down, duplicate, remove, typed parameters and Key.
- `fx-2-log.png`: the Activity log: "Applied Glow to rect", and the draft viewport saying it does not draw the object.

Checked by hand in the running Editor: radius set to 40; 5000 refused with "Radius must be between 0 and 1000" and the field returned to 40; Key
added a key and an `Effects.glow.radius` track appeared in the timeline.

Mutations (one at a time, restored byte-identical): F1 to F14; 13 failed a named test; F10 (sharing the template instead of copying it) changes no
behaviour because every write copies, so it is an equivalent mutant.

**Gap found:** the draft viewport does not draw an object with effects (by design: effects run in the engine), so effects cannot be seen in the
Editor until the engine preview monitor (11.65).
