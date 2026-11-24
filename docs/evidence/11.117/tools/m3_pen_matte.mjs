import { connect, LOG, at } from "./lib.mjs";
const c = await connect(9333, 170);
const { ev, wait, click, drag, mouse, key, shot, geometry } = c;
const out = {};
const sel = (id) => ev(`document.querySelector('button[data-action="select"][data-for="${id}"]').click(); await new Promise(r=>setTimeout(r,600)); return 1;`);
const maskCount = () => ev(`return document.querySelectorAll("#masks-mount .mask-row").length;`);
const pressedTool = () => ev(`return [...document.querySelectorAll("[data-tool]")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.tool);`);
const note = () => ev(`return document.getElementById("pen-creates-note").textContent;`);
const g = await geometry();

// --- Pen creates a mask on the selected rectangle (Auto) -------------------------------------------------
await sel("rect-1");
out.noteRect = await note();
out.masksBefore = await maskCount();
await ev(`document.getElementById("tool-pen").click(); await new Promise(r=>setTimeout(r,300)); return 1;`);
const quad = [at(g, 700, 400), at(g, 1000, 400), at(g, 1000, 650), at(g, 700, 650)];
for (const q of quad) await click(q);
out.penSketch = await ev(`return document.querySelectorAll("#viewport-overlay .overlay-pen-vertex").length;`);
await mouse([{ type: "mouseMoved", ...quad[0], wait: 150 }]);
await click(quad[0]);
await wait(1200);
out.afterPenMask = { masks: await maskCount(), log: await ev(`return ${LOG}.slice(0, 2);`), overlayMasks: await ev(`return document.querySelectorAll("#viewport-overlay .overlay-mask").length;`), note: await note() };
await shot("m3-pen-mask");

// An open path as a mask is refused, and the points are given back.
await click(at(g, 300, 800)); await click(at(g, 500, 900)); await click(at(g, 650, 820));
await key(`document.getElementById("viewport-overlay")`, "Enter");
out.openMask = { masks: await maskCount(), log: await ev(`return ${LOG}.slice(0, 2);`), vertices: await ev(`return document.querySelectorAll("#viewport-overlay .overlay-pen-vertex").length;`) };
await key(`document.getElementById("viewport-overlay")`, "Escape");

// Pen: Shape makes a shape even with the rectangle selected.
await ev(`const s = document.getElementById("pen-creates"); s.value = "shape"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1;`);
out.noteShape = await note();
for (const q of [at(g, 1300, 300), at(g, 1600, 300), at(g, 1600, 500)]) await click(q);
await mouse([{ type: "mouseMoved", ...at(g, 1300, 300), wait: 150 }]);
await click(at(g, 1300, 300));
await wait(1200);
out.afterPenShape = { shapes: await ev(`return [...new Set([...document.querySelectorAll('button[data-action="select"][data-for]')].map((b) => b.dataset.for))].filter((x) => x.startsWith("shape"));`), masks: await maskCount() };
await ev(`const s = document.getElementById("pen-creates"); s.value = "auto"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1;`);

// --- G goes through the pen family; P picks the Pen -----------------------------------------------------
await ev(`document.getElementById("tool-selection").click(); return 1;`);
const seq = [];
for (let i = 0; i < 5; i += 1) { await key("document.body", "g"); seq.push((await pressedTool())[0]); }
out.gCycle = seq;
await ev(`document.getElementById("tool-selection").click(); return 1;`);
await key("document.body", "p");
out.pKey = await pressedTool();

// --- Track matte: pick the ellipse as the rectangle's matte (any place in the stack) -------------------
await ev(`document.getElementById("tool-selection").click(); return 1;`);
await sel("rect-1");
await ev(`const s = document.querySelector('#masks-mount select[aria-label="Track matte source"]'); s.value = "ellipse-1"; s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r=>setTimeout(r,1000)); return 1;`);
out.matte = await ev(`return { source: document.querySelector('#masks-mount select[aria-label="Track matte source"]').value, mode: document.querySelector('#masks-mount select[aria-label="Matte"]').value, log: ${LOG}.slice(0, 1) };`);
// The source's eye is off now: the layer row's eye.
out.sourceHidden = await ev(`const row = [...document.querySelectorAll("#timeline-mount [data-object-id], .timeline-row, [data-layer-id]")].length; const eye = document.querySelectorAll('[data-action="visible"], .layer-eye'); return { rows: row, eyes: eye.length };`);
await sel("ellipse-1");
out.ellipseVisible = await ev(`const i = document.querySelector('[data-inspector-field="visible"]'); return i ? i.checked : null;`);
await sel("rect-1");
await ev(`const s = document.querySelector('#masks-mount select[aria-label="Matte"]'); s.value = "luma"; s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r=>setTimeout(r,900)); return 1;`);
out.matteLuma = await ev(`return document.querySelector('#masks-mount select[aria-label="Matte"]').value;`);
await shot("m3-matte");
await key("document.body", "z", { ctrlKey: true });
out.afterUndo = await ev(`return document.querySelector('#masks-mount select[aria-label="Matte"]').value;`);
await ev(`const b = [...document.querySelectorAll("#masks-mount button")].find((x) => x.textContent === "Clear"); b.click(); await new Promise(r=>setTimeout(r,900)); return 1;`);
out.afterClear = await ev(`return document.querySelector('#masks-mount select[aria-label="Track matte source"]').value;`);

// --- Preserve underlying transparency -----------------------------------------------------------------
await ev(`const b = [...document.querySelectorAll("#masks-mount label")].find((l) => l.textContent.includes("Preserve")).querySelector("input"); b.click(); await new Promise(r=>setTimeout(r,900)); return 1;`);
out.preserve = await ev(`return { checked: [...document.querySelectorAll("#masks-mount label")].find((l) => l.textContent.includes("Preserve")).querySelector("input").checked, log: ${LOG}.slice(0, 1) };`);
console.log(JSON.stringify({ ...out, dialogs: c.dialogs }, null, 1));
c.done();
