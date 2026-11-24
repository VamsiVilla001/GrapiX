import { connect, LOG, at } from "./lib.mjs";
const c = await connect(9333, 170);
const { ev, wait, click, drag, mouse, key, shot, geometry } = c;
const out = {};
const shapes = () => ev(`return [...new Set([...document.querySelectorAll('button[data-action="select"][data-for]')].map((b) => b.dataset.for))].filter((x) => x.startsWith("shape"));`);
const ov = `document.getElementById("viewport-overlay")`;
// A new scene so nothing is left over.
await ev(`document.getElementById("new-scene").click(); await new Promise(r=>setTimeout(r,500));
  const n = document.getElementById("manager-create-name"); n.value = "Mask check 2"; n.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("manager-create-form").requestSubmit(); await new Promise(r=>setTimeout(r,1800)); return 1;`);
const g = await geometry();
await ev(`document.getElementById("tool-pen").click(); const s = document.getElementById("pen-creates"); s.value = "shape"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1;`);
out.start = await shapes();
const drawLine = async (pts) => { for (const p of pts) await click(at(g, p[0], p[1])); await key(ov, "Enter"); await wait(900); };
await drawLine([[200, 200], [500, 200]]);
await ev(`document.getElementById("tool-selection").click(); document.querySelector('#viewport-overlay .overlay-hit-surface')?.dispatchEvent(new Event("noop")); return 1;`);
await key(ov, "Escape");           // clears the selection
await ev(`document.getElementById("tool-pen").click(); return 1;`);
await drawLine([[700, 600], [1000, 700]]);
out.twoLines = await shapes();
const [a, b] = out.twoLines;
await ev(`document.getElementById("tool-selection").click(); document.querySelector('button[data-action="select"][data-for="${a}"]').click(); await new Promise(r=>setTimeout(r,400));
  document.querySelector('button[data-action="select"][data-for="${b}"]').dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,ctrlKey:true})); await new Promise(r=>setTimeout(r,600)); return 1;`);
out.selected = await ev(`return [...document.querySelectorAll('#object-manager [role=row][aria-selected="true"]')].map((r) => r.id);`);
await shot("m5-two-lines");
// Ctrl J
await ev(`document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"j",ctrlKey:true,bubbles:true,cancelable:true})); await new Promise(r=>setTimeout(r,1200)); return 1;`);
out.afterJoinKey = { shapes: await shapes(), log: await ev(`return ${LOG}.slice(0, 1);`) };
await ev(`document.getElementById("tool-path").click(); await new Promise(r=>setTimeout(r,500)); return 1;`);
const dOf = () => ev(`return document.querySelector("#viewport-overlay .overlay-path")?.getAttribute("d");`);
out.joined = { d: await dOf(), vertices: await ev(`return document.querySelectorAll("#viewport-overlay .overlay-path-vertex").length;`) };
await shot("m5-joined");

// Alt-click converts the joined path's middle vertex: corner -> smooth -> corner.
const d0 = await dOf();
// The joined path's middle vertex is the first line's end (500,200).
await click(at(g, 500, 200), 1);
await wait(900);
const d1 = await dOf();
await click(at(g, 500, 200), 1);
await wait(900);
const d2 = await dOf();
out.altClick = { toSmooth: d1 !== d0, backToCorner: d2 === d0, log: await ev(`return ${LOG}.slice(0, 2);`), d0, d1 };
await shot("m5-altclick");

// Settings window shows the pen settings.
await ev(`const m = document.querySelector('.app-menu[data-menu="edit"]'); m.open = true; await new Promise(r=>setTimeout(r,300)); return 1;`);
out.settingsMenu = await ev(`return [...document.querySelectorAll('[data-menu-item]')].map((e) => e.dataset.menuItem).filter((x) => /setting|preferenc/i.test(x));`);
console.log(JSON.stringify({ ...out, dialogs: c.dialogs }, null, 1));
c.done();
