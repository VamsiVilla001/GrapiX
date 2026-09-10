# Playout

One of the three applications. Tauri 2 shell, Windows.

Owns published scene operations and is the only client allowed to Cue, Take,
Continue, Clear Program or configure outputs (invariant 5).

Its control surface is **intent-based**: it asks for `NextOpportunity` or a
specific frame and displays the frame number the engine committed to. It must
show reference-lock state and device tier unmissably, and it must never imply
instantaneous control it does not have (ADR-002).

playout-control listens on 4300.
