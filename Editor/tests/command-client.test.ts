// The browser's one authoring mutation path (11.36).
//
// Two things cross the boundary and both are consumer-visible: the command
// reaches `cmd_execute` as its `command` argument (the Tauri parameter name),
// and a frame crosses as a JSON number. The generated type says `bigint`, but a
// real `BigInt` cannot be serialised at all, so a "correct" conversion would
// make every frame-carrying edit throw before it left the browser.

import { afterEach, describe, expect, it } from "vitest";

import type { CommandOutcome, EditorCommand } from "@grapix/contracts";
import { execute, wireFrame, type TauriGlobal } from "../src/command-client";

const host = globalThis as { window?: { __TAURI__?: TauriGlobal } };

afterEach(() => {
  delete host.window;
});

describe("wireFrame", () => {
  it("serialises as a plain JSON number", () => {
    expect(JSON.stringify({ frame: wireFrame(40) })).toBe('{"frame":40}');
    expect(JSON.stringify({ frame: wireFrame(0) })).toBe('{"frame":0}');
  });

  it("refuses a frame Rust's u64 could not hold, by name", () => {
    expect(() => wireFrame(-1)).toThrow(RangeError);
    expect(() => wireFrame(1.5)).toThrow("non-negative whole number");
    expect(() => wireFrame(Number.NaN)).toThrow(RangeError);
    expect(() => wireFrame(2 ** 53)).toThrow(RangeError);
  });
});

describe("execute", () => {
  it("sends the command as cmd_execute's `command` argument and returns Rust's outcome", async () => {
    const calls: [string, unknown][] = [];
    const outcome: CommandOutcome = { effects: [{ effect: "none" }] };
    host.window = {
      __TAURI__: {
        core: {
          invoke: <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
            calls.push([command, JSON.parse(JSON.stringify(args))]);
            return Promise.resolve(outcome as T);
          },
        },
      },
    };
    const command: EditorCommand = {
      command: "editScene",
      target: { target: "session", session: 1 },
      edits: [{ edit: "removeKeyframe", objectId: "card", property: "x", frame: wireFrame(10) }],
    };

    await expect(execute(command)).resolves.toBe(outcome);
    expect(calls).toEqual([
      [
        "cmd_execute",
        {
          command: {
            command: "editScene",
            target: { target: "session", session: 1 },
            edits: [{ edit: "removeKeyframe", objectId: "card", property: "x", frame: 10 }],
          },
        },
      ],
    ]);
  });

  it("rejects by name outside the Editor shell", async () => {
    await expect(execute({ command: "undo", session: 1 })).rejects.toThrow(
      "not running inside the Editor shell",
    );
  });
});
