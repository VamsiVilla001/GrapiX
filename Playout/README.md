# GrapiX Playout workspace

The operator product. Playout is authoritative for the published scene library,
the running order, Preview, Program, transitions, automation and timecode
execution, output configuration and the on-air cursor. It must keep operating if
the Editor closes or disconnects.

```text
apps/playout-web        operator UI: Scene Manager, Take List, Preview/Program
apps/desktop-tauri      desktop shell (@grapix/playout-desktop)
services/playout-control  published scene library, take lists, runtime state,
                          the engine connection and the live event stream
tools/dev.mjs           dev supervisor: engine + control service + UI
```

## The operator model is XPression's

Two surfaces, and the first is sufficient on its own.

**Scene Manager** — every published scene with a numeric **Take ID**. Type the
number, the scene goes to air. No list, no cursor. Take IDs start at 101, are
assigned on first publish and are **stable across republishes**, because
operators memorise them.

**Take List** — an ordered running order for a scripted show. Each entry pins or
follows a published scene version and carries its own layer, transition and
instance data. A persisted cursor marks what Take In acts on next; Continue
advances it and it clears at the end rather than wrapping.

There is no rundown and there are no segments: grouping is the Scene Manager's
category, and page numbers are superseded by the Take ID. A command names either
a Take ID or a take-list entry — never both, and an ambiguous one is refused.

## The engine is the only renderer

`playout-control` speaks protocol v3 to `services/render-engine` and nothing
else. The protocol v2 daemon that once stood behind it as a fallback has been
removed: a fallback that renders different pixels through a different output
configuration is not a safety net, it is a way to put something unverified on air
(`docs/architecture.md`, invariants 1 and 7). A missing engine is reported, never
worked around.

## The Editor link is live

`GET /api/playout/events` is a server-sent event stream. A publish from the Editor
pushes `library.changed` and the operator UI refetches immediately — the library
is never left stale waiting for someone to press refresh. Polling remains as the
floor, so a dropped stream degrades rather than freezes. The header shows
**Editor link live** while the stream is attached.

## The monitors show real frames, in fill and key

The Preview and Program panels used to draw a slate — a card built from scene metadata —
because no rendered frame ever reached the operator UI. They now show the engine's own
pixels, and each panel switches between **FILL** and **KEY**.

Broadcast does not carry transparency as an alpha channel: SDI has none, so a graphics
engine emits fill (the colour) and key (a greyscale matte) as two signals and the
downstream keyer recombines them. White is opaque, black is transparent, and the greys in
between are the feathered shadows and anti-aliased edges a clipped key destroys. That is
why the key is a **render mode** and not a codec feature — it is an ordinary greyscale
image, so JPEG carries it exactly. An alpha-capable codec here would have produced a
design-tool checkerboard no operator uses, at the cost of a PNG deflate per frame and a
transcode.

The payoff is concrete: a rect at 30% opacity looks like a slightly lighter rect in the
fill and reads as mid-grey in the key. Only the key tells the operator it is see-through.

`GET /api/playout/monitor/{preview,program}?view={fill,key}` serves
`multipart/x-mixed-replace` MJPEG, consumed directly by an `<img>`: the browser decodes off
the main thread, so two monitors open for a whole show cost no per-frame JavaScript.
`GET /api/playout/monitors` reports every channel/view pair's viewer count, cadence and
last frame. An unknown channel is a 404 and an unknown view a 400 — never a quiet fallback
to the fill, which would tell an operator the wrong thing about what is on air.

Streams are refcounted per channel *and* view. The first viewer starts an engine
`preview.streamStart`; the last to leave stops it, so an unattended station renders
nothing. N viewers of one surface share one engine stream — the engine allows four
concurrent, and a stream per page load would exhaust that in four reloads. Frames are
decoded once and the same buffer is written to every viewer. In practice a station runs two
streams, because a monitor shows fill *or* key; watching all four at once spends the whole
default budget, and the engine refuses the fifth explicitly.

The operator UI reuses **one** `<img>` per monitor and changes its `src`. Chromium does not
close an MJPEG connection when its `<img>` is detached, so remounting on every view change
stranded the old stream server-side; assigning a new `src` aborts the previous load, which
is what actually releases it.

A monitor holds its connection open across gaps. The picture is layered *over* the slate
rather than replacing it, so any gap reveals the slate instead of a blank box.

The panel is gated on the engine connection, deliberately not on Playout's in-memory
record of what is on a channel. That record is empty after a control-service restart while
the engine keeps rendering, so gating on it would blank a monitor over a live Program.

Nothing here can threaten air: the engine bounds its own stream cadence
(`preview.max_stream_fps`) and skips a tick it cannot serve rather than queueing.

## The animation plays on take

Taking a scene online rewinds its playhead to frame 0 and the animation runs. Two things had
to be fixed for that to be visible, and both were invisible individually:

**The playhead never advanced.** The Program clock kept a private frame counter and handed it
to the renderer, but nothing wrote it back to the scene. A preview stream renders the scene's
own frame, so every monitor sat frozen on whatever Cue or Take last set — the renderer
animated perfectly and nobody could see it. The clock now advances the on-air scene's
playhead by the frames that really elapsed, so a dropped frame moves the animation on by the
time that passed rather than playing it in slow motion.

That advance is deliberately independent of outputs. An operator confirms a graphic on the
monitors *before* any SDI or NDI output exists, so the playhead runs whenever a scene is on
air, not only when it transmits. `engine.getStatus` reports each scene's `frame`.

**The monitor started too late to see it.** `preview.streamStart` refuses while a channel is
empty, so a monitor opened before anything was cued sat on the retry interval — and a 20-frame
"in" animation is over in 0.4s. The hub now acts on the engine's `event.channelChanged`
instead of waiting, so the stream starts within a frame or two of the take.

A take also rewinds, so re-taking a lower third animates it in again rather than showing it
already finished. Cueing a scene that is *already on air* does not rewind: Preview and Program
can name the same loaded scene and share one playhead, so a cue would otherwise yank a live
Program back to the start mid-animation.

Certified by `npm run certify:take-animation`, which holds a monitor open across a take and
counts distinct pictures in the window the animation occupies.

## Exactly one control service

`playout-control` refuses to start when something is already on its port, before it touches
the render engine.

That ordering is the point. `EngineSupervisor` connects from its constructor and Fastify binds
last, so a duplicate launch used to spend its entire startup connected to the render engine as a
second client, then die on a raw `EADDRINUSE` stack trace. The refusal names the cause and the
remedy instead, and the engine's client count does not move — verified.

`GET /api/playout/health` reports `pid` and `buildAtMs` — the mtime of the bundle the process
actually loaded. Comparing it with `dist/index.js` on disk answers "is this the build I just
made?", which is otherwise unanswerable: a failed restart leaves an older process serving the
port and a fix looks inert.

```bash
curl -s localhost:4300/api/playout/health | jq '{pid, buildAtMs}'
```

Set `GRAPIX_PLAYOUT_PORT` to run a second instance deliberately.

## What the desktop shell supervises

| Process | Port | Ownership |
| --- | --- | --- |
| `grapix-render-engine` | 4400 | ensured; adopted if already running, **never stopped** |
| `playout-control` | 4300 | owned |

The engine is never stopped on window close, including one this shell started.
Program outlives an operator window.

## Commands

```bash
npm run dev:playout               # engine + control service + operator UI
npm run build:playout
npm run test:playout
npm run certify:publish-takelist  # publish -> Scene Manager -> Take List -> air
npm run certify:monitors          # engine frames -> operator Preview/Program monitors
npm run certify:take-animation    # a take plays the animation on the monitors
```

Development endpoints:

- operator UI: `http://127.0.0.1:5174`
- Playout control API: `http://127.0.0.1:4300`
- render engine: `ws://127.0.0.1:4400`
