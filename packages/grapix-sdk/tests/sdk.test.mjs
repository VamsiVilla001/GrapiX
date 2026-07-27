import test from "node:test";
import assert from "node:assert/strict";
import {
  createSceneScriptApi,
  defineSceneScript,
  evaluateCondition,
  GrapixSequenceEngine
} from "../dist/index.js";

const event = {
  type: "data-change",
  name: "score",
  timestampMs: 1000,
  payload: { score: { home: 3 } }
};

test("evaluates nested conditions from event, scene, and rundown values", () => {
  const condition = {
    kind: "all",
    conditions: [
      {
        kind: "compare",
        left: { source: "event", path: "score.home" },
        operator: "gte",
        right: { source: "literal", value: 3 }
      },
      {
        kind: "compare",
        left: { source: "scene-data", path: "team" },
        operator: "eq",
        right: { source: "rundown-variable", path: "selectedTeam" }
      }
    ]
  };
  assert.equal(evaluateCondition(condition, {
    event,
    sceneData: { team: "HOME" },
    rundownVariables: { selectedTeam: "home" }
  }), true);
});

test("sequence engine orders rules and enforces cooldown and once semantics", () => {
  const engine = new GrapixSequenceEngine({
    rundownId: "rd_1",
    name: "Game",
    version: 1,
    activeSequenceId: "seq_1",
    variables: {},
    sequences: [{
      sequenceId: "seq_1",
      name: "Main",
      fps: 50,
      durationFrames: 1000,
      tracks: [],
      transitions: [],
      triggers: [
        {
          triggerId: "low",
          name: "Low",
          enabled: true,
          event: { type: "data-change", name: "score" },
          actions: [{ type: "emit-event", name: "low" }],
          priority: 1,
          once: true
        },
        {
          triggerId: "high",
          name: "High",
          enabled: true,
          event: { type: "data-change", name: "score" },
          actions: [{ type: "take-scene", sceneId: "score" }],
          priority: 10,
          cooldownMs: 500
        }
      ]
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(engine.process(event).matched.map((item) => item.triggerId), ["high", "low"]);
  assert.equal(engine.process({ ...event, timestampMs: 1200 }).matched.length, 0);
  assert.deepEqual(engine.process({ ...event, timestampMs: 1600 }).matched.map((item) => item.triggerId), ["high"]);
});

test("scene SDK exposes only permission-approved typed actions", () => {
  assert.equal(defineSceneScript({ apiVersion: 1 }).apiVersion, 1);
  const { api, actions } = createSceneScriptApi({
    sceneId: "lower_third",
    event,
    data: { player: { name: "Maya" } },
    permissions: ["read-data", "patch-data", "emit-event"]
  });
  assert.equal(api.getData("player.name"), "Maya");
  api.patchData("player.name", "Noah");
  api.emit("updated");
  assert.deepEqual(actions.map((action) => action.type), ["patch-data", "emit-event"]);
  assert.throws(() => api.take(), /control-program/);
});
