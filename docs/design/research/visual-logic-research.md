# Visual logic and data blocks in broadcast graphics: XPression, Vizrt, Singular, Chyron, CasparCG

Research date: 2026-11-24. Purpose: understanding only, so GrapiX can design its own original set of logic and data blocks. Names of competitor blocks appear here only as evidence; none are proposed for GrapiX.

Does not repeat `docs/reference/xpression-menu-bar.md` (menu inventory) or `docs/research/market-scan-2026-11-18.md` (feature map).

## 0. Read this first: evidence quality

- **No complete official block list for XPression was obtainable.** The XPression user guides (v11.5 and v12.5 PDFs on documentation.rossvideo.com) are over the 10 MB fetch limit of the research tool, the Scribd and Issuu mirrors return only the cover pages, and the community forum pages return 404 to the fetch tool. I did not download the PDFs outside the tool (no download permission). The block inventory below is therefore **assembled from Ross release notes, Ross University pages, and excerpts the search engine returned from forum threads**. It is a partial list, not the product's full catalogue.
- Marks used: **[V]** verified on the cited page I read; **[S]** secondary, taken from a search-result excerpt of a page I could not open myself (forum threads, a third-party CodePen guide); **[U]** unverified, stated as open question; **[I]** my inference, labelled as such.
- Quotes are limited to short phrases. Everything else is paraphrased.

## 1. Ross XPression Visual Logic

### 1.1 What it is, and when it appeared

- Visual Logic was introduced in XPression 5.5 as a node-based visual interface for building templates without scripting [V] (release notes: https://www.rossvideo.com/products-services/acquisition-production/cg-graphics-systems/xpression/software-releases/ ). Ross University says it was "implemented in XPression 6.5" and adds data-handling power on top of DataLinq [V] (https://www.rossvideo.com/resources/ross-university/xpression-visual-logic-sort-selector-function-block/ ). The two statements disagree on 5.5 versus 6.5; the release notes list the 5.5 entry as the introduction and 6.5 as the Sort Selector addition, so I read 6.5 as the Sort Selector release [I].
- The Ross page names two families of building blocks: **Function Blocks** and **Object Blocks** [V] (same Sort Selector page). Function Blocks compute and route (maths, strings, selectors); Object Blocks expose a scene object's properties as ports [I, consistent with the property-exposure entries in the release notes below].

### 1.2 The editor: how a graph is built

What is documented:

- Blocks are wired together with connections; connections typed "any" are drawn dark red (v8.5 and v9.0 notes) and the connections of a selected block are highlighted in red (v10.0) [V] (release notes).
- The editor can show each block's current value below it (Alt+V, since v9.0) to check maths, and has **Assign & Paste**, which copies a group of blocks and re-targets them to the next similar objects with incrementing values, for repeated groups such as ladder rows or table cells [V] (https://www.rossvideo.com/resources/ross-university/using-the-visual-logic-features-show-block-values-and-assign-paste/ ; release notes v9.0).
- The editor works in **tabs**. Scripts can delete a tab by name or index, and a block-graph can be saved and loaded as an XVL file, all tabs can be saved to a folder, several files imported at once (v10.0 and v11.0 notes) [V]. An API object can load/save XVL files and enable/disable tabs (v10.0) [V].
- Right-clicking a block property scrolls to that property in the Object list (v11.0) [V]; the editor therefore has an object list from which properties become blocks.
- Math blocks display more decimal places since v11.0 [V].

Where it lives: the Scene Manager right-click menu contains an **Edit Visual Logic** entry beside **Edit Script Events** [V] (per the previously gathered note `xpression-menu-bar.md` section 13, from a screenshot at https://www.tvtechnology.com/news/ross-announces-xpression-105 ). So logic is attached **per scene**; per-object attachment was not found [I]. Whether the XVL data is stored inside the project or scene file is [U].

### 1.3 Execution model (the most important part for GrapiX)

All of these come from Ross staff and users via forum excerpts, marked [S]; the forum pages themselves could not be opened.

- Visual Logic is **evaluated per rendered frame**, not on events. Ross staff say it only executes when a frame is rendered, so it may not appear to run in a viewport that is not rendering. Source: https://rossvideo.community/discussion/visual-logic-issue-on-xpression-105 and related threads returned by search [S].
- The **preview renders one frame**, so chains of dependent blocks can fail in preview but work in playback; tabs are evaluated left to right [S] (https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=c4c97d75-1e79-42d3-8784-bea27d533e13&CommunityKey=91812bfd-9393-4a3f-8a74-7f8035df130e , "Visual Logic Failing for Preview Only").
- By default Visual Logic is evaluated **before** scene directors advance within a frame, which can produce one-frame timing mismatches; a checkbox in the Visual Logic window reverses that order. Release notes confirm the option: v7.0 added "run Visual Logic after scene directors stop" so linked objects move in sync [V] (release notes; the checkbox description itself is [S]).
- Since v11.0 Visual Logic also runs during the **preparing** phase when a scene is going online, so text it sets can feed DataLinq queries [V] (release notes).
- The active-viewport toggle (the "blue diamond") stops continuous animation and Visual Logic updating in the viewport [S].
- The one **event** style trigger added later is **OnSetText** (v11.5): a text object receiving new text can start things, replacing a scripting workaround; Ross describes it as firing for a text object already on the frame buffer [V] (https://www.rossvideo.com/resources/ross-university/onsettext-visual-logic-block/ ; release notes v11.5). The page does not list which actions it can start.

[I] Net model: a **dataflow graph re-evaluated every frame** (pull/continuous), with a small number of event-source blocks added afterwards. State such as "what changed" must be modelled with explicit blocks (counters, stored previous values), which explains many of the complaints in section 5.

### 1.4 Block catalogue found (not exhaustive)

Names are exactly as found in sources; description is paraphrased. Category labels are mine.

**Logic and compare**
- And, Or, Not blocks for if/then wiring [S] (CodePen quick guide "XPression Reference Guide", https://codepen.io/staciedanyelle/pen/OJwjQKB , 403 to the fetch tool; seen only in a search excerpt).
- String Compare with an Equal output giving 0 or 1, which a Not block can invert [S] (forum excerpts via search, e.g. https://rossvideo.community/discussion/run-a-scene-director-when-score-changes-using-visual-logic ).
- String Match: compares text against a list held inside the block and outputs the matching index; String Selector turns an index into the corresponding string; together they form a lookup table [V] (https://xpressionu.podbean.com/e/basics-252-visual-logic-blocks-string-match-and-string-selector ). Added v11.5 [V] (release notes).

**Math and numeric**
- Add, Multiply, Value [S] (CodePen guide); a block for square roots and exponents (v8.5); vector length and distance blocks (precision improved v9.0) [V] (release notes).
- Format Float block, with custom format string support (v7.0), and a Format String block (v7.0) [V].

**Selectors and list handling**
- Sort Selector: reviews and re-orders input values and passes the sorted values on to outputs, cascading the sort to other blocks; sort-order output became 1-based in v9.0 [V] (Ross page above; release notes).
- Input Selector with an Index Offset property (v6.2) [V]. Output Selector routes one input to one of several outputs by an index (v8.0) [V]. Metadata Selector for metadata properties (v6.1) [V].

**Time and timers**
- Date/time blocks (several, v7.0), a Time Offset block that adds or subtracts from dates and times (v9.5), Time Delta with outputs for which date is larger or equal (v9.5), Convert Epoch Time (v11.0) [V] (release notes).
- Clock block (current date/time) used with an Encode Date Time block and a countdown block for a countdown [S] (forum excerpt: https://rossvideo.community/discussion/need-help-creating-a-countdown-clock-for-an-event ). Ross University also has a lesson on counting down to a date or time with function blocks [S] (search listing).
- A Counter block used with String Compare feeding Visible and Play blocks to build a countdown trigger [S] (https://rossvideo.community/discussion/visual-logic-timer-countdown-animation-trigger ). Its properties are undocumented in what I could read [U].

**Data in**
- DataLinq block: requests a value from a DataLinq source; supports multiple data points (ADODB since 8.5; JSON and XML sources since 10.0; RSS static URL mode; the Dashboard DataLinq since 11.0) and prepend/append data (10.5, 11.0) [V] (release notes).

**Object property blocks (Object Blocks)**
Evidence that scene objects expose properties to Visual Logic, from the release notes [V]:
- Alpha of the Group object (6.2); light colour, falloff, range (6.1); camera Aspect, Near, Far Plane (7.0); Torus diameter properties (8.0); WidthScaled/HeightScaled/DepthScaled bounding box (5.7); TextWithTags with child properties for font tags and material tags (7.0); word wrap and auto-squeeze on text (6.5); a Visual Logic Metadata property on all objects, with XMP/EXIF forwarded from material metadata (6.1); `play`, `stop`, `pause` properties on object faces for video/Tessera (8.0); an IsBound property to test whether a material is assigned to a face (11.5); ShowInTemplateData and TemplateDataColor to hide and tint published fields (10.5); a "published value" property with a `reset` child that reverts an override to the original XMP value (11.0); material colour properties accept #RRGGBB (10.5).
- Forum use shows blocks named Visible and Play being fed from logic [S]. So the pattern is: **each scene object's parameters become input/output ports on an Object Block, and logic wires into them**.

**Scene Director control**
- Scene Directors are triggered from Visual Logic through a boolean-driven block; users report this is fiddly (section 3.3). Dashboard can also command directors [S] (https://rossvideo.community/discussion/dashboard-commands-for-scene-directors ). The exact name of the director block is [U].

**Script / custom blocks**
- No VBScript or JScript custom block type was found in any source I could read. Scripts live in a separate mechanism (Edit Script Events, scene events such as onOnline) [S/U] (section 3.5).

### 1.5 Versions 10 to 12

Release notes list Visual Logic changes in 10.0, 10.5, 11.0, 11.5 (all above) and **none in 12.0 or 12.5** [V] (release notes page; the 14.0 notes were not parsed for Visual Logic). The Ross application note on DataLinq is dated 2026 and mentions XPression 14.0 for TLS-secured DataLinq connections [V] (https://documentation.rossvideo.com/files/Manuals/CG%20and%20Graphics/XPression/Application%20Notes/XPression%20DataLinq%20and%20Scoreboard%20Sources%20%283500DR-550%20Rev%201%29.pdf ). So Visual Logic has been essentially stable since 11.5 [I].

## 2. How data comes into XPression

### 2.1 DataLinq

Ross's DataLinq application note lists the source families [V] (URL above): ADODB (OLE DB, ODBC, Access, Excel, Oracle via SQL queries), AMQ (AMQP and STOMP, with failover endpoints and table presets), ASCII streams (TCP client, table presets, dynamic tables by key), JSON and XML files (with a folder-watch mode and caching in 14.0), XML/JSON over TCP server/client/UDP (with Basic, Bearer, API-key auth in 14.0), **RSS/HTTP** (REST, RSS, XML, JSON, text, with OAuth 2.0, custom headers, API keys, static and dynamic URLs), **WebSocket** (including wss, binary frames), Text (delimited files), DashBoard, CSV via ADODB, and some thirty scoreboard and sports feeds (Daktronics, Genius Sports, Stats Perform, NBA, OES, Swiss Timing and others). Google Sheets is possible through the RSS/HTTP source as published CSV [V] (same note).

Binding: DataLinq connects datasets to templates using RelID and SQL queries to load specific records into Take IDs; a text object can be marked as a **macro** so its content selects the record shown, previewed immediately in the Sequencer [V] (https://www.rossvideo.com/resources/ross-university/using-a-text-object-macro-in-xpression-datalinq-to-select-games/ ). Live update is a per-source setting; one forum thread blames a pivot reset on a Visual Logic setup with live-update DataLinq [S] (https://rossvideo.community/discussion/ross-xpression-pivot-issue-with-datalinq-visual-logic ).

### 2.2 External triggers: GPI, RossTalk, Dashboard

From the Ross Smart GPI / RossTalk application note [V] (https://documentation.rossvideo.com/files/Manuals/CG%20and%20Graphics/XPression/Application%20Notes/RossTalk%20-%20Smart%20GPI%20on%20XPression%20%283500DR-513%20Rev%201%29.pdf ):

- Two GPI types: the basic **advance-next contact closure** (RS232 pins) and **Smart GPI / RossTalk**, a text protocol over serial, TCP or UDP, each command terminated with CR/LF.
- Contact closures can bounce; a **Debounce Time** (ms) setting filters repeated triggers, 50 to 100 ms suggested, because a noisy contact otherwise advances the sequence two or three events at once.
- Commands include: CUE, TAKE, SEQI/SEQO (take a template in/out on a layer), LAYEROFF, CLFB/CLRA (clear), RESUME, SWAP, NEXT/READ/UP/DOWN/FOCUS (sequencer navigation), **TEMPLATEDATA [takeid]:[objectname]:[value]** (set a field in a take item), **DATALINQKEY [takeid]:[key]:[value]** (set a DataLinq key), GAMESTATE (log an as-run entry), and **GPI [num]:[state]**.
- The GPI command simulates up to 64 virtual GPI inputs that can be mapped to global functions; an optional state of 0 or 1 makes it a **level-based GPI readable from the API**, and without it the state is assumed to be 1 [V]. This is the clearest vendor statement of pulse versus level handling in the XPression material I could read.
- Smart GPI lets the sender include a Take ID, so templates can be recalled in any order, unlike advance-next [V].
- Keyboard/GPI Mapping (Edit menu) maps GPIs and keys to global functions [V] (same note).

Dashboard passes data into XPression through a DashBoard DataLinq source and the Smart GPI port (TCP 7788 in one Ross note) [S] (search excerpt of https://documentation.rossvideo.com/files/Manuals/Enterprise%20Control%20Systems/DashBoard/DataLinq%20Information%20from%20DashBoard%20to%20XPression.pdf ; page not read).

### 2.3 Booleans and repeated triggers

- Forum report (2019): a user expected a Boolean wired into a Visual Logic play block to start a Scene Director and it did not; the workaround that worked was removing a pause event from the director and putting the remainder of the animation into a second director, and in another thread putting a STOP event at the end of both directors [S] (https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=cfb0bd05-06bc-439d-b989-c856f3313d7e&CommunityKey=91812bfd-9393-4a3f-8a74-7f8035df130e ).
- Another suggested approach: two Event Markers whose visibility is conditioned on the data, with the markers triggering directors to play and stop [S] (same family of threads).
- Score-change animation: the user's logic compared the displayed score with the data-linked score and played the animation when they differed; the director swaps the displayed value at a frame where the alpha animation hides it [S] (https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=d53d0289-061c-407b-879a-9a966a575fdf&CommunityKey=91812bfd-9393-4a3f-8a74-7f8035df130e ). This is "compare against stored previous value" built by hand.
- A stopped or paused director must be handled carefully when another director is started; one user added an OnPlay command to stop the other [S].
- **A dedicated pulse, edge, or event-id block was not found.** The Counter block appears in forum recipes as the substitute [S]. Whether the block set contains a rising-edge detector is [U].

### 2.4 Scripting versus Visual Logic

- XPression has COM-style scripting with specialist objects (xpTextObject, xpSceneDirector, xpTakeItem), written in VBScript [S] (CodePen guide; search excerpts of forum threads "Xpression Script Live COM Objects", https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=f888a240-5aa0-4119-b91e-8c7e63d29fa6&CommunityKey=91812bfd-9393-4a3f-8a74-7f8035df130e ). Scripts attach at events such as onOnline / OnBeforeOnline [S]. A Ross intro video covers where scripts can be created and shows a copy-one-text-to-another script [V] (https://www.rossvideo.com/resources/ross-university/xpression-scripting-part-1-an-introduction/ ).
- Scripts hold COM references only while they run; objects cannot be kept between runs [S] (Ross staff, via search excerpt).
- Ross staff recommend an onOnline script rather than Visual Logic for hiding a logo inside a crawl [S]. The OnSetText block exists because users wanted event-style behaviour that previously needed scripts [V].
- Visual Logic cannot (as far as found) call a script, nor can a script author a custom block [U].

## 3. Typical examples (as found)

| Example | What the sources show |
|---|---|
| Sports scorebug | Scoreboard feeds through DataLinq (Daktronics, OES and so on), text bound to fields, Visual Logic for formatting and visibility; a basketball shot-clock thread used DataLinq-driven directors that needed STOP events [S][V]. |
| Repeated events | Compare shown value with data value and play a director; a Counter feeding Play/Visible [S]. |
| Elimination and ladder graphics | Assign & Paste explicitly targets league ladder rows and table cells; Sort Selector reorders rows by value and cascades the order [V]. |
| Ticker / crawl | A 2022 Ross tutorial binds a crawl with several text objects to DataLinq and uses Visual Logic for variable text sizes [S] (search listing of Ross University). |
| Countdown | Clock + Encode Date Time + countdown block, or Counter on a String Compare result [S]. |
| Show/hide on empty | Visible block fed by string tests; ShowInTemplateData hides published fields in MOS plugins [V]. |

## 4. Known limits and complaints (XPression)

1. Only evaluated when frames render; the viewport and the one-frame preview may not show it (section 1.3) [S].
2. Execution order against Scene Directors is implicit (before by default; a later option reverses it), a source of off-by-one-frame bugs [S][V].
3. No obvious edge/pulse primitive; triggering a director from a boolean is unreliable and needs work-arounds [S].
4. Help is thin. A community thread asks for Visual Logic basics videos and says the help is "sadly limited" [S] (https://rossvideo.community/discussion/any-video-tutorials-covering-visual-logic-basics ). Block properties are largely not documented in public pages [U].
5. Reports of Visual Logic "stopped working" or failing after reopening a project (audio cues in 10.5; preview-only failures) [S] (https://rossvideo.community/discussion/help-visual-logic-stopped-working , https://rossvideo.community/discussion/visual-logic ).
6. State persistence is hard because logic is re-evaluated every frame and COM script objects do not persist [S][I].
7. Repetition is handled by copy tools (Assign & Paste) rather than by a loop or list-repeater construct, so a ladder of N rows is N copies of a group [V][I].

## 5. Vizrt

Vizrt does **not** have a single node-graph logic editor in the product line I could read. Logic is split across several mechanisms. "Logicmaker" is not a logic-block editor: it is the **Transition Logic** simulator.

### 5.1 Logicmaker and Transition Logic

- Transition Logic is a way to design a graphics package so the designer sets look and behaviour while others add rundown items without technical knowledge. A scene set has a **master scene** (backgrounds, static design elements) and **object scenes** (variable content); several layers can be on air independently, and only one object scene is active per layer [V] (https://docs.vizrt.com/viz-artist-guide/5.4/Transition_Logic.html ).
- When an object scene is taken, the engine loads the master scene, places the object scene in it, and animates the proper timelines; transitions between graphics on one layer are baked in at design time [V] (same page).
- **Logicmaker** is a dock for creating and simulating those scenes: a **Layers List** (toggle layers, each a placeholder for object-scene insertion), a **States List** per layer (typically an Out state and an In state, plus others), a **Scenes List**, and a **State Graph** where states are nodes you click to jump between, with or without animation. Deleting a state converts its Stop keyframe into a Tag. A valid object scene needs a control-object plug-in, Transition Logic enabled, valid layer and state identifiers, and a Master or Background role [V] (https://docs.vizrt.com/viz-artist-guide/5.4/Logicmaker.html ).
- Layers are a toggle container plus a same-named director, so layers can push each other (a ticker going on air moves a lower third) [V] (https://docs.vizrt.com/viz-artist-guide/5.2/Toggle_Layer.html ).
- Detail pages for State Transition Animation and Cross Animation exist but I did not read them [U].

### 5.2 Control Object and Control plug-ins (the field and data interface)

- A **Control Object** plug-in on a container exposes controls to applications such as Viz Pilot and Viz Trio; each exposed field has a unique **field identifier** (restricted character set), a type, a description, an operator-editable value, and Min/Max for integer and float fields; ControlList structures appear as groups; the editor can search by identifier, name or type [V] (https://docs.vizrt.com/viz-artist-guide/5.2/Control_Objects.html ; 3.10 notes via search results).
- Control plug-ins listed in Viz Pilot Edge's overview: Control Action, Action table, Bars, Chart, Clip, Condition, Container, DB Object, Data Action, Datapool, Feed, Field Identifier, Field Renamer, Geom, Hide in range, Hide on Empty, Image, Keyframe, List, Material, NDI, Number, OMO, Parameter, Payload, Pie, Sign Container, Soft clip, Stoppoint, Text, VBI, Video, and others; Control Clock and Control Maps are unsupported there [V] (https://docs.vizrt.com/viz-pilot-edge-guide/2.4/Control_Plugins_Overview.html ). Descriptions exist for only some.
- **Control Condition** triggers an action when the value in the field with the same identifier meets a condition; later versions add Format, Condition, Arguments and an Else Action [S] (https://docs.vizrt.com/viz-artist-guide/3.14/Control_Condition.html , from search summary). **Control Action** runs Viz Engine or Control Object commands when a value arrives, with a "Notify Only When Value Change" option so it fires only when the input differs from the stored value [S] (https://docs.vizrt.com/viz-artist-guide/3.10/Control_Action.html ). **Control Stoppoint** sets the time of a stop point (not usable with Transition Logic scenes) [S].

### 5.3 DataPool plug-ins (a block-like logic set, on the scene tree)

Plug-ins are attached to containers and communicate through named **DataFields** in a shared pool (limited to one channel on one machine) [V] (https://docs.vizrt.com/plugins-user-guide/5.0/Plug-in_Groups.html ).

- Groups: **DataPool**, **Interactive**, **Project Specific**, **Script**. DataPool group includes counters and timers (DataCountDown, DataCounter, DataTimer, DataClock), conditions and logic (DataCondition, DataMath, DataMinMax, DataSelector, DataSwitch), data handling (DataObject, DataNumber, DataParameter, DataReader, DataTable, DataStructure, DataSystem), and actions/animation (DataAction, DataActionTable, DataAnim, DataKeyFrame, DataDirector, DataFeedback) [V]. Interactive group handles mouse and keyboard (DataClick, DataMouseAction and similar) [V].
- **DataCondition**: compares the registered DataField with an argument (less, greater, equal, not equal, True, False, If non-zero, Between; vector compare), and runs an Action when true, optionally an Else Action; **Do Once On Change** makes it fire only when the result flips between true and false [V] (https://docs.vizrt.com/plugins-user-guide/5.0/DataCondition.html ). This is an explicit **edge** option.
- **DataAction**: runs an action whenever the registered DataField changes; an action string starting with 0 is a Viz Engine command, otherwise a DataPool command, several separated by semicolons; expressions can use special variables [V] (https://docs.vizrt.com/plugins-user-guide/5.0/DataAction.html ).
- **DataTimer**: runs an action every Interval milliseconds while Enabled [V] (https://docs.vizrt.com/plugins-user-guide/5.0/DataTimer.html ).
- **DataMath**: operations include add, subtract, multiply, divide, integer divide, modulus, power, AND, OR, cos, sin, random, min, max, average; either argument changing triggers recalculation and the result is written to a named DataField with set decimal places [V] (https://docs.vizrt.com/plugins-user-guide/5.0/DataMath.html ).
- The built-in **Counter** plug-in exposes Number (animate it to count) and Initialize [V] (https://docs.vizrt.com/viz-artist-guide/3.14/Counter.html ).

[I] The DataPool model is **reactive on change** (a DataField changing fires dependents) with an explicit change-only flag, the opposite of XPression's per-frame evaluation.

### 5.4 Viz Script and the Event Editor

- Scripts are per scene or per container (plus shader scripts); a script cannot move between them [V] (https://docs.vizrt.com/viz-artist-guide/5.3/Script_Editor.html ).
- Callbacks shown in the Program Examples: OnInit, OnInitParameters (registers editor parameters), OnExecAction(buttonId) (registered push button pressed), OnEnter and OnLeave and OnLButtonDown (mouse), **OnExecPerField** (every field, for animation and timers), OnGesture, OnTouchTrace, **OnParameterChanged**(name), **OnSharedMemoryVariableChanged**(map, key). Examples use GetParameterInt/Double/Bool/String, a shared-memory Scene.Map with RegisterChangedCallback, and director control by FindDirector with StopAnimation, ContinueAnimation, IsAnimationRunning [V] (https://docs.vizrt.com/viz-artist-guide/5.2/Program_Examples.html ).
- The **Event Editor** lists director events: Stop (halts director and sub-directors until continue), Tag (marker only), Local Stop (this director only), Pause (halts N frames), Next Scene; each has a name, a frame position and a direction setting (both, normal, reverse); event names can be referenced by external commands and scripts [V] (https://docs.vizrt.com/viz-artist-guide/5.2/Event_Editor.html ).

### 5.5 Pilot, Pilot Edge, Template Builder, Trio, Arc

- **Viz Pilot Execution Logic Editor** (Template Wizard): scripts what happens when a Media Sequencer command (Take, Continue, Out) runs on a template's data element, using XML-style tags: `<env>` (context such as channel and timecode), `<viz>` (engine commands), `<ref>` (read a data field), `<relative>` (timed sequence), `<forked_exec>` (execution group). No conditional or branching syntax is described; it replaces the standard behaviour of that command for all elements from the template; it needs control-object-based templates [V] (https://documentation.vizrt.com/viz-pilot-guide/8.8/Execution_Logic_Editor.html ).
- **Template Builder / Pilot Edge scripts**: events onCreate, onLoad, onAfterSave, `fields.$NAME.onChanged` (user edits only; script writes do not fire it), onUpdate (server-side). Fields reached via `vizrt.fields`, with `value`, `readOnly`, `hidden`, `error`, `tip`; field types include text, list (rows with column children), image, video, map (read-only), concept, variant [V] (https://documentation.vizrt.com/template-builder-guide/3.4/Events.html , https://documentation.vizrt.com/template-builder-guide/3.4/Field_Access.html ).
- **Viz Arc** (Viz 3.0 era, released 2026-01-29): an **Actions** panel of buttons made by dragging properties from control channels, tree or directors; a shared **Data Map** that external feeds, scripts and APIs update; playlist items; scripts with OnInit, OnButtonPressed, OnParameterChanged, **OnTimer**, **OnDataMapValueChanged**, PreActionExecute/PosActionExecute, MIDI/DMX/StreamDeck events, and per-template OnCreated, OnShow, OnExecute, OnContinue, OnUpdate, OnOut. `SetParameterRawValue` writes without firing OnParameterChanged, `SubscribeDataMap` subscribes to keys, guideline of at least 100 ms per timer and under 15 timers per template. Data feeds from MQTT, RabbitMQ and NDI metadata land in the Data Map; JSON, XML, Excel/CSV parsing built in [V] (https://documentation.vizrt.com/viz-arc-script-guide/3.0/Scripting.html , https://docs.vizrt.com/viz-arc-user-guide/3.0/Templates.html via search summary). The AI assistant and MCP server are already covered in the market scan.
- Viz Trio and the older Viz Pilot data fields: control-plug-in-defined fields edited by the operator; I did not find a separate Trio logic editor [U].

### 5.6 Vizrt takeaway in one line

Vizrt splits logic into (a) design-time state machines per layer (Transition Logic), (b) reactive per-container plug-ins with named data fields (DataPool), (c) a script language with change callbacks, and (d) a field-schema contract (Control Object) for operators. There is **no single graph** for logic.

## 6. Others, quick

### 6.1 Singular.live
- **Control nodes** expose a widget property to a control app or the REST API so it can be updated without opening the composition; they are created in the Data Interface & Control Panel, and are scoped to the app instance using the composition; a control node at the root acts globally; tables and JSON control nodes exist [S] (https://support.singular.live/hc/en-us/articles/360001029111-Control-Node , 403 to the fetch tool; seen via search summary).
- **Data Streams** are linked to a composition by connecting a stream to control nodes [S] (https://developer.singular.live/data-stream-api/how-to-guides/link-a-data-stream-to-a-composition ).
- **Composition scripting object**: getPayload, getPayload2 (JSON), setPayload, getModel, getDataNode, getLogicLayer, getState, **jumpTo**, **playTo** (named animation states), find, listSubcompositions, sendMessage; scripts have init and close hooks; the reference lists no events [V] (https://developer.singular.live/software-development-kits/graphics-sdk/reference/composition-object , https://developer.singular.live/composition-scripting/quick-start/read-and-update-control-nodes ).
- Top-level subcompositions are the unit of control and required for "Layer Logic" in control apps [S] (https://support.singular.live/hc/en-us/articles/360024397931-Subcompositions-and-Nesting ).
- No node-graph logic editor was found; logic is named animation states plus scripts plus control nodes [I]. The full list of control node types is [U].

### 6.2 Chyron PRIME
- Documentation covers **conditions, events, triggers (trigger list, timeline triggers, control panel triggers), expressions** and an expression builder for point-and-click data parsing; PRIME 4.5 added a "while loop" condition that rescans data sources and collapse nodes for nested data; scripting in VB, JScript, and C# with a C# API including property-changed events [S] (search summary of https://help.chyron.com/hc/en-us/articles/32066193122964-28-Parameters-Expressions-and-Conditions , 403 to the fetch tool; also https://www.sportsvideo.org/2022/06/07/chyrons-prime-4-5-release-eases-shift-to-cloud-based-video-workflow/ ). Condition and trigger semantics were not readable [U]. PRIME is the product closest in spirit to a declarative condition-and-trigger model.

### 6.3 CasparCG HTML templates
- A template is a page that defines global **update**, **play**, **next**, **stop** functions; `CG ADD` loads it (optional play-on-load flag, data as XML or JSON), `CG UPDATE` passes data, `CG INVOKE` calls any other global function [S] (https://chrisryanouellette.gitbook.io/casparcg-html-template-guide/amcp-commands-review ; https://casparcg.com/docs/wiki/media/html-templates ). This is a four-verb lifecycle with no logic editor, useful as the minimal reference contract.

## 7. What GrapiX should take away

### 7.1 Observations that drive the design

1. **Two models exist in the wild.** XPression: continuous per-frame dataflow, with edge and state constructed by hand. Vizrt: reactive on change, with explicit change-only flags (DataCondition "Do Once On Change", Control Action "Notify Only When Value Change"), plus named stop points and layer states. Each has a real failure mode (section 4 versus the single-channel limit of DataPool). GrapiX should state its model explicitly and offer **both level and edge/pulse semantics as first-class outputs**, rather than hoping users assemble them.
2. **The pain in XPression is the missing event semantics** (boolean to director, repeated triggers, ordering against directors). Fix by design: every trigger has a declared kind and every graph has one defined evaluation point per frame relative to timelines.
3. **Property exposure is the heart of both products**: every scene object parameter becomes a port (XPression Object Blocks) or a field/plug-in (Vizrt). GrapiX already shares one vocabulary of actions and events with scripts and the API, so ports should be generated from the same schema, not hand-listed.
4. **Operators need a typed contract** (Control Object fields with identifier, type, min/max, description). In GrapiX this is the published-field schema; the Nodes view should read and write it with the same names.
5. **Repetition is a real use case** (ladders, tables, tickers), and both products handle it clumsily (copy-paste groups; per-row plug-ins). A native list/repeater is a differentiator.
6. **Debuggability matters**: XPression added "show block values" late and users still complain about preview not matching playout. Build a live value overlay and a "step one frame" mode in from the start.

### 7.2 Proposed minimal, original block categories

Proposed names are GrapiX's own and deliberately not borrowed.

| Category | Blocks (proposed role, not final names) |
|---|---|
| **Sources (events in)** | Field changed; field became true / false (edge); field level; counter incremented; external command received; timeline reached marker; timeline finished; element came on air; timer elapsed; data row arrived. |
| **Values** | Constant; field read (any exposed scene parameter or published field); stored value (remembers previous value); random. |
| **Compare and logic** | Equal, not equal, greater, less, between; and, or, not; "changed since last evaluation"; "rising edge", "falling edge", "pulse for N ms" derived from any boolean. |
| **Math** | Add, subtract, multiply, divide, modulo, power, min, max, clamp, map range, round, trig; number to text with a format string. |
| **Text** | Join, format, compare, match against list (returns index), pick by index, length, substring, trim. |
| **Time** | Now, offset, difference, countdown to target, format time, stopwatch/clock with start/stop/reset. |
| **Counters and timers** | Counter (increment, decrement, reset, set), timer (once/interval, enable), delay, debounce, hold. |
| **Flow** | Select by index (in/out), switch, gate (let signal through when true), sequence (fire outputs in order), once-per-event-id filter. |
| **Lists** | Repeater over rows (index, count), sort by value, pick row, add and remove rows, length. |
| **Timeline control** | Play, stop, pause, go to time or marker, play to marker, set speed, direction, cue; output "is playing", "current time", "reached marker". |
| **Property set / get** | One generated block per scene object and parameter: position, scale, rotation, pivot, colour, opacity, visibility, text, material/texture, layer-style parameters, effect parameters; set with optional smoothing. |
| **Field in / out** | Read or write a published field; list field row access; field validation error output. |
| **Data in / out** | Data source row/column read; data subscription; emit an event or value to the API and MCP; log. |
| **Custom script** | A block whose body is JavaScript in the scene's sandbox, with declared typed inputs and outputs and the same action/event vocabulary. |

### 7.3 Shared vocabulary of actions and events

Keep one vocabulary used by the Nodes view, scripts, API and MCP:

- **Actions**: `get(path)`, `set(path, value, options)`; `play(timeline, from?)`, `stop`, `pause`, `goto(marker|time)`, `playTo(marker)`; `cue`, `take`, `out`, `clear` (operator actions that agents never trigger on Program, per the market scan); `field.set`, `field.get`; `list.add/remove/set`; `emit(event, payload)`; `timer.start/stop`; `log`.
- **Events**: `field.changed`, `field.rose`, `field.fell`, `field.pulsed`, `counter.changed`, `timeline.started/finished/markerReached`, `element.online/offline`, `data.rowArrived`, `timer.elapsed`, `command.received`, `error`.
- **Trigger kinds** (declared on every trigger, never implicit): **level** (true while held), **edge** (rising or falling, once per transition), **counter** (monotonic integer; fire once per increase, so a repeat of the same value is still a new event), **pulse** (single-frame event with an optional event id), and **keyed event** (carries an id; duplicates of the same id are ignored, new ids always fire). Counter and keyed event cover the "same score twice" and "repeated elimination" cases that XPression users hack around.
- Every event carries a stable `eventId` and a frame timestamp, never coalescing late or missed frames (consistent with the user's rule on frame.late/missed).

### 7.4 Pitfalls to avoid (each tied to evidence above)

1. **Implicit execution order against timelines.** Make the order a documented constant (for example: ingest data, evaluate graph, advance timelines, render) and show it in the UI. XPression had to add a user checkbox [S][V].
2. **Boolean-to-director without edge semantics.** Never make users build change detection from a compare block and a spare director [S].
3. **Preview that does not match playout.** One-frame previews broke dependent chains in XPression [S]. Preview must run the same evaluator and may step more than one frame.
4. **Per-object copy-paste instead of lists.** Provide a repeater [V][I].
5. **Single-channel or single-machine limits on shared data** (Vizrt DataPool) [V]; shared state in GrapiX must be scoped per scene instance, explicit, and survive output channels.
6. **Silent write loops.** Vizrt needed `SetParameterRawValue` and "script writes do not fire onChanged" to avoid feedback [V]; GrapiX needs per-write origin tags so a node write does not retrigger its own graph, with a visible cycle warning.
7. **Hand-built timers at scale.** Vizrt Arc limits (100 ms minimum, under 15 timers) show cost [V]; GrapiX should have one scheduler with bounded counts and visible telemetry.
8. **Sparse block documentation.** XPression block properties are hard to find publicly [U]. Generate block docs from the same schema that drives the editor and the API.
9. **Contact bounce and duplicate external triggers.** Ross needed a debounce setting on GPI [V]; offer debounce and duplicate suppression as ordinary blocks and as input settings.
10. **Scripts that cannot hold state** (COM objects only live during a run [S]). Give the script block persistent, scoped state and declared ports.
11. **Operator-facing logic mixed with design logic.** Keep the published-field contract separate from internal graph wiring so operators cannot break the design (Control Object versus DataPool).
12. **Agents on air.** Block sets exposed to MCP must exclude take/out/clear and engine configuration, per the existing GrapiX rule.

## 8. Open items (would need the product guides or a licensed install)

- The complete block list and port details from the XPression 12.5/14.0 user guide Visual Logic chapter (PDF too large for the research tool; a local pdftotext pass of the user's copy would settle it).
- Whether XPression has an edge-detect or pulse block, the Counter block's properties, and the exact director-control block name.
- Where XVL data is stored (project, scene, or file) and whether logic can attach per object.
- Chyron PRIME condition and trigger semantics (403 to the fetch tool) and Singular control node type list.
- Vizrt State Transition Animation and Cross Animation pages.
