# Transition logic: research notes for GrapiX

Date: 24 Nov 2026. Status: research notes, not a decision. Input: `docs/design/grapix-screens-spec.md`
(decisions of 24 Nov 2026, second half).

Already decided and not repeated here: three modes (out then in, overlap with a signed offset, cut);
cut if the old scene has no exit motion; layers -99,999 to +99,999, default 0, higher in front; a take on
an occupied layer replaces it; the engine works in whole frames, preloads, swaps on one frame boundary
and reports the committed frame; "depends on what came before" is deferred. Open in the spec: set per
layer, per take, or both (section 4 proposes an answer).

Labels used below: **[documented]** = stated by the cited source; **[unverified]** = not found in
the source, or only seen in a search snippet; **[established]** = common engineering practice;
**[proposal]** = GrapiX idea, not found in any product.

---

## 1. What existing products document

Pages were read on 24 Nov 2026 unless marked otherwise. Several vendor pages are short; where a
question is not answered by the page it says so rather than guessing.

### 1.1 Ross XPression Transition Logic

- Introduced in XPression 6.0 **[documented]** (Ross University, "Transition Logic workflows ... introduced in
  XPression 6.0", found via search: https://www.rossvideo.com/resources/ross-university/xpression-transition-logic/).
- What the overview page says: the designer uses **Scene Directors** to build separate animations for
  different playout situations; animations can be set for graphics from the **same scene** played back to
  back and for graphics from **different scenes** played back to back; a rules-based workflow decides the
  effect in advance so the result is predictable
  (https://www.rossvideo.com/resources/ross-university/xpression-transition-logic/).
- The tutorial page "Getting started with Transition Logic on XPression" names Scene Directors, Animation
  Controllers, Default Frame Markers, Preview Frames, animating scenes in or out of the frame buffer, and
  back-to-back transitions, but the page is only a video landing page and explains none of them
  (http://www.rossvideo.com/resources/ross-university/getting-started-with-transition-logic-on-xpression/).
- Not documented on the pages read: the state model, who plays out and who plays in, overlap
  and timing, occupied-layer behaviour, preload, interruption, squeeze/layout. All **[unverified]**.
  The video, the XPression manual and the 6.0 release notes
  (https://documentation.rossvideo.com/files/Release%20Notes/CG%20&%20Graphics%20Systems/XPression/XPression%20Release%20Notes.pdf)
  were not read in full; an owner who has XPression installed can answer these by test (see section 5.4).
- Take-away for GrapiX: XPression's idea is "one director per situation (same scene after same scene,
  scene A after scene B), chosen by rule", which is the deferred "depends on what came before" item. The
  per-pair table in section 6 is the same idea made explicit.

### 1.2 Vizrt Transition Logic (Viz Artist, Viz Pilot Edge)

Sources: https://docs.vizrt.com/viz-artist-guide/5.3/Transition_Logic.html,
https://docs.vizrt.com/viz-artist-guide/5.3/State_Transition_Animation.html,
https://docs.vizrt.com/viz-artist-guide/5.3/Cross_Animation.html,
https://docs.vizrt.com/viz-pilot-edge-guide/3.7/Transition_Logic.html.

- **Structure [documented]:** a master scene coordinates independently controlled objects; it usually holds
  background and design items. Object scenes hold the variable content (for example lower-third text). When an
  object scene goes on air the engine loads the master, places the object scene in it and plays the
  relevant timeline(s) automatically.
- **Layers [documented]:** a master has several layers that can be on air at the same time and are controlled
  independently; layers are conceptual, not spatial. Each layer can reference several object scenes, but only
  one is active per layer at any time. Several TL scenes can be on air at once (for example lower third plus
  over-the-shoulder); taking out one leaves the other.
- **Occupied layer:** the Artist page does not describe what happens when a second object scene is taken on a
  layer that already holds one **[unverified]**; Pilot Edge says the same and leaves the replacement
  implicit. The built-in logic is said to handle "transitions from one graphic to another on each layer",
  resolved at design time so the operator need not know how scenes affect each other.
- **States [documented]:** each toggle layer has a reserved state named `O` (upper case), which is where
  Take Out goes; at least one more (in) state; going from an in state back to O reuses the in animation
  in reverse unless a separate out animation is made by adding another O state; a state that moves to another in
  state (SMALL to LARGE) needs its own O state to animate out; all states must be connected to each other.
- **Transition lookup [documented]:** to go from state A to state B the engine searches the layer's director
  from left to right for A, then right of it for B; if no match it searches right to left. Minimum
  animations for n fully connected states: 2 states need 1, 3 need 3, 4 need 6, 5 need 10, 6 need 15 (that
  is n(n-1)/2, because each animation can run in reverse). This is the same combinatorial growth GrapiX
  will meet with a pair table (section 6.3).
- **Cross animation [documented]:** one object animates in while another animates out; the Toggle plug-in adds
  cross directors tagged AX and BX; default is a one-second cross-fade of alpha, adjustable. The page does not
  give overlap timing **[unverified]**.
- **Timing and overlap, preload, interruption:** no frame values, no preload description and no rule for a
  state change during a running transition on the pages read **[unverified]**.
- **Layout/squeeze:** the geometry and cross animations let a state change position/scale, but squeeze of
  video is a Viz Pilot/Multiplay topic not found in these pages **[unverified]**.
- **Pilot Edge / Template Builder / combo templates [documented, thin]:** TL is "code-free, design-based",
  a combo template is a TL template with more than one layer (example layers OTS and LOWER), playable from
  Viz Trio, Pilot, Multiplay and Channel Branding. The Pilot Edge page does not mention Template Builder
  and gives no timing.

### 1.3 Singular.live

- "Layer logic" assigns overlays to a named logic layer for smooth on-air transitions between overlays on the
  same layer; in the page's talk-show example the previous overlay animates out before the new one animates
  in, so the behaviour is **sequential (out then in)** **[documented]**
  (https://developer.singular.live/singular-basics/building-overlays-in-composer/how-to-set-up-layer-logic-to-automate-overlay-transitions).
- The same page warns that different layers can overlap on screen if their art spills into the same area:
  layout planning is the designer's job **[documented]**. Nothing about overlap within one layer, preload,
  interruption, or automatic layout adjustment **[unverified]**.
- In and Out animations are "Timeline Animations" made in the Property Panel
  (https://support.singular.live/hc/en-us/articles/360018552851-In-and-Out-Animations) **[documented, search
  snippet only]**.

### 1.4 CasparCG

Source: https://casparcg.com/docs/wiki/protocols/amcp-protocol.

- `LOADBG` preloads a clip into the channel-layer background with an optional transition
  (CUT, MIX, PUSH, WIPE, SLIDE), a duration and a tween; `PLAY` moves the background to the foreground and runs
  a prepared transition **[documented]**. This is the preload then take pattern GrapiX already uses.
- A clip counts as started after the transition ends; `AUTO` queues the background to start when the
  foreground clip ends, one per layer **[documented]**.
- A transition replaces whatever is in the foreground of that layer: the layer holds one foreground and one
  background **[documented by the command model]**. This is the closest match to "a take on an occupied layer
  replaces it" and has the same two-slot idea as the layer slot in section 3.6.
- Tween is a string, default `linear`, names listed on a separate Animation Types page; the page names
  `easeinsine` as an example. `MIXER FILL`, `CLIP` and `ANCHOR` accept a duration and tween; duration 0 applies
  at once; FILL sets position and scale relative to the anchor (0 to 1 within the layer) **[documented]**.
  A mixer move to a squeezed rectangle is therefore a FILL with x, y, x-scale, y-scale and a tween.
- STING appears only in an example (`PLAY 1-10 MY_FILE STING wipe_mask 0 wipe_overlay`); the parameters are not
  defined on the page **[unverified]**.
- The unit of the transition duration is not defined on the page (frame count in practice, **[unverified]**
  from this source); interruption (PLAY during a running transition) is not documented **[unverified]**.

### 1.5 Unreal Engine Motion Design (Avalanche) Transition Logic

- A Motion Design Transition Tree is a State Tree that runs user logic when scenes transition across layers;
  each tree handles one layer, set by a `TransitionLayer` property (API page:
  https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/AvalancheTransition/UAvaTransitionTree)
  **[documented]**.
- A newly created scene gets basic In/Out/Change logic pre-configured (Pixotope 25.3 help:
  https://help.pixotope.com/phc/25.3/create-a-template) **[documented, via Pixotope]**; Epic's community
  tutorials (5.5 and 5.7) cover fundamentals and a sub-layer approach for complex transitions
  (https://forums.unrealengine.com/t/2246021 and
  https://forums.unrealengine.com/t/community-tutorial-understanding-transition-logic-fundamentals-in-ue5-7/2693904);
  the forum text read is only an announcement with a video link, so the exact semantics (wait for out,
  overlap, interrupt) are **[unverified]**. A layer condition type exists in the API
  (`FAvaTransitionLayerCondition`); its comparison options were not readable **[unverified]**.
- Take-away: the transition is expressed as rules over the set of scenes running on a layer, which supports
  the "rules evaluated by the engine" approach of section 5.

### 1.6 Squeeze-back and L-bar

- An L-bar is a full-frame canvas with the video scaled to 80 percent in a corner and bars on two sides; one
  vendor template gives 1920x1080, video 1536x864 top-right, left bar 384 px wide, bottom bar 216 px high
  (https://static.frequency.com/studio/product/graphics-compositions-squeezeback.html) **[documented, search
  snippet]**. Note 80 percent of 1920x1080 is exactly 16:9, so uniform scale keeps the aspect.
- A streaming API switches between fullscreen and squeezeback by explicit coordinates or an L-bar preset, with
  optional transitions between layouts (https://docs.uplynk.com/changelog/squeezebacks-for-live-video)
  **[documented, snippet]**.
- Hardware DVE: a DVE that moves travels from its previous position to the new one and can be moved and resized
  like a graphic object (https://help.chyron.com/hc/en-us/articles/22779796121748-08-DVE-Editor-SDI-Workflow-Only);
  an automated system squeezes the previous show back when the next programme starts
  (https://www.nexttv.com/news/chyron-eases-transitions-cartoon-network-33235) **[documented, snippets]**.
- No source found gives a frame count or the frame-order of "graphic frame appears vs video squeezes"
  **[unverified]**. Practice (**[established]** in editing craft, not cited): the squeeze starts first or with
  the frame, the frame's bars slide in under the moving picture, and both end on the same frame; so a GrapiX
  squeeze should be one transition group with a shared clock (section 3.4).

### 1.7 Summary table

| Topic | XPression | Viz | Singular | CasparCG | Unreal |
|---|---|---|---|---|---|
| Rules chosen by situation | Scene Directors per same/different scene | state-to-state animations, O state | layer logic | per command | transition tree per layer |
| Same-layer take | not read | one active per layer; replace implied | out then in | foreground replaced, transition set at LOADBG | not read |
| Overlap | not read | cross animation (AX/BX) | not described | MIX/PUSH/WIPE/SLIDE | not read |
| Preload | not read | not read | not read | LOADBG | not read |
| Interrupt | not read | not read | not read | not read | not read |
| Layout change | not read | geometry animation | designer's layout | MIXER FILL | not read |

Nobody read documents interruption. GrapiX must define it itself (section 3.2).

---

## 2. Notation

- Frame rate `R = num/den` (50/1 here). Frame index `n` is an integer; time of frame `n` is `n*den/num` seconds,
  never a float accumulated by addition. All durations in the table are integers of frames.
- `C` = committed frame, the first frame that shows any effect of a command.
- `Dout`, `Din` = exit and entrance lengths in frames (a scene with no exit has `Dout = 0`).
- `O` = signed overlap offset in frames, measured from the **end of the old exit** to the start of the new
  entrance (so O = 0 is out then in, O < 0 starts the new one early, O > 0 leaves a gap).
- `E(u)` = easing, `u` in [0,1] to [0,1].

## 3. Math and logic

### 3.1 (a) Frame-exact scheduling

Take command received at engine time `now` (a frame boundary counter, `now_n`):

```
preroll   = max(P_min, ceil(preload_estimate_ms * R / 1000))        # P_min e.g. 3 frames at 50 fps
ready_by  = now_n + preroll
C         = max(next_boundary(now_n), ready_by, requested_frame_or_0)
```

The engine schedules, never the caller. Reply: `{take_id, committed_frame: C, mode_used, offsets}`. If the
scene is not ready at frame `C-1` (preload not finished): policy `late` is either `slip` (C += k until ready, report
the real C) or `fail` (reject, the old scene stays, report). Default proposal: `fail` for automatic cues,
`slip` for operator takes, always reported (this matches the 17 Nov rule never to coalesce late frames).

Schedule for an occupied layer with old scene `A` (held since frame `h`, exit length `Dout`) and new scene `B`:

```
mode = resolve_mode(table, A, B)                    # section 6
if mode == CUT or Dout == 0:
    A.remove_at = C
    B.in_start  = C ; B.in_end = C + Din_cut        # Din_cut = 0 means B appears at its held pose
if mode == OUT_THEN_IN:
    A.out_start = C ; A.out_end = C + Dout
    B.in_start  = A.out_end ; B.in_end = B.in_start + Din
if mode == OVERLAP:
    A.out_start = C ; A.out_end = C + Dout
    B.in_start  = max(C, A.out_end + O)             # clamp: new never starts before the take
    B.in_end    = B.in_start + Din
```

Invariants: `A.out_end >= A.out_start`; `B.in_start >= C`; `held_from = B.in_end`. Time from take to held
state is `max(Dout + O, 0) + Din` for overlap (O<0), `Dout + Din` for out then in, `Din_cut` for cut. Only
integer additions: the Editor and engine cannot disagree by rounding.

**Worked example, 50 fps.** Take arrives at frame 998, `P_min = 3`, so `C = 1001`. `Dout = 15` (0.30 s),
`Din = 20` (0.40 s).

| Mode | A out | B in | B held from | Both visible |
|---|---|---|---|---|
| out then in | 1001 to 1016 | 1016 to 1036 | 1036 | no |
| overlap O = -8 | 1001 to 1016 | 1008 to 1028 | 1028 | frames 1008 to 1015 (8) |
| overlap O = -15 | 1001 to 1016 | 1001 to 1021 | 1021 | frames 1001 to 1015 |
| overlap O = -40 (clamped) | 1001 to 1016 | 1001 to 1021 | 1021 | same as -15 (clamp to C) |
| overlap O = +5 (gap) | 1001 to 1016 | 1021 to 1041 | 1041 | no, 5 empty frames |
| cut, Din_cut = 0 | removed 1001 | held at 1001 | 1001 | no |

Frame at which the property value is sampled for scene `S` with phase start `s` and length `D`:
`u = clamp((n - s) / D, 0, 1)` using exact rational division in fixed point, `value = from + (to - from) * E(u)`.
Sample at `n`, not `n + 0.5`; the frame's displayed pose is the pose at its first instant (state this once and use
it everywhere, in Editor and engine).

Cut with no exit: rule already agreed. Also treat `Dout < 1` as cut. A scene with no entrance has `Din = 0`:
it appears at its held pose at `B.in_start`.

### 3.2 (b) Interrupts: a third scene arrives mid-transition

Layer state when `T_k` arrives at its committed frame `C2` while `A -> B` is running (A leaving, B entering, or
B alone entering). Every policy is a pure function of the frame number `C2` and the state, so it is
replayable. Policy is set per layer (default `replace_latest`) and may be overridden per take.

1. **Finish then replace** (`finish_then_replace`, safest for a visible rhythm). Hold `T_k` in a one-deep
   pending slot; when the running transition reaches held (B held), start `B -> T_k` per the table. If another
   take arrives while one is pending, it replaces the pending one (latest wins; the dropped take is logged with
   reason `superseded`). Cost: a delay up to `Dout + Din` frames; report to the caller `committed_frame` as the
   projected start and `status = queued`.
2. **Abort and jump** (`abort_jump`). At `C2` the running transition is cancelled by cut: any `leaving` instance
   is removed at `C2`; an `entering` instance is removed at `C2` (or jumps to held if `jump_to_end` is set, not
   advised). Then the new take runs mode `resolve_mode(table, B, T_k)` from a clean start, with `B` treated as
   held. Result visible: a pop. Use only for emergency or when stated by the show.
3. **Blend from current pose** (`blend`, proposal for a smooth result). Freeze each animated property's
   current value `p(C2)` and velocity `v(C2)` (finite difference of the exact function, or analytic). The
   interrupted instance that was entering at progress `u0 = (C2 - s)/D` is sent out by the reverse of its
   entrance from `u0`: length `D' = max(1, round(u0 * Dout_B))` (or `round(u0 * Din_B)` for a symmetric
   reverse), easing `E_out` evaluated from `u0`. Leaving instances keep their out animation untouched (no
   restart). The new scene `T_k` enters by the table mode, with `B` leaving as above. For spring tweens the
   new tween starts with `r0 = target - p` and `v0 = v(C2)` (formula in 3.3), so there is no velocity jump.

Fix-ups that all policies share:

- Never more than two live instances on a layer: if a third would exist (A still leaving, B entering, T_k
  arrives), the oldest leaving instance (A) is **removed (cut) at `C2`** and the event is logged
  `forced_cut`. This enforces the guarantee in 3.6.
- A take whose `scene == the scene currently held` on the layer is `retake`: policy `restart` (play its
  exit/enter as `A -> A` row of the table), or `ignore` (default for the same Take ID, answering `noop`).
- Takeout/clear arriving mid-transition: Take out of the layer = same as a take to the `Empty` scene with its own
  mode; Clear = immediate cut of all instances at `C2` (always allowed, never queued).

**Worked example (blend), 50 fps.** B entering from `s=1008`, `Din=20`, linear for clarity. Take `T` arrives, `C2=1018`:
`u0 = 10/20 = 0.5`; B's alpha 0.5. With `Dout_B = 12`: `D' = 6`; B's alpha goes 0.5 to 0 over frames 1018 to 1024
(slope `0.5/6` per frame, close to its entrance slope `1/20`: not identical; a clean variant uses `D' = round(u0*Din_B) = 10`
so the slopes match exactly: `0.5/10 = 1/20`). The two are the clean "run backward" choice; note it for the designer as the `reverse_in` option.

### 3.3 (c) Easing and timing

**Cubic Bezier (CSS style) [established].** Curve with end points (0,0) and (1,1) and control points
`P1=(x1,y1)`, `P2=(x2,y2)`, `x1,x2 in [0,1]`:

```
x(s) = 3(1-s)^2 s x1 + 3(1-s) s^2 x2 + s^3
y(s) = 3(1-s)^2 s y1 + 3(1-s) s^2 y2 + s^3
E(u) = y(s*) where x(s*) = u
```

Solve `x(s)=u`: Newton from `s=u` (at most 8 iterations, tolerance 1e-7), fall back to bisection on [0,1] if the
derivative is below 1e-6. Because `x` is monotonic when `x1,x2` are in [0,1], the solution is unique
(https://www.w3.org/TR/css-easing-1/). To be deterministic, use a fixed iteration count and one specified
rounding order. y may leave [0,1] to produce overshoot.

**Penner easings [established]** (https://easings.net, formulas from Robert Penner's work): with `u` in [0,1]:
`quad_in = u^2`; `cubic_in = u^3`; `quart_in = u^4`; `sine_in = 1 - cos(u*pi/2)`; `expo_in = (u==0) ? 0 : 2^(10(u-1))`;
`back_in = c3 u^3 - c1 u^2` with `c1 = 1.70158`, `c3 = c1 + 1`; `ease_out(u) = 1 - ease_in(1 - u)`;
`in_out(u) = u<0.5 ? in(2u)/2 : 1 - in(2(1-u))/2` (symmetric form, matching 3.3 below). Bounce and elastic
exist and are not recommended for lower thirds.

**Critically damped spring [established physics].** Value moves from the start to a target; remaining distance
`r(t)` with natural frequency `w`, damping ratio 1:

```
r(t) = (r0 + (v0 + w r0) t) e^(-w t)       # v0 = initial velocity of r (negative = toward target)
```

Settling time to 2 percent for `v0 = 0`: `(1 + u)e^(-u) = 0.02` gives `u = 5.83`, so `w = 5.83 / T_settle`.
Example: `T_settle = 20 frames = 0.40 s` gives `w = 14.6 rad/s`. Evaluate analytically at `t = (n - s)*den/num` (not by
stepping) so a dropped frame cannot change the result. A spring never reaches 0: define the **end frame** as
the first frame with `|r| < 0.5 pixel` (or `0.001` for unit values) and then snap, so `Din` is finite and the
table can store it.

**Making out and in curves complementary.**

- Time-mirror: entrance easing `E_in` and exit `E_out` satisfy `E_out(u) = 1 - E_in(1 - u)` so the exit is the
  entrance played backwards. For a cubic bezier `(x1,y1,x2,y2)` the mirror is `(1-x2, 1-y2, 1-x1, 1-y1)`.
- Cross-fade during overlap: use weights `a_out(u) + a_in(u) = 1` (same curve, mirrored) for opaque-over-
  background looks; equal-power `a_out = cos(u pi/2)`, `a_in = sin(u pi/2)` hides a brightness dip when both are
  partly transparent over video (**[established]** audio/video crossfade practice). Pick per scene pair:
  `fade_law = linear | equal_power`.
- Motion in and out: decelerate on entering (ease out) and accelerate on leaving (ease in); a pair in the table
  that uses the same direction for both gives a continuous "conveyor" feel.

**Duration choice for overlap (rules of thumb, [established] craft practice, tune by test).**
`D = round(R * seconds)`. Typical: lower third in 0.4 s to 0.6 s (20 to 30 frames at 50), out 0.3 s to 0.4 s
(15 to 20); an exit faster than the entrance reads as clean. Overlap offset: start the new entrance when the old
one has left the region the new one needs. Search form (proposal, section 5.2):
`O* = - max { k >= 0 : collision(A_out at frame i, B_in at frame i + Dout - k) is false for all i }`; this picks
the earliest start that never shows a collision, expressed as a frame count, and `O` is then capped at
`-0.5 * min(Dout, Din)` unless the designer widens it.

### 3.4 (d) Layout re-arrangement and squeeze-back

**FLIP (First, Last, Invert, Play) [established]**
(https://aerotwist.com/blog/flip-your-animations/). Record the first rect, change to the final layout, record
the last rect, apply the inverse transform so the element still looks as it did, then animate the transform to
identity. In GrapiX the layout is solved off-line (not by a DOM), so the idea is used as: for each affected
node with rects `F = (xF, yF, wF, hF)` and `L = (xL, yL, wL, hL)`, create a tween on the **rectangle**, not on separate
scale and translate:

```
rect(u) = lerp(F, L, E(u))                      # x, y, w, h each linearly
transform for rendering with origin at the node's top-left:
    sx = w(u) / wL ; sy = h(u) / hL ; tx = x(u) - xL ; ty = y(u) - yL
    M = T(tx, ty) * S(sx, sy)                    # scale first, then translate (about the node origin)
```

Why rect interpolation: interpolating `s` and `t` separately only equals interpolating the rectangle if
scale and translate are taken about the same origin; if the designer's origin is the centre, then
`x = cx - w/2` and `tx` is not linear in `s`. Always compute the rectangle, then derive `M`; the two orders
(`T*S` vs `S*T`) give the same picture only when the origin matches, and the table stores **rectangles**,
not matrices, to avoid ambiguity.

**Squeeze-back of video (or of a scene layer treated as a picture).** Source rect `Rs = (0,0,W,H)` (full
frame, `W=1920,H=1080`); target rect `Rt = (xt, yt, wt, ht)` chosen by the layout; the picture's aspect
`a = W/H` must be preserved by default (`fit = contain`):

```
k  = min(wt / W, ht / H)                   # uniform scale
w' = k W ; h' = k H
x' = xt + (wt - w') * ax ; y' = yt + (ht - h') * ay      # ax, ay = 0.5 centre, 0 or 1 to pin to a side
```

For a target of the same aspect `k = wt/W`, no bars. Squeeze tween between `k0 = 1` and `k1`:
interpolate scale **in log space**, `k(u) = k0 * (k1/k0)^E(u)`, so equal time steps give equal perceived
zoom ratio, and interpolate the position so that the **target anchor stays fixed**: scale about the anchor
point `a = (ax_t, ay_t)` of the target (e.g. top-right corner for an L-bar):
`x(u) = a_x - (a_x - 0) * k(u)`, i.e. the picture shrinks toward the corner and its corner never moves. Using
the same `E` for the video squeeze and for the sliding bars makes the frame appear to "hold the picture".

Worked, 1920x1080, L-bar from section 1.6: `Rt = (384, 0, 1536, 864)`, `k1 = 0.8`; anchor = top-right
corner (1920, 0). Duration 25 frames at 50 fps, `E` = cubic bezier (0.25, 0.1, 0.25, 1).
At u = 0.5, `E ~ 0.80` (about; compute exactly at runtime), `k = 0.8^0.80 = 0.836`: picture 1605 x 903 with its top right
at (1920, 0), i.e. `x = 1920 - 1605 = 315`. At the end `x = 1920 - 1536 = 384`. The frame bars move with the
same `E`: left bar width `(1 - k(u)) * 1920 = 315` mid-way, 384 at the end.

**Safe areas [established]:** broadcast guidance (EBU R 95: action safe 93 percent, graphics safe 90 percent;
https://tech.ebu.ch/docs/r/r095.pdf, not re-fetched; the owner's regional rule may differ **[unverified]**).
Check every solved rect: `inset_rect(frame, safe).contains(text_bounds)`. A squeezed picture is allowed to fill
its target rect; text and logos inside the picture scale with it and must still be larger than the legibility
minimum (proposal: 24 px cap height at 1080 after scaling; make this a per-project setting).

**Constraint or flex-style solving [established]** (for when something appears or leaves and siblings move or
resize). 1-D flex solver along one axis, container length `L`, gap `g`, items with `basis_i, grow_i, shrink_i,
min_i, max_i`, visible items `V` (an item that is leaving is still in `V` until its exit ends, or leaves
`V` at its exit start; choose with `reserve_space_until = start | end` per item):

```
free = L - sum(basis_i) - g (|V| - 1)
if free >= 0 : size_i = basis_i + free * grow_i / sum(grow)    # then clamp to max_i, redistribute leftover
else         : size_i = basis_i + free * shrink_i*basis_i / sum(shrink_j basis_j)   # clamp to min_i, redistribute
pos_0 = 0 ; pos_i = pos_{i-1} + size_{i-1} + g
```

Clamp and redistribute until no item changes (at most `|V|` rounds, deterministic order by item id). For 2-D or
mixed relations a general solver (Cassowary-style linear constraints with strengths) may be used, but a
generic solver gives no frame-exact guarantees; proposal: solve at **edit time** and store the result
rectangles in the transition table; the engine only interpolates stored rects, never solves live. Stored form:
`layout_pose[scene_id or role] = rect` for each situation (see section 6.2). Solve again only on Editor save.

Sequence for "scene appears, others move": the layout solver produces `Pose_before` (without the new element)
and `Pose_after`. Siblings run FLIP with the same `E` and duration as the entrance (or a table value), start at
`B.in_start - lead` where `lead` (default 0) lets the siblings start slightly earlier so space is open when
the newcomer arrives.

### 3.5 (e) Priority and conflict model

Targets: same layer (a **slot conflict**) or different layers whose declared regions overlap (a **region
conflict**).

- Every scene declares, in the Editor, `regions[]` (named rects such as `lower_third`, `top_left_bug`) and,
  optionally, `exclusive_zones[]` (a tag; two scenes with the same tag must not be on air together).
- Every take carries `priority` (integer, default = the scene's priority; higher wins) and has a
  monotonically increasing `seq` assigned by the engine on receipt.
- Slot conflict (same layer): the newer take always wins that layer ("a take on an occupied layer replaces it");
  `priority` only matters for **queued/automatic** takes (a low-priority automatic take cannot replace a held
  scene of higher priority; it is rejected with reason `lower_priority`). Operator takes carry the flag
  `operator=true`, which beats any automatic priority.
- Region conflict (different layers): for scenes `X`, `Y` on layers `lx != ly`:
  `conflict(X,Y) = tag_overlap(X,Y) or (rect_overlap(X.regions, Y.regions) and time_overlap)`. Resolution by
  rule on the pair (stored in the table), in this order: `coexist` (allowed, designer accepted), `shift`
  (layout solve moves one: FLIP), `force_out` (the lower sort key leaves), `reject_new`.
- Deterministic order for choosing a loser: sort key `(priority desc, layer desc, seq asc)`; the entry that
  comes last loses. Layer breaks ties because higher layers sit in front.
- Every decision is written to the take log: `{seq, frame, rule_id, winner, loser, action}`.

### 3.6 (f) State machine of a layer slot

A layer slot holds at most **one `held` scene**; during a transition it may also hold one leaving instance.
Hard guarantee: **never two scenes in state `Held` on one layer.**

States: `Empty`; `Entering(B)`; `Held(B)`; `Leaving(A)` (the layer is being emptied: takeout); `Replacing(A out, B in)` (A is
leaving and B entering; the "Replaced" role of A, which is removed when it finishes).
Transient instance flag: `A.replaced = true` means A is no longer addressable by Take ID for takeout.

| Event (at committed frame) | Empty | Entering(B) | Held(B) | Leaving(A) | Replacing(A,B) |
|---|---|---|---|---|---|
| Take T | to Entering(T) | per interrupt policy (3.2) | mode of pair (B,T): to Replacing, or Entering(T) if cut | per policy (3.2) | per policy, never 3 instances |
| Phase end | | to Held(B) | | to Empty | A done: Entering(B), then Held(B) |
| Take out | noop | to Leaving(B) (reverse in or out anim) | to Leaving(B) | noop | to Leaving(B) and A is cut if still on |
| Clear | noop | cut to Empty | cut to Empty | cut to Empty | cut to Empty |
| Late preload | | | | | per `late` policy (3.1) |

Output of the machine for a frame `n`: for each layer, the list of instances with `(scene, phase, u)`; the
renderer composites layers in ascending layer number (higher on top), instances within a layer by
`(entering above leaving)`. Order inside the layer is a stated rule so the render is deterministic.

Determinism of the machine: events are totally ordered by `(committed_frame, seq)`; two commands for the
same frame are applied in `seq` order; the same event log always produces the same state sequence.

### 3.7 (g) Determinism so the Editor simulation equals the engine

1. **One implementation.** The scheduler, easing, spring, layout interpolation and state machine live in one
   Rust crate used by both the engine and the Editor (as native code or WebAssembly). Not two ports.
2. **No wall clock inside the logic.** Input is `(event log with committed frames, transition table version,
   frame rate num/den)`; output is the per-frame list of instances and poses. Wall-clock time only decides `C`
   at the live boundary, and `C` is recorded.
3. **Integers for time**, rational for `R`, fixed-point `u = (n - s) * 2^16 / D` in integers, then `E` in `f64`
   with a specified operation order; quantise the final pose to `f32` once. Do not rely on platform `sin`,
   `cos`, `exp`, `pow` giving identical bits across CPUs/libraries: implement them in the crate (polynomial or a
   fixed lookup table) or use a software `libm` pinned by version.
4. **No hash-map iteration order, no threads in the decision path**, sorted ids.
5. **Table is versioned and hashed**; the engine reports the table hash and engine build in the committed
   report; the Editor refuses to show "matches" if hashes differ.
6. **Golden tests:** record `(frame, layer, scene, phase, pose hash)` for a set of event scripts (all modes,
   all three interrupt policies, clamps, late slip) and compare Editor and engine frame for frame; run on every
   change; a diff of one frame fails the build.
7. **Layout and solves** happen offline (3.4); engine only interpolates.
8. **Randomness and ML** are banned from the frame path (section 5).

---

## 4. Answer to the open question: layer, take, or both

Proposal: **both, in layers of precedence.** `take override` > `pair row in the table` > `layer default` > `project default`.
The pair row is what the designer approves; the layer default covers a pair with no row; the take override
is for a one-off in Playout and is logged. This also answers "cut if the old scene has no exit": it is the
resolution of last resort, `Dout = 0`.

---

## 5. AI transition logic

Name: the owner wants "AI transition logic". Suggested honest scope for the manual: **"AI-assisted
transition logic: the AI proposes, the designer approves, the engine plays a fixed table."** Do not claim
that the on-air system decides with a model.

### 5.1 What ML can learn (all **[proposal]** unless marked)

Training signal: designer-approved or edited pairs `(previous scene P, next scene N, chosen row)`, plus
rejected suggestions. A project may start with zero data, so the first suggestions come from rules and search
(5.2); the model only improves ranking after tens of approved pairs. Honest caveat: with a few dozen pairs,
simple rules and the search below usually beat a learned model; ML earns its place when the library has hundreds
of scenes and the designer accepts many suggestions.

Features per scene (deterministic extraction in the Editor):
- layout: rasterised occupancy mask of each node over time (for example 64x36 grid, alpha weighted) at entrance
  start, held, exit end; bounding boxes of text, logo, bug; safe-area margin; layer number;
- motion: entrance direction vector, travel distance, `Din`, `Dout`, easing id, first and last frame of
  motion, whether the exit exists;
- content class: lower third, bug, full screen, score, ticker (a tag set by the designer, no image model required).

Pair features: mask overlap (IoU) between `P.exit` and `N.entrance`, direction agreement (does `P` leave toward the side
`N` enters from), size ratio, same scene id, same layer, layer distance.

Targets and models:
- discrete: `mode` (3 classes), `entrance_variant`, `easing id`, `fade_law` (classifiers, for example gradient
  boosted trees);
- continuous: `O`, `Dout_scale`, `Din_scale`, squeeze rect (regressors, with a table of allowed values to snap to);
- ranking form (preferred): a pairwise preference model (Bradley-Terry style) that scores candidate rows from
  the search in 5.2, trained on "approved over alternatives shown";
- scene similarity (nearest neighbour on the mask+motion embedding) to propose a row from the most similar
  previously approved pair: **"this pair looks like pair X, reuse its row"**. This is simple, explainable, and
  needs no training.

### 5.2 Constraint-based search of timings [proposal; the checking is established practice]

Enumerate candidates: `mode in {out_then_in, overlap, cut}`, `O in [-Omax .. +g]` in 1-frame steps, `Dout, Din` from allowed
multiples (for example the 5-frame grid), easing from a short list. For each candidate, **simulate with the
exact deterministic engine core** (section 3.7) and compute per frame:

- `collision(f) = sum over pixels of min(alpha_A(f) * m_A, alpha_B(f) * m_B)` on the occupancy masks, with a
  threshold;
- `legibility(f)`: text node of the newcomer must not be covered by more than x percent of a non-transparent
  node of the other scene; contrast check against the background plate when the preview plate is known;
- `safe(f)`: all nodes inside the safe rect except entrance/exit frames;
- `budget(f)`: estimated GPU cost with both instances on (draw count, texture bytes, effect passes) against
  the frame budget (20 ms at 50 fps; proposal target 70 percent of it for the pair at peak); overlap raises
  cost and may force `out_then_in` on weak hardware;
- `latency`: `time_to_held` (3.1) should not exceed the project's cue limit.

Cost `J = w1 * collision_frames + w2 * legibility_violations + w3 * time_to_held + w4 * budget_overrun + w5 * (distance
from the learned/default row)`. Keep the Pareto set, show the top 3, never choose silently.

### 5.3 What must stay deterministic at runtime

- The engine evaluates only a **compiled transition table** (section 6) and the rules in section 3: lookups by
  `(previous scene or class, next scene or class, layer)` with a fixed precedence, no probability, no model file
  loaded by the engine.
- Compile step in the Editor: table, hash, size; unknown pairs fall back to the class row, then the layer
  default, then **cut**.
- The engine never calls ML, never calls out to a service, and does not read learned weights.

### 5.4 Showing a suggestion to the designer [proposal]

- Pair view in the Editor: previous scene on the left, next on the right, a ghost timeline in frames at the
  project's frame rate, three suggested rows ranked, each with a mini ghost (onion skin at 5 frames), the
  collision strip (red frames), `time_to_held`, GPU estimate, and one line of reason: "Pair similar to
  'Score then Lineup' (92 percent), overlap -8 avoids 9 collision frames".
- Buttons: Accept (row becomes `source = ai_accepted`), Edit then accept (`source = ai_edited`, deltas stored),
  Reject (with reason: collision, taste, too slow, other), Pin (lock so a later suggestion run cannot change it).
- Rows that no human has approved are marked `source = auto_default` and shown in amber; the project
  preflight warns when a show uses an unapproved pair.
- Running the AI never changes an approved row. A scripted agent (MCP) may add `proposed` rows only, never
  approve (matches the E12 agent panel rule).

### 5.5 Offline evaluation and logging [proposal]

- Hold-out: leave-one-pair-out on approved pairs: share of top-1 and top-3 suggestions equal to the designer's
  choice; mean absolute error of `O` in frames (target within 3 frames at 50 fps); mode accuracy.
- Quality gates for every suggested row (even rows from rules): zero collision frames above threshold, zero
  legibility violations, within safe area, budget below the limit, determinism test passes (Editor vs engine
  simulation frame for frame).
- Frame-budget evaluation uses a measured cost table per scene, from the Editor's render of the first and
  last 20 frames of the pair.
- Log (append only, per row): `suggestion_id`, model version or rule version, feature hash, candidates shown,
  designer decision, edit deltas in frames, time to decide, evaluation results, table hash at compile time.
  Retraining uses only rows with a decision; rejected suggestions count as negatives.

### 5.6 Safety rules

1. No model inference in the live frame loop and none on the engine process at all.
2. Table is the only artifact the engine consumes; it is plain data, signed by hash.
3. Every fallback ends in **cut** (always allowed, never blocks a take); a missing row is not an error.
4. Explainability: every row stores `reason` and `source` (`human`, `rule`, `search`, `ai_accepted`, `ai_edited`);
   Playout shows which row fired (`row_id`) in the take log.
5. A suggestion that fails a gate is not offered, or is offered with the failed check shown.
6. No training on show data leaving the machine unless the owner opts in; the model is local and small.
7. Learned preferences are per project/event by default (no leakage across customers).
8. An off switch: "Use only human-approved rows" in Playout preflight.

Status labels: scene similarity and the checking metrics are practical, tested ideas; preference ranking and
learned parameter prediction are a **proposal**; none is a feature of any product read in section 1.

---

## 6. What graphics (Editor wireframes and Figma frames) need

### 6.1 Settings per scene (Editor)

- Default layer (-99,999 to +99,999), `class` tag, `priority`.
- Entrance variants: list of named entrances `{id, label, Din, easing, from_direction}`; at least `default`.
- Exit: `Dout`, easing, `exit_style` (reverse of entrance / own); if none, "cut" (shown as a badge).
- Regions: named rects, exclusive zone tags, safe-area flag for each node.
- Hold behaviour: `reserve_space_until = start | end` of exit for layout solves.
- Loop point (for looping backgrounds) and whether a retake restarts.
- Preload hint: estimated preload time, assets; preflight checks `preload < P_min`.

### 6.2 Settings per layer

- `default_mode` (out_then_in | overlap | cut), `default_O`, `interrupt_policy` (finish_then_replace |
  abort_jump | blend), `late_policy` (slip | fail), `fade_law`, layout group (the siblings that rearrange),
  default priority floor.
- Layout group poses: for each situation a stored rect per member, e.g. `Layout "Studio"`: `Full`
  `(0,0,1920,1080)` and `LBar` `(384,0,1536,864)` for the video role, with `squeeze_duration` and easing.

### 6.3 Settings per pair of scenes (the table)

Row key: `(prev, next, layer)` where `prev` and `next` are each a scene id, a class tag, or `*`.
Precedence when looking up (first hit wins): exact ids, `(id, class)`, `(class, id)`, `(class, class)`,
`(*, id)`, `(id, *)`, layer default. The count of explicit rows grows like n squared (Viz documents the same
growth); classes keep it small.

```
TransitionTable {
  version: u32, hash: [u8;32], fps: {num:50, den:1},
  layer_defaults: [ { layer: i32|"*", mode, O, interrupt, late, fade_law } ],
  rows: [ {
    row_id, prev: SceneRef, next: SceneRef, layer: i32|"*",
    mode: "out_then_in"|"overlap"|"cut",
    O: i32,                       // frames, signed
    out: { frames: u32, easing: EaseRef },     // may override scene's own
    in:  { variant: string, frames: u32, easing: EaseRef },
    fade_law: "linear"|"equal_power",
    layout: [ { role, from_rect, to_rect, start_offset: i32, frames: u32, easing: EaseRef, fit, anchor } ],
    conflict: "coexist"|"shift"|"force_out"|"reject_new",
    source: "human"|"rule"|"search"|"ai_accepted"|"ai_edited",
    approved_by, approved_at, reason: string, checks: { collision_frames, legibility, safe, budget_ms }
  } ],
  easings: [ { id, kind: "bezier"|"penner"|"spring", params } ]
}
```

`EaseRef` is an id into the easing list (cubic bezier four numbers; Penner name; spring `{T_settle, v0_mode}`).
All times are integers of frames; no seconds in the file (display only).

### 6.4 Operator controls (Playout, wireframes P1, P7)

- Layer column and layer field already exist (P1, P7); add a per-take **Transition** chip showing the resolved
  row: mode, O, source (human or default) and a warning icon for `auto_default` rows.
- Per-take override: mode (out then in / overlap / cut), `O` stepper in frames, "Interrupt" policy for this
  take; changes are logged and flagged "override".
- After pressing TAKE: a status line "committed frame N, mode, row id" and, while transitioning, a progress bar
  per layer with the phase (entering, held, leaving).
- Layer panel: Take out, Clear (armed, per the spec), "Cut now" for a running transition.
- Preview shows the ghost of the transition before take (uses the same core as the engine); Virtual output
  unchanged.
- Read-only badge of table hash and engine version; mismatch with the Editor shows a red "not verified" label.

### 6.5 Figma frames

Frames needed for design work: (1) the pair view with ghost timeline and collision strip; (2) the suggestion
cards with Accept, Edit, Reject, Pin; (3) the table grid (rows by previous scene, columns by next scene, cell
= mode icon + `O`); (4) the layout-group editor with `Full` and `LBar` poses and safe-area guides;
(5) the Playout transition chip, per-take override popover and per-layer progress; (6) the preflight warning
for unapproved pairs. Name layers with the table field names above so the Figma import maps cleanly.

---

## 7. Open questions for the owner

1. Is a "cut" still allowed to play the entrance of the new scene (`Din_cut > 0`), or must it appear at its
   held pose? (Section 3.1 assumes a parameter with default 0.)
2. Interrupt default: `finish_then_replace` (smoother) or `abort_jump` (snappier)? Proposal: finish then replace
   for graphics, abort for emergency scenes.
3. Does the exit of an operator-taken-out scene use reverse of entrance by default (Viz does)? Proposal: yes.
4. Safe-area percentages and legibility minimum for the project.
5. Test on the owner's XPression: what does it do with a take on an occupied layer, with an interrupt, and what
   do Default Frame Markers do (items still marked unverified in 1.1).

## Source list (visited or found in search)

- Ross: https://www.rossvideo.com/resources/ross-university/xpression-transition-logic/ ;
  http://www.rossvideo.com/resources/ross-university/getting-started-with-transition-logic-on-xpression/
- Vizrt: https://docs.vizrt.com/viz-artist-guide/5.3/Transition_Logic.html ;
  https://docs.vizrt.com/viz-artist-guide/5.3/State_Transition_Animation.html ;
  https://docs.vizrt.com/viz-artist-guide/5.3/Cross_Animation.html ;
  https://docs.vizrt.com/viz-pilot-edge-guide/3.7/Transition_Logic.html
- Singular: https://developer.singular.live/singular-basics/building-overlays-in-composer/how-to-set-up-layer-logic-to-automate-overlay-transitions ;
  https://support.singular.live/hc/en-us/articles/360018552851-In-and-Out-Animations
- CasparCG: https://casparcg.com/docs/wiki/protocols/amcp-protocol
- Unreal: https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/AvalancheTransition/UAvaTransitionTree ;
  https://help.pixotope.com/phc/25.3/create-a-template ; https://forums.unrealengine.com/t/2246021
- L-bar: https://static.frequency.com/studio/product/graphics-compositions-squeezeback.html ;
  https://docs.uplynk.com/changelog/squeezebacks-for-live-video ;
  https://help.chyron.com/hc/en-us/articles/22779796121748-08-DVE-Editor-SDI-Workflow-Only ;
  https://www.nexttv.com/news/chyron-eases-transitions-cartoon-network-33235
- Method: https://aerotwist.com/blog/flip-your-animations/ ; https://www.w3.org/TR/css-easing-1/ ;
  https://easings.net ; https://tech.ebu.ch/docs/r/r095.pdf
