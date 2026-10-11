# gx-control-plane

protocol v3. Small, ordered, acknowledged, sequenced, **zero loss tolerance**.

The rule that shapes this package: it carries *intent, never time*
(invariant 8). `TakeRequest` says `NextOpportunity` or `Frame(n)`; the engine
answers with the frame it committed to. There is no message meaning "now", and
adding one would be an architecture change, not a feature.
