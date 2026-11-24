(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const project = "LiveFinals7";
  const out = {};
  const key = (k, shift, target = document) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
  const activity = (n = 1) => [...document.querySelectorAll("#log li")].slice(0, n).map((li) => li.textContent.trim().slice(8, 130));
  const stored = async () => (await invoke("cmd_scene_list", { project })).scenes?.map((s) => s.sceneId) ?? (await invoke("cmd_scene_list", { project }));
  const read = async (id) => (await invoke("cmd_scene_read", { project, sceneId: id }));
  const addRect = async () => {
    document.querySelector('.creation-tools [data-create-kind="rect"]').click();
    await wait(800);
  };
  const identity = () => ({ id: $("scene-id").value, name: $("scene-name").value });
  const choose = async (menu, id) => {
    const m = document.querySelector(`.app-menu[data-menu="${menu}"]`);
    m.open = true;
    await wait(250);
    document.querySelector(`[data-menu-item="${id}"]`).click();
    await wait(1200);
    m.open = false;
  };

  const file = document.querySelector('.app-menu[data-menu="file"]');
  file.open = true;
  await wait(300);
  file.querySelector('[data-menu-item="file.open-recent"] .menu-sub-toggle').click();
  await wait(900);
  [...document.querySelectorAll(".menu-recent")].find((b) => !b.disabled && b.textContent.includes(project)).click();
  await wait(2500);
  file.open = false;
  if ($("start-dialog").open) $("start-dialog").close();
  out.before = await stored();

  // A new scene, never saved: Ctrl+Shift+S is its first save, not a version.
  $("new-scene").click();
  await wait(500);
  $("manager-create-name").value = "Version check";
  $("manager-create-name").dispatchEvent(new Event("input", { bubbles: true }));
  $("manager-create-form").requestSubmit();
  await wait(1500);
  await addRect();
  key("s", true);
  await wait(1800);
  out.firstSave = { activity: activity(2), stored: await stored(), identity: identity() };

  // Ctrl+S saves in place and makes no version.
  await addRect();
  const savedBefore = JSON.stringify((await read("version-check")).objects.map((o) => o.id));
  key("s", false);
  await wait(1500);
  out.plainSave = { activity: activity(1), stored: await stored(), objectsStored: (await read("version-check")).objects.length, objectsBefore: savedBefore };

  // An unsaved edit, then Ctrl+Shift+S: the version holds it, the old scene does not.
  await addRect();
  const oldBytes = JSON.stringify(await read("version-check"));
  key("s", true);
  await wait(1800);
  out.version2 = {
    activity: activity(1),
    stored: await stored(),
    identity: identity(),
    newObjects: (await read("version-check_v002")).objects.length,
    oldObjects: (await read("version-check")).objects.length,
    oldUntouched: JSON.stringify(await read("version-check")) === oldBytes,
    unsavedMark: document.querySelector("#scene-tabs, .scene-tab")?.textContent.includes("•") ?? null,
  };
  $("history-open").click();
  await wait(700);
  out.version2.historyLead = $("history-lead").textContent;

  // Again: the number after this one, and the base is still the first scene.
  key("s", true);
  await wait(1800);
  out.version3 = { activity: activity(1), stored: await stored(), identity: identity() };

  // Inside a text field neither key does anything.
  const nameField = $("scene-name");
  nameField.focus();
  const countBefore = (await stored()).length;
  key("s", true, nameField);
  key("s", false, nameField);
  await wait(1200);
  out.inTextField = { stored: (await stored()).length === countBefore, activity: activity(1) };
  nameField.blur();

  // The File menu does the same as the keys.
  await addRect();
  await choose("file", "file.next-version");
  out.menuVersion = { activity: activity(1), stored: await stored() };
  await addRect();
  await choose("file", "file.save");
  out.menuSave = { activity: activity(1), stored: await stored() };
  return out;
})()
