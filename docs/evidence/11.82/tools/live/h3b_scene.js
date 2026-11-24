(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.openDialogs = [...document.querySelectorAll("dialog[open]")].map((d) => d.id);
  const dlg = $("manager-create-dialog");
  if (!dlg.open) {
    $("new-scene").click();
    await wait(500);
  }
  out.createOpen = dlg.open;
  out.title = $("manager-create-title").textContent;
  if (dlg.open) {
    const name = $("manager-create-name");
    name.value = "History check";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    $("manager-create-form").requestSubmit();
    await wait(1500);
  }
  out.afterCreate = { createOpen: dlg.open, activity: window.__activity(3), lead: $("history-lead").textContent, rows: window.__historyRows() };

  for (const kind of ["rect", "ellipse", "text"]) {
    document.querySelector(`.creation-tools [data-create-kind="${kind}"], .creation-tools [data-kind="${kind}"]`).click();
    await wait(900);
  }
  out.afterCreates = {
    undoDisabled: $("undo").disabled,
    redoDisabled: $("redo").disabled,
    activity: window.__activity(3),
    lead: $("history-lead").textContent,
    rows: window.__historyRows(),
    error: $("history-error").textContent,
  };
  return out;
})()
