# What a credible v1 of each missing module needs (research, 23 Nov 2026)

Five read-only research passes, one per group of missing modules, from public sources. The reports are
model output: where a claim is only the researcher's inference it is marked **GUESS**, and what could
not be read is under **Not verified**. Ross's current v12.5 guide could not be fetched; the 11.5 and 14.0
guides and Ross application notes were used instead. These notes set the done-when text of the new
plan rows (23 Nov 2026); they are not requirements by themselves.

## 1. External control, GPI, control surfaces, MOS (rows 6.7, 6.8, 6.9, 11.84)

- **Ross RossTalk** (read): plain-text TCP, port 7788, CR/LF-terminated, case-sensitive. Commands: CUE,
  TAKE, SWAP, SEQI, SEQO, READ, NEXT, UP, DOWN, FOCUS, UPNEXT, CLFB, CLRA, LAYEROFF, UNCUE, UNCUEALL,
  RESUME, GPI n. RossTalk counts framebuffers from 0, XPression from 1. The page does not say whether a
  reply comes back.
- **CasparCG AMCP** (read): TCP text; replies 202 (ok), 201 (one data line), 200 (multi-line), 4xx client
  error, 5xx server error; an optional `REQ <id>` prefix returns `RES <id> <code>`; BEGIN/COMMIT batches;
  LOCK ACQUIRE/RELEASE for exclusive channel control; CG ADD/PLAY/STOP/NEXT/REMOVE/CLEAR/UPDATE/INVOKE.
  State feedback is separate: one-way OSC over UDP, port 6250.
- **Vizrt Viz Engine** (read, partly search-only): TCP port 6100; a leading flag, -1 for no reply or a
  command id that is echoed; an optional REST interface, off by default. **Singular** is REST PATCH with a
  control-node body. **Chyron PRIME** offers TCP, XML, WebSocket JSON, AMP, PBus and VDCP (search-only).
- **GPI/tally**: XPression has two GPIs on a 9-pin serial connector and a debounce setting (about 50 to
  100 ms; without it one press advanced a sequence by two or three events); "Smart GPI" is the RossTalk
  command `GPI n`, up to 64 simulated inputs mapped to functions in Keyboard/GPI Mapping.
- **Control surfaces**: Bitfocus Companion drives devices over HTTP, OSC, TCP, UDP and WebSocket and has
  modules for CasparCG and XPression; the sensible v1 is a stable versioned HTTP and TCP command API and
  a feedback endpoint, and Companion and Stream Deck work through their own modules.
- **MOS 2.8.5** (read): XML over TCP, ports 10540, 10541, 10542; Profile 0 (heartbeat, machine info) plus at
  least one more; Profile 1 (mosObj, mosAck), Profile 2 (running order: roCreate, roReplace, roDelete,
  roElementAction, roElementStat, roReadyToAir). The spec has no graphics-specific minimum.
- **v1 minimum**: a line-based TCP command port (load, cue, take, out, clear layer, clear all, update field,
  run sequence item, next, previous) with coded acknowledgements and an optional request id, state events
  pushed to subscribers, an HTTP mirror of the same verbs, a RossTalk-compatible subset (CUE, TAKE, SWAP,
  CLRA, GPI n, NEXT) so Ross-trained automation works unchanged; GPI over the network with a
  user-editable map and a debounce in milliseconds; tally out through the feedback channel; a MOS device
  with Profiles 0, 1 and 2; plain XML and CSV rundown import and export. **Can wait**: Viz and Chyron
  dialects, OSC input, batching, per-layer locks, physical contact-closure boards, a native Stream Deck
  plugin, MIDI, MOS Profiles 3 to 7, ENPS and iNews plug-ins.
- **Security**: only partly sourced (CasparCG LOCK; Viz `max_tcp_connections`). **GUESS**: loopback and off
  by default, a credential, an allow-list of source addresses, a role per connection (view, cue, take),
  every take audit-logged with who, source and time, take/clear/update as separate permissions. The
  19 Nov decision already requires a credential on the MCP HTTP port.
- **Not verified**: XPression's reply behaviour, the full RossTalk reference, Ross's MOS note (404),
  Companion module action lists, Viz command replies, vendor guidance on who may take to air.

## 2. Crawl, roll, widgets (rows 11.89, 11.90, 11.56)

- **Crawl/ticker** minimum: a horizontal text object; speed in pixels per second (not per frame),
  direction, a separator, a fixed gap, loop on or off; start populated or empty; items come from a list and
  the next is appended as one leaves, so the stream is endless; operator start, stop (decelerate to hold),
  resume and live speed change (XPression 8.5+ does this with the Plus and Minus keys); add, remove or
  replace items not yet visible with no jump and never reflow a visible item. **GUESS**: lock item widths
  at entry; advance by elapsed engine time times speed in float with GPU sub-pixel sampling and a baked
  glyph strip, no per-frame layout. CasparCG HTML marquees are reported to shake and stutter, which is
  the failure to avoid.
- **Roll/credits** minimum: speed in px/s, upward, alignment left/centre/right per group, group spacing,
  start offscreen, stop at end or loop, operator start, pause, continue, live speed. Section styles
  (heading, two-column role/name, spacer) as styled rows (**GUESS**). Can wait: stopper marks with ease
  in and out, pause at a marker, inertia.
- **Widgets** minimum: clock (time of day, system or named zone with daylight saving, format codes,
  offset); timer (count up and down, `hh:mm:ss(.ff)`, a stop-at limit); counter (set, +1, -1, reset);
  operator actions start, stop, reset, set value, run to a target time of day. The exact XPression and
  Chyron widget property lists are **not verified**.
- **Feeds**: poll a file, HTTP or RSS into a list that is separate from the scroller (new items enter at the
  next refill), a filter hook, last-good fallback on a failed poll (**GUESS**); write source files to a temp
  name and rename. **Frame exactness (GUESS, not documented anywhere found)**: scroll position is a pure
  function of the engine frame counter (start + speed x frames / rate); commands carry an apply-at-frame;
  speed changes are ramped; under load recompute from the counter, never accumulate wall-clock deltas.
- **Not verified**: XPression's own crawl, roll, clock and timer property lists (the 14.0 guide would not
  fetch), Singular and Chyron chapters, any CasparCG statement on crawl.

## 3. Audio, clips, live video, key and fill (rows 16.17, 16.18, 16.19, 11.86)

- **Audio**: XPression takes WAV only, on an audio track in the Scene Director, 48 kHz 16-bit recommended,
  level keyframes, an Audio Channel Mapping dialog; Hardware Setup > Audio Devices at 48 kHz with a delay in
  frames; no device is needed for embedded or AES audio; 2 or 8 embedded channels per output, an audio
  delay offset in frames; NDI carries up to 8. CasparCG prefers 48 kHz, supports up to 16 channels, and
  converts layouts. **v1 minimum**: WAV 48 kHz PCM and audio inside video clips; an audio cue triggered with
  a graphic and locked to the video clock; gain in dB, fade in and out, loop, a channel map to a 2 or 8
  channel bus; a per-clip peak meter; resample to 48 kHz at import. **GUESS**: mixing, loudness and
  routing stay with the production audio desk. Can wait: MP3/AAC, surround, EQ, ducking, audio input mixing.
- **Clips** (XPression Clips Workflow Guide 11.5, read): the Clip Browser lists thumbnail, in/out/length,
  format, codec, audio channels, bit depth, recall id, project, volume in dB, alpha and the flags LE (loop
  enabled), HF (hold last frame), PM (premultiplied); hovering plays a flipbook over a checkerboard so
  alpha is visible; search by name, recall id, duration, project, date, channels; sub-clips; 3-point and
  4-point loops; clips are cued or played with dissolves; ingest by a watch folder that transcodes. Viz
  plays ProRes (422 variants, 4444), DNxHD/HR and HAP (HAP, HAP Alpha, HAP Q need a Pro licence). **v1
  minimum**: a project media folder with a thumbnail grid, duration, codec, alpha, in/out, loop,
  hold-last-frame, premultiplied; cue and play on a layer; ProRes 4444, HAP and HAP Alpha MOV, H.264,
  DNxHR, PNG sequences (priority is a **GUESS**); a transcode to a playout-friendly cache (**GUESS**). Can
  wait: MAM and OpenMAM, multi-server sync, expiry, proxies, VDCP and AMP.
- **Live video input**: XPression has an Input tab (standard, hardware queue size, a fixed input-to-output
  latency in frames, external genlock recommended) and an Input Grabber pane (no details found); Record
  Client records SDI to file or still. **v1 minimum (GUESS)**: one SDI or NDI input as a layer texture, a
  fixed-latency buffer set in frames, genlock or free-run flag, embedded audio pass-through or mute,
  picture in picture as a transformed live layer. Can wait: several inputs, low-latency compositing.
- **Key and fill**: XPression output modes Off (fill only), External (separate key and fill), Internal (the
  framebuffer is the keyer, needs genlock); external fill shaped or unshaped. **v1 minimum**: one program
  channel with fill and key on paired outputs, shaped or unshaped, embedded audio and a fixed offset;
  NDI carrying RGBA and audio. Can wait: internal keyer mix, ST 2110, PTP.
- **Not verified**: the 12.5 guide (404), Input Grabber, live-input latency, OpenMAM setup, any Ross codec
  recommendation.

## 4. Settings, project modes, file commands, editing basics, help, localisation (rows 2.28, 7.8, 11.81 to 11.85, 11.88)

- **Preferences** (XPression 14.0, read): Editor (startup, delete confirmations, default animation length,
  keyframe interpolation), Hardware Renderer (GPU adapter, anti-alias), Viewports, Path Persistence (per
  asset type: last used, fixed, project), Import defaults, Folders, Texture and Image Cache (memory limit,
  preload, alpha interpretation per format), On Disk Cache (path and maximum size), Sequencer, MOS, XML
  Take Item List, Fonts, Remote Server, CII, RossTalk, Video Engine, ClipStore, OpenMAM, As Run Log,
  Advanced (process priority, FFmpeg path, scripting debug), Localization, Log Level, Certificate
  Management; XPression keeps a backup of preferences and hardware setup. **v1 minimum (judgement)**:
  Editor, GPU adapter and anti-alias, path and asset folders, import defaults, cache limits, process
  priority, fonts, language, log level, the control server's address and credential, reset to defaults.
  **GUESS on storage**: per user (language, theme, layout, shortcuts, last-used paths, confirmations),
  per machine (GPU adapter, caches, ports, credentials, outputs), per project (everything that changes
  rendered output) and never in Preferences.
- **Project modes**: File > New picks a preset (video format, custom presets, location, name, optional
  folder structure); Convert Project Mode has an Editing Mode drop-down; **what it preserves is not
  verified**. **v1 minimum**: raster, pixel aspect, frame-rate family with a drop-frame flag, progressive or
  interlaced with field order, safe areas, colour space and bit depth, presets and custom presets,
  structure folders. **GUESS for convert** (from After Effects and Final Cut behaviour): keep all scenes,
  objects, assets and key times; scale by an explicit option (none, fit, stretch); keep colour settings;
  warn that a frame-rate change shifts timing; never overwrite the source, save as new.
- **File commands** (14.0 guide): Ctrl+O, Ctrl+S, Ctrl+Alt+S Save As, Ctrl+Shift+Alt+S Increment and Save,
  F9 Revert, Ctrl+Alt+E show path in Explorer. Import > From Project/File has tabs (scenes, materials,
  models, fonts, audio, stagger animations, widgets, global lists) and options (copy resources into the
  project, use existing fonts, maintain folder structure). Export Items writes `.xpe` with an optional
  password and fonts. The Ross best-practices note (written for the 32-bit memory limits) recommends
  numbered Increment and Save versions and a separate XML export of the sequence as a backup.
- **Editing basics**: XPression has align edges and distribute horizontally and vertically; no undo history
  panel, snap or guides were found (absence is not proof). Viz Artist has an undo stack dock you click to
  roll back or forward. Figma has align, distribute, smart selection, pixel-grid snap, layout guides.
  **v1 minimum**: a jumpable history list; align (edges and centres) and distribute; snap to grid, guides
  and object edges and centres with a toggle and a hold-key bypass; multi-select transform about a shared
  pivot.
- **Help**: XPression F1 opens online help and ships a PDF guide. **v1 minimum (GUESS)**: F1 context help
  from local offline docs (studios are often air-gapped), a searchable shortcuts sheet, About with version,
  build, licence and a log-folder shortcut.
- **Localisation**: XPression has a Localization panel (locale override, shaping, right-to-left, digit
  substitution) but a mostly English interface. **v1 minimum**: every string in resource files with stable
  keys, UTF-8 throughout, locale-aware numbers and dates, layouts that tolerate text growth, a
  pseudo-localisation test; translations and full right-to-left mirroring later.
- **Not verified**: the 12.5 guide, XPression's per-user or per-machine storage, Convert Project Mode
  semantics, After Effects pages (403), undo-history features in XPression.

## 5. Camera tracking and virtual studio (row 16.20, parked)

- **FreeD (D1)** is the baseline: a 29-byte packet (type, camera id, 3-byte big-endian pan, tilt, roll, X,
  Y, Z, zoom, focus, checksum), serial 38400 8-O-1 or UDP (Unreal's default port 40000); no lens
  distortion or timecode in the packet. **Sources disagree on the scaling** (Vizrt divides positions by 640;
  a third-party decoder uses 64 x 256), so verify against hardware and the original spec. Richer vendor
  protocols (Stype, Mo-Sys F4, Trackmen, Ncam, EZtrack) carry distortion, FOV and timecode; their wire
  formats were not verified. **OpenTrackIO** (SMPTE RIS-OSVP v1.0.1): UDP multicast, JSON or CBOR, one
  sample per frame, timecode, Brown-Conrady distortion, lens centre shift; Unreal 5.6+ supports it.
- **Engine duties**: map pan, tilt, roll and XYZ to the 3D camera (convert the coordinate frame), map zoom
  and focus counts to field of view through a lens table, apply lens distortion and centre shift, delay
  tracking or video to match, sync to genlock or timecode, output fill and key or composite over live
  video. Ross added 2nd and 4th order distortion in v5.5 and timecode-synced sources in v5.7.
- **v1 minimum**: FreeD over UDP (and serial if feasible), camera mapping with a manual lens table, a
  manual delay in frames, a tracking monitor showing rate and drops, per-parameter disable or override,
  fill and key output, a manual camera as fallback. **Can wait**: Stype, Mo-Sys, Trackmen and Ncam
  drivers, OpenTrackIO (the better second protocol, **GUESS**), lens calibration files, timecode and PTP,
  reflections, shadows, virtual screens, a chroma keyer. XPression's "Camera Tracking" tab in Hardware
  Setup could not be confirmed; its release notes confirm a global camera tracking source, Egripment,
  NCAM and Stype support and a tracking monitor under Tools > Debug.
