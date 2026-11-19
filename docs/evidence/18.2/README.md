# 18.2 Figma through the MCP: first reading (18 Nov 2026)

**Decision (user):** Figma works like it does in Claude and Codex, signed in through the MCP; no personal access token and no keychain entry in GrapiX.

**Finding:** Figma's remote MCP server admits only catalog clients (Claude Code, Codex, Cursor, VS Code and a few more); other apps are refused at
client registration, and a personal access token or a self-made OAuth app does not open it. Source: Figma forum threads and write-ups found by web
search on 18 Nov 2026, not checked against Figma's own documentation. So GrapiX cannot sign in to it itself.

**Design:** agent-brokered. An approved agent reads the frame through its Figma MCP and gives it to GrapiX's Editor MCP tool. A second path to verify:
the Figma desktop app's local MCP server.

**Proof the route works (read-only):** this session's approved agent called the Figma MCP `get_metadata` on file `Kn05sACr8HOcZhZnx8EqAz`, node
`1945-12449`, and got the structure: a 1920 by 1080 frame ("Camera · Caster L3 · Trio · APPROVED · PIC") holding one `Trio` frame of 143 px height with
four vectors (`Panel · bg`, `Slab · slash`, two `Cut · between`), an instance (`Logo · PIC`), six text nodes (three `Handle`, three `Name`) and two end
vectors (`End · teal`, `End · amber`). No token or sign-in was given to GrapiX. Not yet done: `get_design_context` (styles, variables, fills),
the screenshot, and handing the result to GrapiX's Editor MCP tool, which is the build of 18.2 and then 18.11.
