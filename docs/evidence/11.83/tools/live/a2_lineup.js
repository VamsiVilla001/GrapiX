(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const out = {};
  const select = async (ids) => {
    for (let i = 0; i < ids.length; i++) {
      const button = document.querySelector(`button[data-action="select"][data-for="${ids[i]}"]`);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: i > 0 }));
      await wait(250);
    }
  };
  const setField = async (field, value) => {
    const input = document.querySelector(`[data-inspector-field="${field}"]`);
    input.value = String(value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(700);
  };
  const doc = async () => (await invoke("cmd_session_view", { session: window.__session ?? 1 })).document;
  const boxes = async () => {
    const d = await doc();
    return Object.fromEntries(d.objects.map((o) => [o.id, { x: o.x, y: o.y, w: o.width, h: o.height, locked: o.locked }]));
  };
  const rows = () => [...document.querySelectorAll("#history-list .history-row")].map((b) => b.querySelector(".history-what").textContent + (b.classList.contains("undone") ? " [undone]" : "") + (b.getAttribute("aria-current") === "step" ? " <-" : ""));
  const activity = (n = 2) => [...document.querySelectorAll("#log li")].slice(0, n).map((li) => li.textContent.trim().slice(0, 110));
  const choose = async (id) => {
    const edit = document.querySelector('.app-menu[data-menu="edit"]');
    edit.open = true;
    await wait(250);
    const sub = edit.querySelector('[data-menu-item="edit.line-up"] .menu-sub-toggle');
    if (document.querySelector(`[data-menu-item="${id}"]`).offsetParent === null) sub.click();
    await wait(250);
    document.querySelector(`[data-menu-item="${id}"]`).click();
    await wait(900);
    edit.open = false;
  };

  // Put the three rectangles in known places.
  for (const [id, x, y] of [["rect-1", 100, 100], ["rect-2", 400, 250], ["rect-3", 900, 40]]) {
    await select([id]);
    await setField("x", x);
    await setField("y", y);
  }
  out.start = await boxes();
  $("history-open").click();
  await wait(700);
  out.historyBefore = rows();

  // Line up left edges: everything goes to x 100, in one history step.
  await select(["rect-1", "rect-2", "rect-3"]);
  await choose("edit.line-up.left");
  out.afterLeft = { boxes: await boxes(), activity: activity(1), history: rows().slice(-2) };

  // One Undo puts all three back.
  $("undo").click();
  await wait(900);
  out.afterUndo = { boxes: await boxes(), history: rows().slice(-2) };

  // Spread evenly across: the two outermost stay, the middle one takes the equal gap.
  await select(["rect-1", "rect-2", "rect-3"]);
  await choose("edit.line-up.spread-across");
  out.afterSpread = { boxes: await boxes(), activity: activity(1) };

  // Tops, bottoms and middles.
  await choose("edit.line-up.bottom");
  out.afterBottom = { boxes: await boxes(), activity: activity(1) };

  // Refusals send nothing: the same call again is "nothing to move"; one item; a locked item.
  const before = JSON.stringify(await boxes());
  await choose("edit.line-up.bottom");
  out.alreadyLined = { activity: activity(1), unchanged: JSON.stringify(await boxes()) === before };
  await select(["rect-1"]);
  await choose("edit.line-up.left");
  out.oneItem = { activity: activity(1) };
  await select(["rect-1", "rect-2", "rect-3"]);
  await select(["rect-2"]);
  const lock = document.querySelector('[data-inspector-field="locked"]');
  lock.checked = true;
  lock.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(800);
  await select(["rect-1", "rect-2", "rect-3"]);
  const beforeLocked = JSON.stringify(await boxes());
  await choose("edit.line-up.top");
  out.locked = { activity: activity(1), unchanged: JSON.stringify(await boxes()) === beforeLocked };
  out.historyAfter = rows();
  return out;
})()
