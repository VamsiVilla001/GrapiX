(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = $("start-dialog");
  if (start.open && !$("start-dismiss").hidden) $("start-dismiss").click();
  await wait(200);
  const startStillOpen = start.open;
  return {
    startStillOpen,
    startDismissHidden: $("start-dismiss").hidden,
    project: $("project-summary").textContent.slice(0, 80),
    tabs: [...document.querySelectorAll("#scene-tabs [role=tab], .scene-tab")].map((t) => t.textContent.trim().slice(0, 30)),
    createButtons: [...document.querySelectorAll(".creation-tools button")].map((b) => [b.id, b.dataset.createKind ?? b.dataset.kind ?? "", b.textContent.trim().slice(0, 16)]).slice(0, 20),
    historyOpen: !!$("history-open"),
    historyDialog: !!$("history-dialog"),
    undoDisabled: $("undo").disabled,
  };
})()
