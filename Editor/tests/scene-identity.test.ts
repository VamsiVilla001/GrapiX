import { describe, expect, it } from "vitest";

import { describeIdentityEdits, identityEdits } from "../src/scene-identity";

const doc = (over: Record<string, unknown> = {}) => ({ id: "final-four", name: "Final Four L3", sceneLabel: undefined, ...over }) as unknown as Parameters<typeof identityEdits>[0];
const typed = (over: Record<string, unknown> = {}) => ({ id: "final-four", name: "Final Four L3", label: "", idLocked: false, ...over }) as Parameters<typeof identityEdits>[1];

describe("what has been typed and not yet applied", () => {
  it("is nothing when each field already says what the scene says", () => {
    expect(identityEdits(doc(), typed())).toEqual([]);
    expect(identityEdits(doc({ sceneLabel: "7" }), typed({ label: "7" }))).toEqual([]);
  });

  it("is an edit for each field that differs, trimmed, in the order file name, name, Scene ID", () => {
    expect(identityEdits(doc(), typed({ id: " news ", name: "  Strap ", label: " 12 " }))).toEqual([
      { edit: "setSceneId", id: "news" },
      { edit: "setSceneName", name: "Strap" },
      { edit: "setSceneLabel", label: "12" },
    ]);
  });

  it("never edits the file name of a scene that belongs to a project", () => {
    expect(identityEdits(doc(), typed({ id: "something-else", idLocked: true }))).toEqual([]);
  });

  it("clears a Scene ID that was emptied, and does not edit one that was never set", () => {
    expect(identityEdits(doc({ sceneLabel: "3" }), typed({ label: "  " }))).toEqual([{ edit: "setSceneLabel", label: "" }]);
    expect(identityEdits(doc(), typed({ label: "   " }))).toEqual([]);
  });

  it("changing the Scene ID touches nothing else a cue could hold", () => {
    const edits = identityEdits(doc({ sceneLabel: "1" }), typed({ label: "2" }));
    expect(edits.map((e) => e.edit)).toEqual(["setSceneLabel"]);
  });
});

describe("the edits in words", () => {
  it("names each one the way the screen does", () => {
    expect(describeIdentityEdits([{ edit: "setSceneId", id: "news" }, { edit: "setSceneName", name: "Strap" }, { edit: "setSceneLabel", label: "12" }])).toBe("file name news and name Strap and Scene ID 12");
    expect(describeIdentityEdits([{ edit: "setSceneLabel", label: "" }])).toBe("no Scene ID");
  });
});
