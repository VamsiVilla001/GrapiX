# Data sources in broadcast graphics: how products connect, manage and refresh external data

Research date: 2026-11-24. Purpose: understanding only, so GrapiX can design its own Data Source Manager (a separate application that holds every external connection and feeds named fields and events to the Editor, Playout and AI models over MCP). Competitor names appear as evidence only; none is proposed for GrapiX. This report does not repeat `visual-logic-research.md` (XPression Visual Logic blocks, Viz DataPool, Singular control nodes) or `market-scan-2026-11-18.md` (feature matrix).

Evidence tags used throughout:
- **[D]** read in official vendor documentation (page fetched or PDF read in full text by me).
- **[S]** seen only in a search-result summary of a page I could not open (403/404), or in a forum thread I could not open. Treat as weaker.
- **[R]** mentioned only in release notes or forums.
- **[U]** unverified: I found no source, or sources conflict.
- **[E]** established engineering practice (standard or widely documented pattern). **[P]** proposal for GrapiX.

Documents actually read (full text) for XPression, with version and date:
| Short name | Document | Version / date | URL |
|---|---|---|---|
| AppNote | XPression DataLinq and Scoreboard Sources, 3500DR-550-01 Rev 2 | September 2025 (current line is XPression 12.5) | https://documentation.rossvideo.com/files/Manuals%20(ARCHIVED%20DO%20NOT%20USE)/CG%20and%20Graphics/XPression/Application%20Notes/XPression%20DataLinq%20and%20Scoreboard%20Sources%20(3500DR-550-01).pdf |
| UG11.5 | XPression User Guide v11.5, chapter 20 "DataLinq" | v11.5, release date printed as 27 Nov 2024 | https://documentation.rossvideo.com/files/Manuals%20(ARCHIVED%20DO%20NOT%20USE)/CG%20and%20Graphics/XPression/User%20Guides/Archive/XPression%2011.5/XPression%20User%20Guide.pdf |
| RN12.5 | XPression v12.5 Product Release Notes | September 2025 | https://documentation.rossvideo.com/files/Manuals%20(ARCHIVED%20DO%20NOT%20USE)/CG%20and%20Graphics/XPression/Release%20Notes/Current%20Release%20Notes.pdf |
| DashNote | Application Note: DataLinq information from DashBoard to XPression | 21 July 2017 | https://documentation.rossvideo.com/files/Manuals%20(ARCHIVED%20DO%20NOT%20USE)/Enterprise%20Control%20Systems/DashBoard/DataLinq%20Information%20from%20DashBoard%20to%20XPression.pdf |

Caveat: the Ross documentation tree has moved into a folder labelled "ARCHIVED DO NOT USE" and the older non-archived URLs return 404. The newest user guide I could read is v11.5 (Nov 2024); the application note and release notes are the newer (Sept 2025, v12.5) documents. Where UG11.5 and AppNote differ, AppNote wins for "what exists today" and UG11.5 wins for "how it is configured". The Ross software-releases page lists 12.5 as the newest version but gave no date for it (https://www.rossvideo.com/products/graphics-and-virtual/software-releases/).

---

## 1. Ross XPression DataLinq

### 1.1 Architecture [D]

- Two parts. The **XPression DataLinq Server** is a separate program (desktop icon / Start menu). It runs on the XPression engine itself or, for larger installations, on one or more other computers. It owns the external connections. **XPression** (Designer/engine) is a client that connects to one or more DataLinq servers through **Project > DataLinq Manager** and binds scene objects to what the servers expose (UG11.5 ch.20; AppNote intro).
- Client-to-server connection: name, host address, port; **default port 8888**; the server shows its port in its title bar and it can be changed under File > Preferences (UG11.5 ch.20, "Connect XPression to a DataLinq Server"; DashNote confirms 8888). A separate GPI input on TCP 7788 in DashNote is unrelated to DataLinq.
- **Failover:** if several servers expose sources with the same name, retrieval fails over to the next server when the primary disconnects; priority is the order in which servers were added to the DataLinq Manager (UG11.5 ch.20, "Start the DataLinq Server"). Forum evidence says clients refer to sources by name only, so swapping a feed means changing the server-side source, not the scene [S] (https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=f285a419-77b0-4195-8389-b1cb07a9258a&CommunityKey=91812bfd-9393-4a3f-8a74-7f8035df130e, "Dynamic Datalinq" thread, seen only via search summary).
- **Who polls:** the server polls or listens; the client queries the server on demand and receives change notifications. Release notes 12.5 say XPression "supports multiple table change notifications from the DataLinq Server" (RN12.5), and the RSS/HTTP source sends updated table names in data change notifications when table presets are on. The exact wire protocol between XPression and the server is not documented in what I read [U].
- Licensing: the render engine needs the "DataLinq option" (AppNote intro). Some sources need a subscription from the data provider (AppNote). A forum thread titled "No Datalinq Licence" exists but I could not read it [U] (https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=16e68e00-5975-4563-9c75-4d79fa552f4b&CommunityKey=91812bfd-9393-4a3f-8a74-7f8035df130e). Ross Voyager also uses a DataLinq Server (brochure listing JSON, XML, RS232, IP statistics interfaces) [S].
- Tessera multiple-engine mode has its own DataLinq section in UG11.5 (not read in detail) [D, title only].

### 1.2 Binding and mapping to scene objects [D] (UG11.5 ch.20)

- Object Inspector > Data Source tab > DataLinq > Set. Pick the source, then **Browse** to choose table, column and row (or type them). Also a `<n>` increment for repeated templates.
- Options on a text object: **Live Update** (push changes into an on-air object), **Entity Decoding** (HTML entities), **Return Empty on Failure** (leave blank if the DataLinq fails), disable font-tag parser, and **Requery scene datalinqs on data page** (changing one field, such as a jersey number, re-queries all other DataLinq fields in the scene).
- **Prepend/Append** strings with `%datalinqkey%` and `@textobject@` macros; "Apply fields even when data is empty" is on by default.
- **DataLinq keys**: parameters substituted into queries or URLs (ADODB keys, XML keys, dynamic URL `%feed%`), set by operator fields, scripts or Visual Logic.
- Other object types (background, quad, sphere, cube, cylinder, torus, slab) bind the same way and can "check datalinq for downloadable asset" (image fetch).
- **Data Pages**: a scene whose published fields are filled and then taken to update another on-air scene.
- Visual Logic has a DataLinq block and, since v11.0, runs during the preparing phase so text it sets can feed queries (from `visual-logic-research.md`, not repeated here).

### 1.3 Source types: official documentation (AppNote Sept 2025, v12.5 era, plus UG11.5 for configuration)

All rows [D] unless stated. "Min build" values come from the AppNote vendor table.

| # | Source type (Ross name) | What it reads | How configured (UG11.5 unless noted) | Refresh model |
|---|---|---|---|---|
| 1 | ADODB | OLEDB, ODBC, Access, Excel and "other databases"; SQL queries inside templates (AppNote). Intro text names Access, MS SQL, Interbase, Firebird, MySQL via ODBC. 12.5 adds MSOLEDB for SQL Server and CSV support (RN12.5) | Connection string or **Select Template** (template list; Excel XLS/XLSX via Jet/ACE seen in support article [S] https://support.rossvideo.com/hc/en-us/articles/360041822052-XPression-DataLinq-Source-ADODB), **Test Connection**, table sorting per table, fixed tables, SQL Query or Table option, compatibility mode (MS SQL for Access/Excel, MySQL, Standard SQL), TOP/LIMIT optimisation, persistent connection, log SQL, max 2000 records shown in browser. A **Browse button** lets a file be picked instead of hand-building connection strings [S] https://www.rossvideo.com/resources/ross-university/the-browse-to-file-button-when-adding-an-adodb-source-to-datalinq/ | **Refresh Every N seconds** (UG11.5). Query results can be cached per query (cache ms). Wrap Indices for looping queries |
| 2 | ASCII | Streamed ASCII over serial RS232, TCP or UDP; fixed-position fields (name, start byte, length, trim); messages up to 4095 bytes (UG11.5). 12.5 adds TCP client mode, table presets for multiple message types per port, per-field in/out parsing, blank-digit replacement (RN12.5) | Fields table | Push (stream) |
| 3 | Text | Delimited text files on disk (CSV/TSV-style) | File path; delimiter, newline, quotation, encoding (ANSI, UTF-8, UTF-16 BE/LE, ISO-8859, UCS2); "Allow reading files currently being written by other applications"; "Ignore empty files (0 bytes)" keeps previous data; strip blank lines | **Wait for file change events** (not recommended for network drives) or **Poll every N seconds** |
| 4 | XML | XML files on disk; DataLinq keys usable (UG11.5 "Using DataLinq Keys with an XML DataLinq") | File path, poll/event mode, XSLT optional for other sources | Same file-watch/poll choice (UG11.5 line for XML source) |
| 5 | JSON | JSON files on disk. 12.5 adds Clear Data button | File path, encoding | File events or **Poll every N seconds** (UG11.5); support article advises Poll on shared drives [S] https://support.rossvideo.com/hc/en-us/articles/360043471291-XPression-DataLinq-JSON-Source |
| 6 | RSS / HTTP (named "RSS Feed" in UG11.5) | HTTP endpoints, RSS, XML, JSON, text; **REST APIs** (AppNote). Auto-detect XML vs JSON from the HTTP Content-Type (UG11.5) | **Static URL** (one URL, refreshed asynchronously, optional table presets so several URLs appear as tables) or **Dynamic URL** with keys (refreshed on demand, with *Cache Results for* ms and *Timeout if no data in* ms). Auth: Basic, API key (query or header), custom headers, body (xml/json/text), **OAuth2** with access/refresh token field mapping and a Test button (UG11.5; OAuth2 for static URLs added in 12.5 per RN12.5; static/dynamic URLs, Basic and OAuth2 introduced across 11.0 and 11.5 per AppNote) | **Update Interval** in ms for static URLs (UG11.5) |
| 7 | WebSocket | Data over WebSocket | Host; format SimpleText, XML (optional XSLT) or JSON; TLS toggle; log incoming messages. 12.5 adds table presets, SChannel, custom header parameters, basic auth dialog, "enhanced connection reliability and dead connection detection" (RN12.5) | Push |
| 8 | XML/JSON TCP | XML or JSON over a socket: **TCP server** (listens), **TCP client** (connects out), or **UDP** listener | Port, IP (client), table presets by path filter, All Data vs Path Data modes, command parsing; 12.5: configurable start/end of message and **Save Last Message** (restores last message per table after a server restart) (RN12.5) | Push |
| 9 | Captioning | Streamed caption data | per AppNote | Push |
| 10 | DashBoard | Parameters from a Ross DashBoard panel (needs DashBoard 6.1+, UG11.5; "Enable Streaming" in the panel; DashNote) | Port shown in DashBoard panel | Push |
| 11 | Stats Perform API | Stats Perform API data | UG11.5 shows an **Update Interval** in ms | Poll |
| 12 | Stats Perform (Out of Town Scores) | Stats Perform scores feed | per AppNote | per AppNote |
| 13 | Genius Live Stream (Genius API Sports); Genius Sports InArena (TCP) | Genius feeds. 12.5 adds American Football to Live Stream | Wrap indices, logging | Push/poll not stated [U] |
| 14 | NBA NGSS | NBA NGSS stats API | AppNote; 12.5 restructured tables | Not stated |
| 15 | NHL Hits | Streamed NHL hits scoreboard feed | AppNote | Push |
| 16 | PGA Meekus WebSocket | PGA Meekus data over WebSocket (new in 12.5) | AppNote, RN12.5 | Push |
| 17 | Raiden | Raiden data (weather forecast tables per RN12.5: separate daily and hourly) | AppNote | Not stated |
| 18 | FairPlay | FairPlay data source | AppNote | Not stated |
| 19 | GSIS | NFL Game Statistics and Information System via a **message queue path and label** (UG11.5); AppNote says GSIS is "now integrated via the XML DataLinq source"; NFL NextGen Stats arrives as REST JSON through the HTTP source | | |
| 20 | Scoreboard and timing hardware: ANC; Amtote (serial); Bodet Scorepad (many sports, 12.5 adds Futsal); Colorado Time Systems; Daktronics (TV Feed database; note: a Dak 5000-style controller needs Daktronics "All Sport CG"); Daktronics RTD (needs sport-specific ITF files from Daktronics); Electro-Mech; OES (football, lacrosse, baseball 7929/ISC9000Std/ISC9000Pro, basketball, hockey, soccer, volleyball, wrestling); SMT Tennis Umpire Clock; Sportech (serial); Swiss Timing (Saturn/Vega, NBA Tissot); Teletimer; Teleview; White Way (basketball, football) | Vendor protocols | Mostly serial/TCP/UDP streams; 12.5 note: Bodet does not support TCP client (RN, via search summary [S]) | Push |
| 21 | **CII Gateway** (not a DataLinq source) | Other sports services through the industry-standard CII protocol with "CII X-Commands for External Data Source use" (AppNote) | | |

Version table (AppNote): Daktronics TV Feed baseball/basketball/football/hockey/soccer/volleyball from 3.10 build 1719; Bodet and Colorado sports from 11.1 builds 5757-5789 and Futsal 12.4 build 6060; Swiss Timing from 4.1/5.9; OES from 4.3 up to 12.4 build 6060 (Curling, Taekwondo); the table in the PDF is garbled by text extraction so individual row-to-version mapping is **[U]**; only the overall range is reliable.

**Google Sheets [D+S]:** supported through the **RSS/HTTP source** since XPression 11.5, with the URL format set to TEXT and the sheet published to the web as CSV (AppNote, "Google Sheets"). A staff reply in 2022 says 11.1 added the text format that makes this work, and some users read Sheets as JSON through the Sheets API URL "with mixed" success; a 2026 thread describes a workaround script that downloads the sheet and converts it to XLSX before a scene goes live [S] (https://rossvideo.community/discussion/google-sheet-support-datalinq, search summary only). Ross University article announcing it: https://www.rossvideo.com/resources/ross-university/google-sheets-as-a-datalinq-source/ [D]. Release 11.5 announcement: https://www.rossvideo.com/company/media/news-releases/xpression-version-11.5-now-available/ [D] (mentions API keys, OAuth2, AES for protected sources).

**Not found in any official Ross document I read (searched the user guide v11.5, application note, release notes 12.5 text for each term):** OData, a native Google Sheets API source (OAuth against Sheets), a PostgreSQL/Oracle/SQLite named driver, MQTT, SSE, GraphQL, Excel Online / SharePoint / OneDrive sources, YAML, INI. Any of these may still work through ODBC drivers or the HTTP source, but that is **[U]**. "ODBC data source such as Access, MS SQL, Interbase, Firebird or MySQL" is the full list of databases Ross names (AppNote intro, UG11.5 compatibility modes MS SQL, MySQL, Standard SQL).

**Mentioned only in forums or release notes [R/S]:**
- Excel via ADODB: forum advice favours the older .xls with the Jet provider; XLSX needs extra drivers described as less stable; Excel file locking when someone has the workbook open ("won't connect if it is open in Excel"); on network shares Windows does not send file-change notifications reliably, so set **Refresh Every** to a nonzero number (Ross staff). Sources: threads "Best Excel Version / Excel Files Locking", "Shared Excel Workbooks", "datalinq - Graphic update automatically" (https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=79e935a3-16a5-41dd-a8ee-adb672c423f2&CommunityKey=91812bfd-9393-4a3f-8a74-7f8035df130e and siblings) [S].
- ENPS to XPression via DataLinq, and DataLinq with MOS plugin (thread titles, not read) [U].
- A Voyager 8.0.5 (July 2026) release note lists a known issue that CSV source data cannot be fetched because of a DataLinq Server issue [S] (https://documentation.rossvideo.com/files/Manuals/CG%20and%20Graphics/Voyager/Release%20Notes/VOYAGER%208.0.5%20RELEASE%20NOTES.pdf). Whether XPression is affected is [U].
- MLB DataLinq has its own installation guide, 3500DR-734-01 [S] (https://documentation.rossvideo.com/files/Manuals/CG%20and%20Graphics/XPression/Installation%20and%20Cabling%20Guides/Installation%20Guides/MLB%20DataLinq%20Installation%20Guide%20%283500DR-734-01%29.pdf).

### 1.4 Refresh, caching, change detection, errors [D unless noted]

| Concern | What XPression does |
|---|---|
| Refresh | Per source type, set on the **server** source: file sources choose OS file-change events or poll N seconds; ADODB Refresh Every N seconds; HTTP Update Interval ms (static) or on-demand (dynamic); streams are push |
| Cache | Per-query result cache in ms (dynamic URL, Stats Perform API); ADODB "cache results to disk" for looping queries (GSIS panel); XML/JSON TCP "Save Last Message" survives a server restart (12.5) |
| Change detection | Client gets change notifications from the server; 12.5 supports notifications for multiple tables; Live Update flag on each bound object decides whether an on-air object follows the change; "Requery scene datalinqs on data page" for dependent fields. File sources have no content hash; "ignore empty files" keeps the last good data |
| Stale data | No staleness indicator or age field was found in documentation [U]. The only protection seen is last-good retention on empty file and dead-connection detection on WebSocket (12.5) |
| Errors | Server log window with per-source "Enable Logging" and "Log SQL Queries" checkboxes; Test Connection and Test (OAuth) buttons at setup; client option "Return Empty on Failure" leaves a field blank |
| Triggers | Data changes drive Visual Logic (DataLinq block) and **OnSetText** (v11.5, from the other report); there is no first-class "row arrived" event [I] |
| On-air safety | The Viewport only shows live changes when rendering continuously, per forum answers [S] |
| Known complaints [S/R] | Excel locking and network-share update misses (above); XLSX driver instability; an intermittent blank page after `RefreshDatalinqs` is a reported bug (thread "Xpression plug-in refreshing SQL data queries", https://rossvideo.community/communities/community-home/digestviewer/viewthread?MessageKey=1f98b60d-d0dc-45d9-bdce-af61d1d64c77&CommunityKey=91812bfd-9393-4a3f-8a74-7f8035df130e); "DataLinq not updating across computers" thread exists (not read) |

### 1.5 Practical reading of Ross's design for GrapiX

The strengths are the server/client split with named sources, failover by same-named sources, per-object Live Update choice, and keys for parameterised queries. The weaknesses (all inferred from documentation, not claimed by Ross) are: configuration is per source with different dialogs, no unified schema or health model, no age/staleness field, refresh logic differs by source type, and file-lock handling is left to the operator.

---

## 2. What is "Wizard"?

**I could not identify it with evidence.** Searches and text checks performed:

| Candidate | Evidence | Result |
|---|---|---|
| A DataLinq setup wizard in the Ross DataLinq Server | The words "wizard" appear **zero times** in the XPression User Guide v11.5 (15,092 lines of extracted text), the DataLinq application note (Sept 2025), the 12.5 release notes, and the DashBoard-to-XPression application note | Not found |
| A Ross web-based data tool | Searches on documentation.rossvideo.com, rossvideo.com, support.rossvideo.com and rossvideo.community for "Wizard" with DataLinq/XPression/DashBoard/Voyager returned only DataLinq docs and the ADODB "Browse" file picker (which removes hand-written connection strings, but it is not called a wizard) | Not found |
| Ross DashBoard / Voyager / Tessera data features | Search results listed DashBoard guides and the Voyager brochure; no wizard | Not found |
| Flowics data setup (cloud) | Flowics Google Sheets Data Provider and JSON Push Connector pages exist, no product called Wizard (https://blog.flowics.com/google-sheets-support-as-a-data-source-for-cloud-graphics) | Not Wizard |
| Singular Google Sheets / Data Stream | No Wizard (https://support.singular.live/hc/en-us/articles/360039666131-Google-Sheets-Widget) | Not Wizard |
| Third-party "setup wizards" for Google Sheets (Databox, Power Apps, etc.) | Show up in searches but have no link to XPression (https://databox.com/track-visualize-data-from-google-sheets-easily-with-new-setup-wizard) | Unrelated |
| Generic .NET/Microsoft data source configuration wizards (Telerik, DevExpress, Visual Studio) | Appear in searches, are developer tools | Unrelated |

Conclusion: "Wizard" is not a documented Ross or XPression product, DataLinq feature, or Ross web app as of this research. It may be a name used internally by the owner's team or a third-party/customer tool, a feature newer than the documentation I could reach, or a vendor name I did not search. To resolve it I need the owner to provide a URL, a vendor name, or a screenshot. **Do not design against it until confirmed.**

---

## 3. Other products

Evidence is from the pages listed. Anything not stated by the page is marked [U].

### 3.1 Vizrt

| Aspect | Findings |
|---|---|
| Product that holds connections | **Viz Data Center** (user guide 2.0 to 2.4). I found no current product called "Viz DataHub"; search for it returned an unrelated open-source project, so treat that name as [U] for Vizrt |
| Dataset providers (2.3/2.4) | Manual (typed key/values), File (reads and monitors files), Replicator (copy a dataset from another Data Center), Sportzcast (Genius Sports stadium scoreboards), Vectar (a DataLink source configured in Viz Vectar), Kafka (broker), Rest Webserver, Fluid Data Services, Stats Perform, Viz Data Connectors (needs a Viz Flowics account and the Flowics Middleware), Socket Listener (UDP or TCP), Socket Connector (connect to TCP server), Tracab, Sportec Solutions. Sources: https://documentation.vizrt.com/datacenter-user-guide/2.3/Supported_Providers.html and https://docs.vizrt.com/datacenter-user-guide/2.4/Configuring_Datasets.html [D] |
| Rest Webserver | **Polling (s)** field (unit differs by version: milliseconds in 2.0, seconds in 2.1); auth types X-API-Key header, custom header key, Bearer, query parameter, append to base address (2.1); no documented default, response format or error handling on that page. https://documentation.vizrt.com/datacenter-user-guide/2.1/Rest_Webserver.html [D]; 2.0 comparison https://docs.vizrt.com/datacenter-user-guide/2.0/Rest_Webserver.html [S] |
| Operator/designer sees | Datasets with entries that can be filtered, enabled/disabled, inspected; a Performance Dashboard for live data (2.4 page headings) [D] |
| Newsroom path | MOS metadata container (MosExternalMetadata) and template-name translation in Viz Mosart; story values matched by XML element name (https://docs.vizrt.com/viz-mosart-admin-guide/5.7/Newsroom_Settings_Editor.html) [S] |
| Pilot | Pilot Data Server exists (guide PDS-8.3, https://documentation.vizrt.com/pilot-data-server-guide-8.3.pdf), not read [U] for detail |
| Not found | WebSocket as a Data Center input; webhook input; per-dataset staleness |

### 3.2 Singular.live

| Aspect | Findings |
|---|---|
| Data Streams | Direct WebSocket connection, low latency below 300 ms (REST about one second), intended for 1 Hz or faster updates; payload persists until replaced, a newly connected client receives the latest payload immediately; backend adds a UTC timestamp so clients can compute age. https://developer.singular.live/data-stream-api/introduction [D]. Linked to a composition by connecting a stream to control nodes (https://developer.singular.live/data-stream-api/how-to-guides/link-a-data-stream-to-a-composition, from the earlier report) |
| Google Sheets widget | "Request every N sec" setting; Google quota of 60 requests per 60 seconds per API key is the constraint; row selection manual or sequenced at an interval so rows become a ticker; widget emits a JSON message at each call per a user comment (not in official docs). https://support.singular.live/hc/en-us/articles/360039666131-Google-Sheets-Widget [S]; related https://support.singular.live/hc/en-us/articles/4409448379161-Using-Google-Sheets-with-uno-Apps [S] |
| Other | REST into Data Nodes exists (account analytics track data sent via REST) [S]; Excel/CSV as live sources not found [U] |
| Auth | Not stated in pages read [U] |

### 3.3 Chyron PRIME

| Aspect | Findings |
|---|---|
| Table resource | PRIME 4.9 table resource reads text files, standard Excel files, web-based JSON data and online databases (https://chyron.com/prime-platform-4-9-release/) [D]; JSON custom query, collapse nodes, "while loop" condition added in 4.5 (https://chyron.com/json-data/) [S] |
| Operator/designer | Data Object guide v4.10.11 (Dec 2025): three-step panel: pick a source, connect to a data set, optional filter; unsupported filters are disabled automatically [S] (https://help.chyron.com/hc/en-us/article_attachments/44493742465940). **Duplicate Effect** links one element to a data-set entry and clones it so each copy binds to the next row (4.9) [D] |
| Sports | Direct connections to SMT data applications; filter unwanted values before they reach graphics (4.9) [D] |
| MOS / CAMIO | PRIME 4.7 passes XMP data-binding through MOS for replaceable scene elements with CAMIO (https://chyron.com/prime-4-7/) [S] |
| Not found | Polling, caching and fallback behaviour; XML or REST connector documentation [U] |

### 3.4 CasparCG with SPX-GC (and similar HTML controllers)

| Aspect | Findings |
|---|---|
| Template contract | Page defines update/play/next/stop; `CG UPDATE` passes data as XML or JSON (from the earlier report) |
| SPX-GC data | Template definition declares a `dataformat` (xml or json); CSV import/export of template rows with UTF-8 (docs.spx.graphics article 9523741 and 9523743, https://docs.spx.graphics/en/articles/9523743-spx-gc-template-definition-v1) [S]; release notes 1.0.7 mention Excel reading for templates via ajax, with a demo ticker template (https://github.com/TuomoKu/SPX-GC/blob/master/RELEASE_NOTES.md) [S]; local REST: `POST /api/v1/saveCustomJSON` and `GET /api/v1/feedproxy` on port 5656 (https://apis.io/apis/spx/spx-data-api/) [D] |
| Polling vs push | Templates run in the HTML renderer and fetch themselves; there is no central source manager [I] |
| Not found | Native Google Sheets, MQTT or WebSocket source in SPX-GC [U] |

### 3.5 Flowics (now "Viz Flowics")

| Aspect | Findings |
|---|---|
| Sources | Pull from REST APIs, push JSON, stream via WebSockets; "80+" native data-provider connectors (https://flowics.com/overview) [S] |
| Google Sheets | A Google Sheets Data Provider (initially needs a manual sync), a JSON Push Connector fed by an Apps Script in the sheet to avoid manual sync, and a Graphics Control API that can sync from a sheet; sheets also work as an editing surface for augmentations (round-trip export/import). https://blog.flowics.com/google-sheets-support-as-a-data-source-for-cloud-graphics, https://support.flowics.com/en/articles/8873422-integrating-google-sheets-data-into-flowics-graphics-using-the-json-push-connector [S] |
| Others | Viz Data Center can consume Flowics data through a Middleware (see 3.1) |

### 3.6 vMix (useful as a simple baseline)

vMix "Data Sources" support Excel/CSV (XLSX, XLS, ODS, CSV, HTML, PDF and XPS tables), Google Sheets (shared "anyone can view", Google API key required), RSS, Text, XML (XPath) and JSON (object array, each element a row), plus Zoom Chat; refresh intervals are not stated on that page. https://1.vmix.com/help28/DataSourcesTypes.html [D]

### 3.7 Sportradar (provider-side evidence for push semantics)

Push feeds use one long-lived HTTP GET carrying JSON, heartbeats (5 s on the tennis guide) as the health signal, REST kept as a catch-up fallback; reconnect replay is documented inconsistently (one page says resume within 10 minutes, others say none); call REST first for the full current state; a Simulations tool replays games over REST and push. https://developer.sportradar.com/football/docs/nfl-ig-push, https://developer.sportradar.com/baseball/docs/mlb-ig-push, https://developer.sportradar.com/getting-started/docs/simulations [S]

### 3.8 Comparison summary

| Capability | XPression | Vizrt Data Center | Singular | Chyron PRIME | SPX/Caspar | Flowics |
|---|---|---|---|---|---|---|
| Central connection holder | DataLinq Server (separate process) | Data Center | Cloud account | In-app Data Object | None (template-side) | Cloud account |
| WebSocket in | Yes [D] | Not found [U] | Yes, Data Stream [D] | Not found [U] | Not found [U] | Yes [S] |
| REST poll | Yes, interval ms [D] | Yes, Polling field [D] | Yes (Data Node) [S] | Web JSON [D] | Feed proxy [D] | Yes [S] |
| Webhook/push HTTP | No documented webhook [U] | Not found [U] | Data Stream API [D] | Not found | Not found | JSON Push [S] |
| Message broker | No MQTT [U] | Kafka [D] | n/a | n/a | n/a | n/a |
| Socket TCP/UDP | Yes (ASCII, XML/JSON TCP) [D] | Yes [D] | n/a | n/a | n/a | n/a |
| Excel / CSV | ADODB, Text, CSV (12.5) [D] | File dataset [D] | Not found [U] | Excel/text [D] | CSV/Excel [S] | via Sheets |
| Google Sheets | via published CSV URL [D] | Yes (listed) [D] | Widget, polled [S] | Not found [U] | Not found [U] | Provider + push [S] |
| Databases | ADODB/ODBC [D] | Not found [U] | Not found [U] | "Online databases" [D] | none | none |
| Failover | Same-name sources across servers [D] | Replicator dataset [D] | Cloud | Not found | none | Cloud |
| Staleness shown | Not found [U] | Performance dashboard [D] | Timestamp on payload [D] | Not found | none | Not found |

---

## 4. Source types in depth

| Source | How it works | Practical constraints and guidance | Basis |
|---|---|---|---|
| **WebSocket** | Persistent full-duplex connection; text or binary messages (RFC 6455, https://www.rfc-editor.org/rfc/rfc6455) | No built-in message id, replay or ordering across reconnects; need ping/pong and an application heartbeat; reconnect with backoff and jitter; ask provider for a snapshot or sequence number on reconnect. XPression added "dead connection detection" in 12.5 (RN12.5); Sportradar uses heartbeats and says REST must catch up (3.7) | [E]; vendors [D/S] |
| **SSE (Server-Sent Events)** | One-way text stream over HTTP | Spec defines `id` and the `Last-Event-ID` header for resume, a `retry` field for reconnect delay, HTTP 204 to stop reconnecting, and comment lines about every 15 s to keep proxies open; many streams to one host hit browser HTTP/1.1 connection limits. Replay only works if the server keeps history. https://html.spec.whatwg.org/multipage/server-sent-events.html | [D] |
| **HTTP/HTTPS polling** | Timer-driven GET | Use ETag/If-None-Match or Last-Modified where offered; rate limits (PandaScore: documented hourly cap and a remaining-requests header, https://developers.pandascore.co/docs/rate-and-connections-limits [S]); do not poll faster than the provider updates (Daktronics advises the read interval not be faster than file delivery [S], https://www.daktronics.com/en-us/support/kb/DD4551404); backoff on 429/5xx; honour timeouts. XPression exposes interval, cache time and timeout fields (1.3) | [E]; [D] |
| **Webhooks** | Provider POSTs on change to your URL | Needs a reachable endpoint (tunnel or relay for a desktop app), signature check, idempotency (retries duplicate), ordering not guaranteed, no replay unless provider stores it. A cloud relay is the usual fix. Microsoft Graph subscriptions are the example of lifecycle needs: expire in under 30 days for OneDrive driveItem, must be renewed, changes during a lapse are lost and must be recovered with a delta query. https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events, https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance | [D] for Graph; [E] otherwise |
| **MQTT** | Broker-based publish/subscribe | OASIS v5.0 (7 Mar 2019): retained messages deliver the last value on subscribe (zero-byte retained payload clears it), Last Will message announces unclean disconnect, QoS levels and keep-alive exist. Fits sensors, tally/state, venue systems. Topics become natural field names. https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html | [D] |
| **SQL databases** | Query on a timer, or notification | Use a **read-only account**, a view, and a bounded query (row limit). Change detection options: timestamp or incrementing key column; PostgreSQL LISTEN/NOTIFY (payload under 8000 bytes, send the row key not the data, https://www.postgresql.org/docs/current/sql-notify.html); SQL Server change tracking/CDC (not sourced here [U]). ADODB/ODBC in XPression polls with Refresh Every and a persistent-connection option. Avoid long transactions and locking | [D/E] |
| **Excel files** | Read as a database (ADODB) or parse XLSX | Open-in-Excel locking, network-share notification gaps, XLSX driver issues (1.3, forum evidence [S]). Prefer reading a **copy** or a CSV export; poll mtime plus size, not file-change events, on network paths. OneDrive/SharePoint: use Microsoft Graph delta and subscriptions (above) rather than a synced folder when possible | [S]/[E] |
| **Google Sheets** | Published CSV URL, or Sheets API | API quotas: 300 read requests per minute per project and 60 per user per project, HTTP 429 beyond that, exponential backoff with jitter up to 32-64 s (https://developers.google.com/workspace/sheets/api/limits). Singular documents 60 per 60 s per API key for its widget. Published-to-web CSV is cached by Google and lags. Apps Script installable edit triggers give push-like behaviour, but run as the creator, not in view mode, and are not fired by script or API edits (https://developers.google.com/apps-script/guides/triggers/installable); Flowics uses this pattern for JSON push [S]. Exceeding quotas is planned to be billable later in 2026 per the limits page | [D] |
| **CSV/JSON/XML files** | File watch or poll | Encoding (UTF-8/16 BOM), half-written files (XPression offers "read files being written" and "ignore empty files"), atomic replace, locking. Prefer write-to-temp then rename on the producer side | [D]/[E] |
| **Manual tables** | Operator types rows | Needed when no feed exists (Flowics volleyball example); must be versioned and audited | [S]/[P] |
| **Recorded feeds for replay** | Store raw messages with timestamps and replay them | Sportradar Simulations replays real games over REST and push; XPression saves only the last message ("Save Last Message") | [S]/[D] |

---

## 5. Catalogue 1: Every data source type in the Ross XPression DataLinq server (as of Sept 2025, v12.5 era)

Status key: **O** = documented in official Ross docs I read; **R** = release notes or forums only; **U** = unverified or not found.

| Source | Status | Doc basis (version, date) | Configured how | Refreshed how |
|---|---|---|---|---|
| ADODB / OLEDB / ODBC (Access, MS SQL, MySQL, Firebird, Interbase, Excel) | O | AppNote Sept 2025; UG11.5 (27 Nov 2024) | connection string or template, SQL or table, sort, fixed tables | Refresh Every N s; cache; persistent connection |
| Named ODBC databases: Access, MS SQL, Interbase, Firebird, MySQL | O (names from AppNote intro) | AppNote Sept 2025 | via ODBC drivers installed on the DataLinq machine | as above |
| MS SQL via MSOLEDB | O (release notes) | RN12.5 Sept 2025 | ADODB template | as above |
| PostgreSQL, Oracle, SQLite, NoSQL, Redis | U | not named anywhere | possibly through installed ODBC drivers | n/a |
| Excel XLS / XLSX / workbook | O (via ADODB; "Excel" in UG diagram) plus R (forum behaviour) | UG11.5, support article, forum | ADODB template "Excel" using Jet/ACE; Browse to file | Refresh Every N s |
| CSV | O (ADODB CSV support in 12.5; Text source) | RN12.5; UG11.5 | Text source or ADODB CSV | Text: file events or Poll N s |
| TXT / delimited text | O | UG11.5, AppNote | Text source | as above |
| ASCII stream (serial, TCP, UDP, fixed fields) | O | UG11.5; RN12.5 | field table by byte offset | push |
| XML file | O | UG11.5 | file path, keys | file events or Poll N s |
| JSON file | O | UG11.5; RN12.5 | file path | file events or Poll N s |
| REST / HTTP / HTTPS (XML, JSON, text, RSS) | O | AppNote Sept 2025; UG11.5 | static or dynamic URL; Basic, API key, OAuth2, headers, body | Update Interval ms / on demand; cache and timeout |
| RSS | O | UG11.5 ("RSS Feed" source); AppNote | URL | Update Interval ms |
| Atom | U | not named | possibly through the RSS/HTTP XML mode | n/a |
| Google Sheets | O (as published CSV or text through HTTP source) | AppNote; 11.5 news release (https://www.rossvideo.com/company/media/news-releases/xpression-version-11.5-now-available/) | Share to Web as CSV; URL setting TEXT | HTTP Update Interval |
| OData | U | not found | n/a | n/a |
| WebSocket | O | UG11.5; RN12.5 | host, format, TLS, headers | push |
| XML/JSON over TCP (server, client) or UDP | O | UG11.5; RN12.5 | port, table presets | push |
| SSE, MQTT, OSC, GraphQL | U | not found | n/a | n/a |
| DashBoard | O | DashNote 21 Jul 2017; UG11.5 | DashBoard "Enable Streaming" port | push |
| GSIS (NFL) via message queue; NFL NextGen Stats via HTTP JSON | O | UG11.5; AppNote | queue path, label | stream |
| Captioning stream | O | AppNote | | push |
| Scoreboards and timing vendors | O | AppNote, UG11.5 | vendor panels | push |
| Names: ANC, Amtote, Bodet Scorepad, Colorado Time Systems, Daktronics (TV Feed), Daktronics RTD (ITF files from Daktronics), Electro-Mech, OES, SMT Tennis Umpire Clock, Sportech, Swiss Timing, Teletimer, Teleview, White Way | O | AppNote | | |
| Sports and data services: Stats Perform, Stats Perform API, Genius Live Stream, Genius InArena, NBA NGSS, NHL Hits, PGA Meekus WebSocket, FairPlay, Raiden (weather) | O | AppNote; RN12.5 | | polling interval for Stats Perform API; others stream or not stated |
| CII Gateway (other sports services) | O (separate gateway, not a DataLinq source) | AppNote | CII X-Commands | n/a |
| SMS servers | O (mentioned in intro) | AppNote intro | not described in what I read | n/a |
| Multi-server failover | O | UG11.5 | same-named sources | automatic |
| MOS / ENPS to XPression via DataLinq | R | forum thread titles | not read | n/a |

Product version: latest listed XPression is 12.5 (Sept 2025). The user-guide text I could read for configuration is v11.5 (27 Nov 2024); items added in 12.0-12.5 are taken from the 12.5 release notes only.

---

## 6. Catalogue 2: External source types and formats across broadcast graphics (adapter checklist)

"Common" = whether broadcast graphics products commonly support it, judged from the vendor pages above; [U] where unsourced. Method: **poll**, **push**, **watch** (file), **session** (connection held open).

### 6.1 Live streams and protocols

| Source | Read how | Typical constraints | Common in broadcast? | Basis |
|---|---|---|---|---|
| WebSocket | push, session | reconnect, heartbeat, no standard replay | Yes (XPression, Singular, Flowics) | [D] |
| SSE | push, session | `Last-Event-ID` resume only if server keeps history | Not seen in broadcast products I checked [U] | [D] spec |
| HTTP/HTTPS polling | poll | rate limits, ETag, clock skew | Yes | [D] |
| HTTP long-lived stream (Sportradar push) | push, session | heartbeat is health signal; no consistent replay | Provider-specific | [S] |
| Webhooks | push | needs reachable endpoint, signatures, idempotency | Rare directly; via relay (Flowics JSON Push) | [S] |
| MQTT | push, session | broker needed; retained values on subscribe | Not seen in broadcast products I checked [U] | [D] spec |
| TCP/UDP text (ASCII, XML/JSON) | push, session | framing (start/end markers), message size limits (4095 bytes in XPression ASCII) | Yes | [D] |
| Serial RS232 (scoreboards, Daktronics RTD, TV Truck 9600-8-N-1 per a community post) | push | baud and format, needs adaptor; vendor ITF/format files | Yes (sports) | [D]/[S] |
| OSC | push (UDP), also TCP framing in 1.1 | address patterns with wildcards, bundles with time tags; no delivery guarantee over UDP | Seen in CasparCG status output (from the earlier report) [S] | [D] https://opensoundcontrol.stanford.edu/spec-1_0.html |
| GPI / GPO | push (contact) | hardware; Ross has "Smart GPI/RossTalk" over TCP 7788 in DashNote | Yes | [D] |
| MOS | session, TCP, XML | MOS lower port 10540 (NCS accepts) and upper port 10541 (device accepts), two sockets per port; message families such as roCreate; v4.0 June 2019 | Yes (newsroom) | [S] https://mosprotocol.com/wp-content/MOS-Protocol-Documents/mosv26.htm and https://en.wikipedia.org/wiki/Media_Object_Server |
| NDI metadata | push, in band | UTF-8 NULL-terminated XML frames; reserved "NDI" namespace; receivers should tolerate malformed XML | Rare for data into graphics [U] | [S] https://docs.ndi.video/all/developing-with-ndi/metadata |
| Kafka | session | broker config, partitions | Viz Data Center only that I found | [D] |

### 6.2 Databases

| Source | Read how | Constraints | Common? | Basis |
|---|---|---|---|---|
| ODBC/OLEDB generic (Access, MS SQL, MySQL, Firebird, Interbase) | poll | driver install, bitness, record limit, sorting | Yes in XPression | [D] |
| PostgreSQL | poll or LISTEN/NOTIFY | NOTIFY payload under 8000 bytes | Not named by any graphics vendor I read [U] | [D] https://www.postgresql.org/docs/current/sql-notify.html |
| MySQL, SQL Server, Oracle, SQLite | poll | read-only user, view | MySQL, SQL Server via XPression; Oracle and SQLite [U] | [D]/[U] |
| "Online databases" | poll | not detailed | Chyron PRIME 4.9 | [D] |
| NoSQL, Redis | poll or pub/sub | | Not seen in broadcast graphics [U] | [U] |

### 6.3 Spreadsheets and workbooks

| Source | Read how | Constraints | Common? | Basis |
|---|---|---|---|---|
| XLSX / XLS | poll or watch | locking, network share notification gaps, driver issues | Yes (XPression, vMix, Chyron, SPX) | [D]/[S] |
| ODS | poll | | vMix lists ODS | [D] https://1.vmix.com/help28/DataSourcesTypes.html |
| Google Sheets | poll (quota), Apps Script push | 300/min per project, 60/min per user | Yes (XPression, Singular, Flowics, vMix) | [D] |
| Excel Online / OneDrive / SharePoint | Graph delta + subscriptions | subscription renewal under 30 days, lost changes during lapse | Not documented in any graphics vendor page I read [U] | [D] Graph |

### 6.4 Flat files

| Format | Read how | Constraints | Common? | Basis |
|---|---|---|---|---|
| CSV / TSV / TXT delimited | watch or poll | encoding, quoting, half-written files | Yes | [D] |
| Fixed-width | parse with offsets | byte positions (XPression ASCII) | Yes for streams | [D] |
| JSON, NDJSON | watch/poll; NDJSON for streams | encoding; NDJSON support in graphics products [U] | JSON yes | [D]/[U] |
| XML (with XSLT/XPath) | watch/poll | schema mapping | Yes (XPression XSLT, vMix XPath) | [D] |
| YAML, INI | watch | not seen in broadcast graphics vendors [U] | | [U] |

### 6.5 Sports and esports

| Source | Read how | Constraints | Common? | Basis |
|---|---|---|---|---|
| Daktronics TV Feed / RTD / Data Studio | serial, UDP, TCP | RTD needs sport files from Daktronics; Dak 5000 controllers need an All Sport CG interface | Yes | [D] AppNote; [S] https://www.daktronics.com/en-us/support/kb/DD3548658 |
| Genius Sports (Live Stream, InArena, Sportzcast) | push/API | subscription | Yes (XPression, Viz) | [D] |
| Stats Perform / Opta | REST, WebSocket, push, pull, S3; JSON or XML; OAuth for developer API; one case study says up to 2,000 updates per match | account manager access; F24 schema not verified | Yes (XPression, Viz) | [S] https://www.statsperform.com/data-feeds ; F24 [U] |
| Sportradar | REST plus long-lived HTTP push; JSON | realtime plan for push; replay inconsistent | Not named in graphics vendor docs I read [U] | [S] |
| Tracab, Sportec | via Viz Data Center | | Viz | [D] |
| SMT | direct connection in Chyron PRIME 4.9; SMT Tennis Umpire Clock in XPression | | Yes | [D] |
| Bodet, OES, Swiss Timing, Colorado Time Systems, White Way, ANC, Electro-Mech, Teletimer, Teleview, Sportech, Amtote | vendor serial/TCP | | XPression | [D] |
| NBA NGSS, NHL Hits, NFL GSIS and NextGen Stats, PGA Meekus, FairPlay | API or stream | licence | XPression | [D] |
| PandaScore (esports) | REST plus WebSocket (`wss://live.pandascore.co`), WebSocket opens 15 minutes before match; WebSocket does not count against REST limit; free plan 1000 requests per hour per secondary sources; live feed on a higher plan | plan gating | Not named in graphics vendor docs [U] | [S] https://developers.pandascore.co/docs/rate-and-connections-limits ; https://developers.pandascore.co/docs/websockets-overview |
| Game publisher APIs (Riot, Valve, etc.) | REST | not researched [U] | | [U] |
| IPTC SportsML-G2 | XML carried inside NewsML-G2; fixtures, results, standings, statistics, match actions; keys plus a resource file | schema size; SportsML 3.0 released July 2016 | Standard for agencies; graphics support not verified [U] | [S] https://iptc.org/std/SportsML/guidelines/ |
| NewsML-G2 | XML news item envelope | | Agency standard [U] for graphics | [S] https://dev.iptc.org/G2-Standards |
| CII protocol | gateway | | XPression | [D] AppNote |

### 6.6 Newsroom and rundown

| Source | Read how | Constraints | Common? | Basis |
|---|---|---|---|---|
| MOS (NCS to graphics) | session TCP XML | see 6.1; metadata container `MosExternalMetadata` and template-name mapping | Yes | [S] Viz Mosart guide; MOS documents |
| ENPS | MOS plugin; NRCS MOS ID and host address in plugin settings (Xpression) | | Yes | [S] https://nccnewslinks.syr.edu/wp-content/uploads/2019/02/XPRESSION-GRAPHICS-2019.pdf |
| Avid iNEWS | MOS, form fields exposed by NRCS names | | Yes | [S] Viz Mosart guide, Grass Valley Xnews manual https://www.grassvalley.com/docs/Manuals/graphics/vertigo_suite/M852-0900-550_Vertigo_Suite_Xnews_User_Manual_v5.5.pdf |

### 6.7 Tickers, weather, finance, media metadata

| Source | Read how | Constraints | Common? | Basis |
|---|---|---|---|---|
| RSS | poll | interval, caching, entity decoding | Yes (XPression, vMix, Ross crawls) | [D] |
| Atom | poll | | [U] | [U] |
| Weather | REST/JSON | XPression Raiden source has daily and hourly forecast tables | Yes (XPression) | [D] RN12.5 |
| Finance / market data | REST or WebSocket | licence, delay vs real-time | Not documented in sources read [U] | [U] |
| Captions | stream | | XPression | [D] |
| EDL, CSV of clips, MXF/clip metadata | file read | not found in any graphics vendor data-source page [U] | | [U] |
| XMP data binding | via MOS | CAMIO + PRIME 4.7 | [S] https://chyron.com/prime-4-7/ | |

---

## 7. Design implications for GrapiX (original proposal)

Mark: **[E]** established practice seen in the sources, **[P]** proposal.

### 7.1 Shape

A separate **Data Source Manager (DSM)** process with a local control port and an MCP server. It owns every connection. The Editor, Playout, AI models and external tools are **clients** that subscribe to named **fields** and **events**. [E for split: XPression server/client, Viz Data Center, Singular data streams.] [P: single binary, local-first.]

### 7.2 Feature list

| # | Feature | Notes | Status |
|---|---|---|---|
| 1 | **Source registry** with stable ids, names, type, owner, tags, enabled flag, version, last-change record | Same-name failover (XPression) as one policy among others | [E]/[P] |
| 2 | **Adapters in a sandbox** (separate process or WASM with capability list: hosts, ports, file paths, time budget, memory) | A bad parser must not crash or stall playout. XPression runs sources in a server process, but isolation per adapter is not documented | [P] |
| 3 | Adapter families: file (CSV, TSV, TXT, JSON, NDJSON, XML, XLSX), HTTP poll, SSE, WebSocket, webhook receiver (with optional relay), MQTT, TCP/UDP framed text, serial, SQL (read-only), Google Sheets, Graph/OneDrive, manual table, replay | Order by the catalogue above: first ones with strongest evidence of use (file, HTTP, WebSocket, TCP/UDP, serial, Sheets, Excel, SQL) | [E] set / [P] ordering |
| 4 | **Schema discovery**: sample the source, infer fields and types, let the designer confirm; for sheets, headers; for JSON, paths; for SQL, columns | Chyron's connect-then-filter panel and XPression's Browse dialog are the same idea | [E]/[P] |
| 5 | **Mapping layer**: per source, rename, coerce type, format, default, unit, lookup, join, path/XPath/column | Keep it declarative and diffable. XPression's prepend/append and keys are the minimum | [E]/[P] |
| 6 | **Normalisation to fields and events**: a field is a named current value with type, unit, timestamp, quality; an event is a timestamped fact (row arrived, value changed, goal scored, connection lost). Rows/tables are first-class so Chyron-style "duplicate per row" binding works | | [P] |
| 7 | **Change detection** per source: file mtime+size+hash, ETag/Last-Modified, row hash, sequence number, DB key/timestamp. Emit `changed` only on real difference; separate "polled, same" from "changed" | XPression relies on OS file events and notifications; shared-drive failures are a known complaint | [E]/[P] |
| 8 | **History and recording**: ring buffer per source plus raw-message log with timestamps and sequence; export as replayable file | Sportradar Simulations is the model for replay | [E]/[P] |
| 9 | **Simulator**: replay a recording at 1x or faster, step, loop, inject faults (gap, duplicate, late, malformed, disconnect), manual field override | Lets the Editor and AI test without live feeds | [P] |
| 10 | **Health and staleness**: per source state (connecting, live, degraded, stale, failed), last-message age, per-field age, expected cadence, thresholds that the designer sets per field | Singular adds a UTC timestamp to every payload so clients can compute age; XPression shows none [U] | [E]/[P] |
| 11 | **Last-good cache**: persist last accepted value per field (and last raw message), restored after restart with a "restored" quality flag | XPression "Save Last Message", "ignore empty file", "Return Empty on Failure" are partial versions | [E]/[P] |
| 12 | **Credentials**: store secrets in the OS credential store, never in project files; references by id; per-source scopes; rotation; OAuth2 token refresh handled in the DSM (XPression has an OAuth2 token-mapping dialog; Google and Graph need it) | Redact in logs and MCP output | [E]/[P] |
| 13 | **Access control and audit**: roles (admin, designer, operator, AI agent); per-source and per-field visibility; write actions (manual override, source edit) audited with who/when/what; AI models read-only by default | | [P] |
| 14 | **Versioned client interface**: semver'd schema for fields/events, capability negotiation, deprecations; MCP tools: list sources, list fields, subscribe, read value + metadata, read history window, start/stop recording, simulate; MCP never exposes credentials | | [P] |
| 15 | **Failure behaviour when DSM is down**: Editor and Playout keep running on their own last-good snapshot embedded in the loaded project/show; fields flagged stale; reconnect with full-state resync, not partial; policy per field (hold, blank, fallback value, hide element) | XPression gives only Return Empty on Failure per object | [P] |
| 16 | **Rate limiting and shared polling**: one fetch serves all subscribers; global budgets per host/API key (Sheets 60 per minute per user); adaptive backoff with jitter on 429 and 5xx | Sheets and PandaScore limits are concrete evidence | [E] |
| 17 | **Ordering and de-duplication**: per-source sequence or id; drop duplicates; mark out-of-order; keep a configurable reorder window; for SSE use `Last-Event-ID`; for WebSocket providers with sequence numbers request snapshot after gap | | [E] |
| 18 | **Clock handling**: record both source time and receive time; show skew | | [E]/[P] |
| 19 | **Two-way and manual**: manual tables and overrides as just another source, with provenance on every value | Flowics volleyball case shows need | [E]/[P] |
| 20 | **Operator view**: one table of sources with state, rate, age, errors; click to see raw message and mapped result | | [P] |

### 7.3 Pitfalls to avoid (each tied to evidence)

1. **Per-source-type refresh dialogs** with different units (ms vs s vs events). XPression and Viz both vary (Viz Data Center changed polling unit between 2.0 and 2.1). One refresh model, one unit. [D]
2. **Relying on OS file-change events**, especially on shared drives. Always allow polling with mtime+size+hash. [D][S]
3. **Reading live Excel files in place**; locking and driver issues. Read a copy; prefer CSV/Sheets export for live shows. [S]
4. **No staleness signal.** Silent last value on air is the worst failure. [U in XPression, D in Singular]
5. **Trusting push without catch-up.** Replay semantics differ even within one vendor's docs; always snapshot-then-stream. [S]
6. **Webhooks to a desktop app** without a relay, signatures or idempotency. [E]
7. **Subscription lifecycles** (Graph expiry under 30 days, Apps Script triggers running as their creator) silently stopping. Track renewal and run a periodic resync. [D]
8. **Quota exhaustion** from every client polling separately; Sheets quotas are per user and project. [D]
9. **Hand-built connection strings** (XPression added a Browse button to remove them). Use guided discovery. [S]
10. **Coalescing or dropping events** that scenes need (a score change could be skipped by a polled value comparison). Keep events separate from latest values (owner's rule about never coalescing frame lateness applies by analogy). [P]
11. **Mixing data-source config with scene design**: XPression binds by name to server sources, so a renamed source breaks scenes. Reference sources by stable id, show the name only. [S]
12. **Credentials in project files or MCP output.** [E]
13. **Parsers running in the render process.** [P]
14. **Silent failure of lookups**: "Return Empty on Failure" hides errors; show a visible error state in preview and a log entry. [D]
15. **Assuming an unverified provider format.** Opta F24, SportsML profile and game-publisher APIs were not verified here; build adapters from provider docs under licence. [U]

### 7.4 Open questions for the owner

- What exactly is "Wizard" (a URL, vendor or screenshot would settle it).
- Which sources are mandatory for the first release (suggested minimum from evidence: file, HTTP, WebSocket, TCP/UDP framed text, Google Sheets, Excel, SQL read-only, manual, replay).
- Whether the DSM must run on the same machine as Playout or may be remote (this decides the "DSM down" behaviour in 7.2 item 15).
- Whether licensed sports feeds are in scope for test cases.

---

## 8. Sources not opened or blocked (so claims tagged [S] are weaker)

- support.rossvideo.com articles (ADODB, JSON, Text, ASCII) returned HTTP 403; only search summaries were available.
- rossvideo.community threads returned 404 to the fetch tool; only search summaries were available.
- support.singular.live and Flowics help pages returned 403 or were only seen via search.
- Ross Video documentation pages for Voyager and MLB DataLinq were seen only as search results.
