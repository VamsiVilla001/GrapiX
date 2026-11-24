import { connect, LOG, at } from "./lib.mjs";
const c = await connect(9333, 175);
const { ev, wait, click, mouse, key, shot, geometry } = c;
const out = {};
const sel = (id) => ev(`document.querySelector('button[data-action="select"][data-for="${id}"]').click(); await new Promise(r=>setTimeout(r,700)); return 1;`);
const btn = (text) => ev(`const b = [...document.querySelectorAll("#masks-mount button")].find((x) => x.textContent === ${JSON.stringify(text)} && !x.disabled); if (!b) return false; b.click(); await new Promise(r=>setTimeout(r,900)); return true;`);
const shapes = () => ev(`return [...new Set([...document.querySelectorAll('button[data-action="select"][data-for]')].map((b) => b.dataset.for))].filter((x) => x.startsWith("shape"));`);
const ov = `document.getElementById("viewport-overlay")`;
const g = await geometry();

// The Masks tab of the dock.
await ev(`document.querySelector('.dock-tab[data-tab="masks"]').click(); await new Promise(r=>setTimeout(r,500)); return 1;`);
await sel("rect-1");
out.tabVisible = await ev(`const s = document.querySelector('section[data-panel="masks"]'); const r = s.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height), hidden: s.hidden || getComputedStyle(s).display === "none" };`);
await btn("Add mask");
out.maskAdded = await ev(`return document.querySelectorAll("#masks-mount .mask-row").length;`);
await shot("m7-masks-tab");

// An effect on the layer, then its Mask Reference.
await ev(`document.querySelector('.dock-tab[data-tab="effects"]').click(); await new Promise(r=>setTimeout(r,500)); return 1;`);
await ev(`const b = [...document.querySelectorAll("#effects-mount button")].find((x) => x.textContent.trim() === "Apply" && x.closest("li")?.textContent.includes("Soft glow")); b?.click(); await new Promise(r=>setTimeout(r,1200)); return !!b;`);
out.effectLog = await ev(`return ${LOG}.slice(0, 2);`);
await ev(`document.querySelector('.dock-tab[data-tab="masks"]').click(); await new Promise(r=>setTimeout(r,500)); return 1;`);
out.references = await ev(`return [...document.querySelectorAll('#masks-mount select[aria-label^="Mask reference of"]')].map((s) => ({ label: s.getAttribute("aria-label"), options: [...s.options].map((o) => o.value), disabled: s.disabled }));`);
if (out.references.length > 0) {
  await ev(`const s = document.querySelector('#masks-mount select[aria-label^="Mask reference of"]'); s.value = "mask-1"; s.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r=>setTimeout(r,1000)); return 1;`);
  out.referenceSet = await ev(`return { value: document.querySelector('#masks-mount select[aria-label^="Mask reference of"]').value, log: ${LOG}.slice(0, 1) };`);
  // Removing the mask clears the reference first.
  await ev(`const rs = document.querySelectorAll("#masks-mount .mask-row"); [...rs[0].querySelectorAll("button")].find((b) => b.textContent === "Remove").click(); await new Promise(r=>setTimeout(r,1000)); return 1;`);
  out.afterRemoveMask = { rows: await ev(`return document.querySelectorAll("#masks-mount .mask-row").length;`), log: await ev(`return ${LOG}.slice(0, 2);`), reference: await ev(`return document.querySelector('#masks-mount select[aria-label^="Mask reference of"]')?.value ?? null;`) };
  await key("document.body", "z", { ctrlKey: true });
}
await ev(`document.getElementById("tool-selection").click(); return 1;`);

// Pen in mask mode with an open path: refused, given back, a second Escape lets it go.
await sel("rect-1");
await ev(`document.getElementById("tool-pen").click(); return 1;`);
for (const p of [[300, 800], [500, 900], [650, 820]]) await click(at(g, p[0], p[1]));
await key(ov, "Enter");
out.openRefused = { vertices: await ev(`return document.querySelectorAll("#viewport-overlay .overlay-pen-vertex").length;`), log: await ev(`return ${LOG}.slice(0, 1);`) };
await key(ov, "Escape");
out.afterEscape = await ev(`return document.querySelectorAll("#viewport-overlay .overlay-pen-vertex").length;`);

// Remove Point, Keep Shape: Alt-click the nearly straight middle vertex with the Delete Vertex tool.
await ev(`const s = document.getElementById("pen-creates"); s.value = "shape"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1;`);
const pts = [[300, 300], [600, 302], [900, 300], [900, 600]];
for (const p of pts) await click(at(g, p[0], p[1]));
await key(ov, "Enter"); await wait(900);
out.line = await shapes();
await ev(`document.getElementById("tool-vertex-delete").click(); return 1;`);
const dOf = () => ev(`return document.querySelector("#viewport-overlay .overlay-path")?.getAttribute("d");`);
const d0 = await dOf();
await click(at(g, 600, 302), 1);          // Alt-click the near-straight vertex
await wait(900);
out.keepShape = { before: d0, after: await dOf(), log: await ev(`return ${LOG}.slice(0, 1);`) };
await click(at(g, 900, 300), 1);          // Alt-click the real corner: kept, with the distance said
await wait(900);
out.cornerKept = { after: await dOf(), log: await ev(`return ${LOG}.slice(0, 1);`) };
await shot("m7-keep-shape");

// Copy SVG from the object row and from a mask.
await ev(`document.getElementById("tool-selection").click(); document.getElementById("object-copy-svg").click(); await new Promise(r=>setTimeout(r,800)); return 1;`);
out.copySvg = await ev(`return ${LOG}.slice(0, 1);`);
console.log(JSON.stringify({ ...out, dialogs: c.dialogs }, null, 1));
c.done();
