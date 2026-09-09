# Template Factory — one-pager

**A constrained generation loop that turns a design system plus a template
list into published, playout-ready broadcast graphics — drafts now,
finished templates by class over time.**

Status: exploration. Nothing committed. Written 9 September 2026.

---

## The job to be done

> When a tournament is three days out and I have a brand pack and a list of
> forty templates, I want them built, animated and in the Playout library
> without assigning a designer to each one, so I can spend my designers on
> the ten that actually define the show.

Not "AI designs graphics." The job is **volume under deadline, without
brand drift.**

Esports is the wedge: high template count, repetitive structure,
data-driven content (rosters, scores, brackets, player stats), tight
turnaround, and a brand pack per tournament that gets thrown away
afterwards. The waste is obvious and recurring.

---

## Why this is ours to build

Three things have to be in one product for this to work, and they already
are:

| | Why it matters |
|---|---|
| **The generator** | MCP server with ten tool groups — scenes, objects, materials, assets, publish, rundowns. The agent API predates the idea. |
| **The renderer** | We can render a generated scene and hand the frame *back* to the model. Nobody working through a design tool's API can close that loop. |
| **The publish step** | Immutable versioned packages with stable Take IDs. We can diff what was generated against what went to air. |

The third one is the real asset. See "What the draft phase actually
produces" below.

---

## What it does

1. Ingest a design system — Claude Design, Figma, or a brand pack — as
   **constraints**, not inspiration: type scale, palette, spacing, safe
   margins, logo rules.
2. Ingest a template list and reference material for the tournament.
3. For each template: assemble a scene through existing tools, bind data
   fields, apply motion from a curated preset library.
4. **Render, look, critique, iterate** — the visual feedback loop.
5. Validate: design-system diff, motion preset validity, data-binding
   completeness, refusal-clean render.
6. Publish to Playout as a draft version with a Take ID. Designer
   finishes. Ship.
7. **Capture the diff** between generated and shipped.

---

## Four design decisions that carry the idea

**Motion comes from a library, not from the model.** LLMs are weakest
exactly where broadcast motion lives — timing, easing, anticipation,
overshoot. A designer authors 10–15 presets (lower-third wipe-on, stat
card build, bracket reveal, score flip); the model picks and parameterises
duration, direction and stagger. This reframes the product from "AI
animates" to "AI assembles from a motion vocabulary," which is how a
junior designer works anyway.

**The refusal contract is the guardrail.** Unsupported blend mode or fit
mode returns an explicit named refusal rather than a silent substitution.
The agent sees the error and retries. Most systems would approximate and
the agent would never learn it was wrong.

**The model can see its own output.** Generated scene → rendered frame →
critique → revision. This is the differentiator, and it exists only
because we own the renderer.

**Graduation by class, not one quality bar.** "Finished" arrives per
template class, on evidence.

| Class | Character | Graduates |
|---|---|---|
| Score bug, clock, timer | One right answer | First |
| Stat / player / roster cards | Rigid, data-driven | Early |
| Lower thirds | Structured but brand-expressive | Middle |
| Bracket, standings | Complex layout, deterministic | Middle |
| Hero opens, stings, transitions | Taste-heavy, brand-defining | Possibly never |

**Implication: start with the boring templates.** A score bug is
unglamorous and graduates first. A tournament open demos beautifully and
never graduates. Most teams build the demo.

---

## The metric

**Zero-edit publish rate, per template class, per tournament.**

Percentage of published templates in class X that shipped with no designer
edits. When it crosses threshold for a class, that class moves to
auto-publish. Everything else stays draft.

This replaces "does it look good" with something reportable.

---

## What the draft phase actually produces

Not drafts. **A correction corpus.**

Every diff between a generated draft and the template that went to air is
a labelled correction: this easing was wrong, this hierarchy was wrong,
this spacing broke the system, this stagger felt cheap.

Capture those from day one and in two years there is a dataset nobody else
can assemble, because nobody else owns generator, renderer and publish
together. A design tool sees edits but not what aired. A model vendor sees
neither.

Skip this, and we arrive at the finished-template ambition with nothing
but a hope that the next model is better at overshoot.

---

## Opportunity solution tree

```
OUTCOME — 40 templates published in 3 days, zero brand drift,
          designers spend their time on the 10 that matter

├── OPP 1  Template volume exceeds designer capacity at deadline
│   ├── SOL  Batch generation from a template list
│   │   └── EXP  Generate 10 templates from a past tournament brief;
│   │            time it against what that tournament actually cost
│   └── SOL  Class-based auto-publish for deterministic templates
│       └── EXP  Score bug only, one tournament, measure zero-edit rate
│
├── OPP 2  Brand drift when many hands build one pack
│   ├── SOL  Design system as machine-checked constraints
│   │   └── EXP  Diff generated output against the system; count violations
│   └── SOL  Refusal on constraint violation, not approximation
│       └── EXP  Reuse the existing scene validator; add system rules
│
├── OPP 3  Generated animation reads as cheap
│   ├── SOL  Curated motion preset library, parameterised
│   │   └── EXP  Blind A/B — 5 preset-assembled vs 5 designer-authored,
│   │            judged by someone who built neither
│   └── SOL  Visual critique loop over rendered frames
│       └── EXP  Does a critique pass measurably improve blind ranking?
│
└── OPP 4  Designers won't adopt someone else's 80%
    ├── SOL  Draft lands as an editable scene, not a flattened asset
    │   └── EXP  Designer fixes a generated draft; ask directly whether
    │            it was faster than starting fresh
    └── SOL  Capture edits as corrections that visibly improve output
        └── EXP  Show a designer their own corrections changing the
                 next batch — does that change willingness to engage?
```

---

## Assumptions, riskiest first

| # | Assumption | Confidence | Cheapest test |
|---|---|---|---|
| 1 | Designers will fix drafts rather than start over | **Low** | Ask, after they fix one. If no, this is a workflow problem no model fixes. |
| 2 | Preset-assembled motion is broadcast-acceptable | **Low** | Blind A/B against designer-authored motion |
| 3 | A design system can be expressed as checkable constraints | Medium | Encode one real brand pack; count what can't be expressed |
| 4 | Visual critique measurably improves output | Medium | With-loop vs without-loop, blind ranking |
| 5 | The correction corpus is usable signal, not noise | Medium | 50 diffs in — are the corrections clustered or scattered? |
| 6 | Volume under deadline is the pain worth paying for | Medium-high | Direct conversation with anyone who has run a tournament pack |

Assumptions 1 and 2 both kill the idea. Test them first and together —
they're two halves of one week's work.

---

## Scope

**In:** design system ingest, template list batching, scene assembly via
existing tools, motion preset library, visual critique loop, validation
gates, publish as draft with Take ID, correction capture.

**Out for now:** live output certification (existing external gate),
video and clip content (no decoder tier), auto-publish for any class
before it has graduated on evidence, generating motion presets themselves,
non-esports verticals.

**Explicitly parked:** the AE runtime path — unresolved licensing makes it
the wrong foundation for a new product surface.

---

## Open questions

- Who signs off when a class auto-publishes? "Finished" is an
  accountability transfer, not a quality threshold, and it needs a named
  owner before it's a product.
- Positioning: first-draft assistant or template factory? Designers will
  hate one framing and tolerate the other.
- Does this ship as a GrapiX feature, or is it a separate product that
  consumes GrapiX's agent API? The second keeps the renderer roadmap clean.
- Which model, and does inference cost matter at 40 templates with a
  critique loop per template?

---

## Next step

**Run the reproduction test.** Take an esports template pack already
shipped. Give the loop the same brief and the same design system. Then:

1. Someone who built neither picks which is which, and says what's wrong
   with the generated set.
2. A designer fixes one generated draft and states whether that was faster
   than starting fresh.

About a week. It tests the two riskiest assumptions at once, and it costs
nothing but time already-shipped work has paid for.
