(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const items = () => document.querySelectorAll('[data-panel="object-manager"] li').length;
  const state = () => ({
    rows: window.__historyRows(),
    lead: $("history-lead").textContent,
    undoDisabled: $("undo").disabled,
    redoDisabled: $("redo").disabled,
    items: items(),
    last: window.__activity(1)[0],
    error: $("history-error").textContent,
  });
  const add = async (kind) => {
    document.querySelector(`.creation-tools [data-create-kind="${kind}"], .creation-tools [data-kind="${kind}"]`).click();
    await wait(900);
  };
  const row = (step) => [...document.querySelectorAll("#history-list .history-row")].find((b) => (b.dataset.step ?? "-") === String(step));
  const out = {};

  // Undo after a jump goes one further back; Redo comes forward one.
  $("undo").click();
  await wait(900);
  out.undoAfterJump = state();
  $("redo").click();
  await wait(900);
  out.redoOnce = state();

  // Forward in one move to the last step, then clicking where the scene already is does nothing.
  row(3).click();
  await wait(900);
  out.forwardToStep3 = state();
  const before = window.__activity(1)[0];
  row(3).click();
  await wait(900);
  out.clickCurrent = { rows: window.__historyRows(), logGrewBy: window.__activity(2)[1] === before ? 1 : 0, last: window.__activity(1)[0] };

  // The scene as opened, then a new edit: the undone steps are gone for good.
  row("-").click();
  await wait(900);
  out.sceneAsOpened = state();
  row(1).click();
  await wait(900);
  await add("ellipse");
  out.forked = state();

  // A stale line: ask for a step the history no longer has, the way an old list would.
  const session = (() => {
    // The command the list sends, with a step that was dropped by the fork.
    return window.__TAURI_INTERNALS__.invoke("cmd_execute", { command: { command: "goToHistoryStep", session: 1, step: 2 } }).then(
      (ok) => ({ ok }),
      (error) => ({ refused: error }),
    );
  })();
  out.staleStep = await session;

  // Close and reopen: from the toolbar button this time.
  $("history-close").click();
  await wait(200);
  out.closed = !$("history-dialog").open;
  $("history-open").click();
  await wait(900);
  out.reopened = { open: $("history-dialog").open, rows: window.__historyRows().length };
  return out;
})()
