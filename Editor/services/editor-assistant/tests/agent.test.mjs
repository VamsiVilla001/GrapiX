/**
 * The agent tool-call loop, driven by a scripted fake provider and a fake MCP executor, so the
 * read/stage/apply/skip behaviour is verified deterministically without a live model or the
 * real editor-mcp. These are the AA-1/AA-2 contracts: reads run immediately, mutations are
 * staged and never auto-applied, and the turn resumes once every tool is resolved.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../dist/agent.js";

const config = { sessionTokenBudget: 400_000 };

function fakeMcp() {
  const calls = [];
  return {
    calls,
    listToolInfo: () => [
      { name: "grapix_editor_list_objects", description: "", inputSchema: {}, readOnly: true },
      { name: "grapix_editor_add_object", description: "", inputSchema: {}, readOnly: false }
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { text: `ok:${name}`, isError: false };
    }
  };
}

function scriptedProvider(turns) {
  let index = 0;
  return {
    id: "anthropic",
    label: "Test",
    model: "test",
    supportsTools: true,
    async *chat() {
      const events = turns[index] ?? [{ type: "done", stopReason: "end" }];
      index += 1;
      for (const event of events) yield event;
    }
  };
}

function collector() {
  const events = [];
  return { events, emit: (event) => events.push(event) };
}

const READ_THEN_MUTATE = [
  [
    { type: "text", text: "I'll inspect the scene, then add a rectangle." },
    { type: "tool_use", id: "r1", name: "grapix_editor_list_objects", input: {} },
    { type: "tool_use", id: "m1", name: "grapix_editor_add_object", input: { type: "rect" } },
    { type: "done", stopReason: "tool_use" }
  ],
  [
    { type: "text", text: "Added the rectangle." },
    { type: "done", stopReason: "end" }
  ]
];

test("a read runs immediately and a mutation is staged, pausing the turn", async () => {
  const mcp = fakeMcp();
  const { events, emit } = collector();
  const agent = new Agent("s1", scriptedProvider(READ_THEN_MUTATE), mcp, config, "sys", emit);

  await agent.send("build a lower third");

  // The read executed; the mutation did not.
  assert.deepEqual(
    mcp.calls.map((call) => call.name),
    ["grapix_editor_list_objects"],
    "only the read tool should have run before approval"
  );
  assert.ok(events.some((e) => e.type === "tool-executing" && e.id === "r1" && e.read === true));
  assert.ok(events.some((e) => e.type === "tool-result" && e.id === "r1"));
  const staged = events.find((e) => e.type === "staged");
  assert.ok(staged, "the mutation should be staged");
  assert.equal(staged.call.id, "m1");
  assert.equal(agent.pendingStaged().length, 1, "the turn should be paused on one pending mutation");
  assert.ok(!events.some((e) => e.type === "done"), "the turn is not done while a mutation is pending");
});

test("applying a staged mutation runs it and resumes the turn to completion", async () => {
  const mcp = fakeMcp();
  const { events, emit } = collector();
  const agent = new Agent("s2", scriptedProvider(READ_THEN_MUTATE), mcp, config, "sys", emit);

  await agent.send("build a lower third");
  await agent.apply("m1");

  assert.deepEqual(
    mcp.calls.map((call) => call.name),
    ["grapix_editor_list_objects", "grapix_editor_add_object"],
    "the mutation runs only after apply"
  );
  assert.equal(agent.pendingStaged().length, 0);
  assert.ok(events.some((e) => e.type === "done"), "the turn completes after the model's follow-up");
  const transcript = agent.transcript();
  // user prompt, assistant(tool_use), user(tool_result), assistant(final)
  assert.equal(transcript.messages.length, 4);
  assert.equal(transcript.messages.at(-1).role, "assistant");
});

test("skipping a staged mutation does not run it but still completes the turn", async () => {
  const mcp = fakeMcp();
  const { events, emit } = collector();
  const agent = new Agent("s3", scriptedProvider(READ_THEN_MUTATE), mcp, config, "sys", emit);

  await agent.send("build a lower third");
  await agent.skip("m1");

  assert.deepEqual(
    mcp.calls.map((call) => call.name),
    ["grapix_editor_list_objects"],
    "a skipped mutation must never run"
  );
  assert.ok(events.some((e) => e.type === "done"));
});

test("a turn with only a text answer completes without staging anything", async () => {
  const mcp = fakeMcp();
  const { events, emit } = collector();
  const agent = new Agent(
    "s4",
    scriptedProvider([[{ type: "text", text: "The scene has three objects." }, { type: "done", stopReason: "end" }]]),
    mcp,
    config,
    "sys",
    emit
  );

  await agent.send("what is in the scene?");

  assert.equal(mcp.calls.length, 0);
  assert.ok(!events.some((e) => e.type === "staged"));
  assert.ok(events.some((e) => e.type === "done"));
});

test("the session token budget refuses a new turn once exhausted", async () => {
  const mcp = fakeMcp();
  const { events, emit } = collector();
  const agent = new Agent(
    "s5",
    scriptedProvider([
      [{ type: "usage", inputTokens: 10, outputTokens: 5 }, { type: "text", text: "ok" }, { type: "done", stopReason: "end" }]
    ]),
    mcp,
    { sessionTokenBudget: 10 },
    "sys",
    emit
  );

  await agent.send("first");
  const errorsBefore = events.filter((e) => e.type === "error").length;
  await agent.send("second");
  const errors = events.filter((e) => e.type === "error");
  assert.ok(errors.length > errorsBefore, "the second turn is refused after the budget is exceeded");
  assert.match(errors.at(-1).message, /budget/i);
});
