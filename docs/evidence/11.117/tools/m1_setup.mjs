import { connect, LOG } from "./lib.mjs";
const c = await connect(9333, 120);
const { ev, wait, send, shot } = c;
// Open LiveFinals7 from Recent, reload as a normal start, make a scene with a rectangle and an ellipse.
send("Runtime.evaluate", { expression: `(async()=>{
  const file = document.querySelector('.app-menu[data-menu="file"]'); file.open = true; await new Promise(r=>setTimeout(r,300));
  file.querySelector('[data-menu-item="file.open-recent"] .menu-sub-toggle').click(); await new Promise(r=>setTimeout(r,900));
  [...document.querySelectorAll(".menu-recent")].find((b) => !b.disabled && b.textContent.includes("LiveFinals7")).click();
  return 1; })()`, awaitPromise: false }).catch(() => {});
await wait(4500);
await send("Page.reload", { ignoreCache: true }).catch(() => {});
await wait(7000);
await ev(`
  if (document.getElementById("start-dialog").open) document.getElementById("start-dialog").close();
  document.getElementById("new-scene").click(); await new Promise(r=>setTimeout(r,500));
  const n = document.getElementById("manager-create-name"); n.value = "Mask check 1"; n.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("manager-create-form").requestSubmit(); await new Promise(r=>setTimeout(r,1500));
  document.querySelector('.creation-tools [data-create-kind="rect"]').click(); await new Promise(r=>setTimeout(r,900));
  document.querySelector('.creation-tools [data-create-kind="ellipse"]').click(); await new Promise(r=>setTimeout(r,900));
  return 1;`);
const out = {};
out.objects = await ev(`return [...new Set([...document.querySelectorAll('button[data-action="select"][data-for]')].map((b) => b.dataset.for))];`);
out.maskPanel = await ev(`return { mount: !!document.getElementById("masks-mount"), text: document.getElementById("masks-mount").textContent.slice(0, 120) };`);
out.penCreates = await ev(`return { value: document.getElementById("pen-creates").value, note: document.getElementById("pen-creates-note").textContent };`);
out.join = await ev(`return !!document.getElementById("object-join");`);
await shot("m1-setup");
console.log(JSON.stringify({ ...out, dialogs: c.dialogs }, null, 1));
c.done();
