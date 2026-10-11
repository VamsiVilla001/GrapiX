# gx-media-plane

Preview and Program confidence frames, back to both UIs.

**High loss tolerance — drop, never queue** (invariant 13). Two consumers with
different needs: an Editor viewport is interactive and degrades resolution
before latency; a confidence monitor is observational and stays bounded.
Encoding is negotiated from locality tier and consumer role (ADR-004).

No media path may influence Program cadence (invariant 14).
