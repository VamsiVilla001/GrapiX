// A Tauri bridge stub that behaves like the shell and the engine for the Stacks panel (verification only).
(() => {
  const timebase = { num: 30000, den: 1001 };
  const clock = { severity: "Nominal", label: "LOCKED to reference", timebase, freeRunning: false };
  const initialLayers = () => [
    { layer: -50, takeId: "bumper", revision: 1, state: "onAir", frame: 10 },
    { layer: 0, takeId: "l3", revision: 4, state: "onAir", frame: 612 },
    { layer: 60, takeId: "old", revision: 3, state: "leaving", frame: 700 },
    { layer: 60, takeId: "new", revision: 5, state: "queued", frame: 730 },
  ];
  const state = {
    online: true,
    calls: [],
    operator: { name: "Test Operator" },
    status: null,
    reset() {
      state.status = {
        epoch: 1, currentFrame: 1000, timebase, clock: "Genlocked", reference: "Locked", deviceTier: "T0", liveAllowed: true, degradations: [],
        program: { takeId: "l3", revision: 4, committedFrame: 612, sceneFrame: 0, playing: true },
        layers: initialLayers(),
      };
    },
    replace(layer, takeId, revision) {
      const entry = state.status.layers.find((l) => l.layer === layer && l.state !== "queued");
      if (entry) Object.assign(entry, { takeId, revision });
    },
  };
  state.reset();
  window.__sim = state;
  const view = () => ({ status: state.status, clock });
  const committed = (extra = {}) => ({ frame: 700, timebase, clock: "Genlocked", ...extra });
  window.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command !== "cmd_log" && command !== "cmd_status") state.calls.push({ command, args: JSON.parse(JSON.stringify(args ?? {})) });
        switch (command) {
          case "cmd_log": return null;
          case "cmd_operator": return state.operator;
          case "cmd_sign_out": state.operator = { name: null }; return null;
          case "cmd_sign_in": state.operator = { name: args.name }; return state.operator;
          case "cmd_default_endpoint": return "127.0.0.1:7000";
          case "cmd_connect": return view();
          case "cmd_status":
            if (!state.online) throw { error: "unreachable", detail: "engine gone" };
            return view();
          case "cmd_performance": return {};
          case "cmd_cue":
            return committed();
          case "cmd_take": {
            const layer = args.layer ?? 0;
            const occupied = state.status.layers.some((l) => l.layer === layer && l.state !== "queued");
            return committed(occupied ? { startFrame: 730 } : {});
          }
          case "cmd_phase":
            return { committed: committed(), phase: args.phase, sceneFrame: 40 };
          case "cmd_clear": {
            const layer = args.layer ?? 0;
            const onAir = state.status.layers.find((l) => l.layer === layer && l.state !== "queued");
            const expected = args.expected;
            if (expected && (!onAir || onAir.takeId !== expected.takeId || onAir.revision !== expected.revision)) {
              throw { error: "refused", refusal: { refusal: "clearExpectationUnmet", layer: String(layer), expected: String(expected.takeId), onAir: onAir ? String(onAir.takeId) : "nothing" }, detail: "the page named is not on that stack" };
            }
            state.status.layers = state.status.layers.filter((l) => l.layer !== layer);
            if (layer === 0) state.status.program = null;
            return committed();
          }
          default:
            throw { error: "unknownCommand", detail: command };
        }
      },
    },
  };
})();
