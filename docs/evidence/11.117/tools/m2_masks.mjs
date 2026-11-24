import { connect, LOG, at } from "./lib.mjs";
const c = await connect(9333, 140);
const { ev, wait, click, drag, key, shot, geometry } = c;
const out = {};
const sel = (id) => ev(`document.querySelector('button[data-action="select"][data-for="${id}"]').click(); await new Promise(r=>setTimeout(r,600)); return 1;`);
const rows = () => ev(`return [...document.querySelectorAll("#masks-mount .mask-row")].map((r) => ({ title: r.querySelector("strong").textContent, mode: r.querySelector('select[aria-label="Mode"]').value, feather: r.querySelector('input[aria-label="Feather"]').value, opacity: r.querySelector('input[aria-label="Opacity %"]').value, status: r.querySelector(".mask-status").textContent }));`);
const overlay = () => ev(`return { masks: document.querySelectorAll("#viewport-overlay .overlay-mask").length, feather: document.querySelectorAll("#viewport-overlay .overlay-mask-feather").length, d: document.querySelector("#viewport-overlay .overlay-mask")?.getAttribute("d") ?? null };`);
const button = (text) => ev(`const b = [...document.querySelectorAll("#masks-mount button")].find((x) => x.textContent === ${JSON.stringify(text)} && !x.disabled); if (!b) return false; b.click(); await new Promise(r=>setTimeout(r,900)); return true;`);
const setNum = (label, value, row = 0) => ev(`const i = document.querySelectorAll("#masks-mount .mask-row")[${row}].querySelector('input[aria-label="${label}"]'); i.value = ${JSON.stringify(String(value))}; i.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r=>setTimeout(r,900)); return 1;`);
const setSel = (label, value, row = 0) => ev(`const s = document.querySelectorAll("#masks-mount .mask-row")[${row}].querySelector('select[aria-label="${label}"]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r=>setTimeout(r,900)); return 1;`);
const undo = () => key("document.body", "z", { ctrlKey: true });

await sel("rect-1");
out.noMasksYet = { rows: (await rows()).length, overlay: await overlay() };
out.addMask = await button("Add mask");
out.afterAdd = { rows: await rows(), overlay: await overlay(), log: await ev(`return ${LOG}.slice(0, 1);`) };
await shot("m2-one-mask");

await setSel("Mode", "lighten");
await setNum("Feather", 20);
await setNum("Opacity %", 80);
out.afterEdit = { rows: await rows(), overlay: await overlay() };
await shot("m2-feather");

await button("Add mask");
await setSel("Mode", "subtract", 1);
out.twoMasks = await rows();
await button("Up");
out.afterUp = (await rows()).map((r) => r.mode);
await ev(`const rs = document.querySelectorAll("#masks-mount .mask-row"); [...rs[0].querySelectorAll("button")].find((b) => b.textContent === "Remove").click(); await new Promise(r=>setTimeout(r,900)); return 1;`);
out.afterRemove = (await rows()).map((r) => r.mode);
await undo();
out.afterUndoRemove = (await rows()).map((r) => r.mode);
await undo();
out.afterUndoUp = (await rows()).map((r) => r.mode);

// Edit path on the first mask: the path tools point at it.
await ev(`const rs = document.querySelectorAll("#masks-mount .mask-row"); [...rs[0].querySelectorAll("button")].find((b) => b.textContent === "Edit path").click(); await new Promise(r=>setTimeout(r,700)); return 1;`);
out.editPath = await ev(`return { tool: document.getElementById("viewport-overlay").dataset.tool, vertices: document.querySelectorAll("#viewport-overlay .overlay-path-vertex").length, active: document.querySelectorAll("#viewport-overlay .overlay-mask.is-active").length };`);
const g = await geometry();
const before = (await overlay()).d;
// rect-1 is at its own place; the mask's first vertex is the object's top-left. Find it from the overlay's own vertex marker.
const v0 = await ev(`const r = document.querySelector("#viewport-overlay .overlay-path-vertex"); return { x: Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2, y: Number(r.getAttribute("y")) + Number(r.getAttribute("height")) / 2 };`);
const p0 = at(g, v0.x, v0.y), p1 = at(g, v0.x + 120, v0.y + 90);
await drag(p0, p1);
out.afterDrag = { d: (await overlay()).d, changed: (await overlay()).d !== before, log: await ev(`return ${LOG}.slice(0, 1);`) };
await shot("m2-edit-path");
await undo();
out.afterUndoDrag = { restored: (await overlay()).d === before };
console.log(JSON.stringify({ ...out, dialogs: c.dialogs }, null, 1));
c.done();
