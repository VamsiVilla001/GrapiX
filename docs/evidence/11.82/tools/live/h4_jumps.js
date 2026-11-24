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

  await add("rect");
  out.threeSteps = state();

  row(1).click();
  await wait(900);
  out.backToStep1 = state();
  window.__shotReady = true;
  return out;
})()
