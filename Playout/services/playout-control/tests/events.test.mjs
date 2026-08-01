import assert from "node:assert/strict";
import test from "node:test";
import { PlayoutEventBus } from "../dist/events.js";

/**
 * A fake Fastify reply. The bus only touches `reply.raw`, so that is all this provides —
 * writeHead, write, the close/error listeners, and end.
 */
function fakeReply({ origin = "http://tauri.localhost", failOnWrite = false } = {}) {
  const listeners = new Map();
  const written = [];
  let ended = false;
  let head = null;

  return {
    request: { headers: { origin } },
    written,
    get head() {
      return head;
    },
    get ended() {
      return ended;
    },
    fire(event) {
      listeners.get(event)?.forEach((fn) => fn());
    },
    raw: {
      writeHead(status, headers) {
        head = { status, headers };
      },
      write(chunk) {
        if (failOnWrite) throw new Error("socket gone");
        written.push(chunk);
        return true;
      },
      on(event, handler) {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
      },
      end() {
        ended = true;
      }
    }
  };
}

test("subscribing opens a stream with the headers EventSource requires", () => {
  const bus = new PlayoutEventBus();
  const reply = fakeReply();

  bus.subscribe(reply);

  assert.equal(bus.subscriberCount(), 1);
  assert.equal(reply.head.status, 200);
  assert.equal(reply.head.headers["content-type"], "text/event-stream");
  // Without no-transform a proxy may buffer the stream and the UI sees nothing until it
  // fills, which looks exactly like the bug this replaced.
  assert.match(reply.head.headers["cache-control"], /no-cache/);
  // The operator UI is always a different origin from this service.
  assert.equal(reply.head.headers["access-control-allow-origin"], "http://tauri.localhost");
  // A retry hint plus the blank line that actually opens the stream.
  assert.match(reply.written[0], /^retry: \d+\n\n$/);

  bus.close();
});

test("an event reaches every subscriber in SSE frame format", () => {
  const bus = new PlayoutEventBus();
  const first = fakeReply();
  const second = fakeReply();
  bus.subscribe(first);
  bus.subscribe(second);

  bus.emit({ kind: "library.changed", detail: { sceneId: "001", version: 3 } });

  for (const reply of [first, second]) {
    const frame = reply.written.at(-1);
    assert.equal(frame, 'event: library.changed\ndata: {"sceneId":"001","version":3}\n\n');
  }

  bus.close();
});

test("an event with no detail still carries a parseable data line", () => {
  const bus = new PlayoutEventBus();
  const reply = fakeReply();
  bus.subscribe(reply);

  bus.emit({ kind: "runtime.changed" });

  // `data:` must always be valid JSON: EventSource hands the raw string to the client, and a
  // bare newline would make JSON.parse throw in the UI.
  const frame = reply.written.at(-1);
  assert.equal(frame, "event: runtime.changed\ndata: {}\n\n");
  assert.deepEqual(JSON.parse(frame.match(/^data: (.*)$/m)[1]), {});

  bus.close();
});

test("a closed socket is dropped rather than throwing into the publish path", () => {
  const bus = new PlayoutEventBus();
  const healthy = fakeReply();
  const broken = fakeReply({ failOnWrite: true });

  bus.subscribe(healthy);
  // Subscribing writes the retry line, which this reply rejects — so it is already gone.
  assert.throws(() => bus.subscribe(broken));

  // Emitting must not throw: a publish failing because an operator closed a window would be
  // a far worse bug than a missed notification.
  assert.doesNotThrow(() => bus.emit({ kind: "library.changed" }));
  assert.equal(healthy.written.length, 2, "the healthy subscriber still received it");

  bus.close();
});

test("a disconnecting client is forgotten", () => {
  const bus = new PlayoutEventBus();
  const reply = fakeReply();
  bus.subscribe(reply);
  assert.equal(bus.subscriberCount(), 1);

  reply.fire("close");
  assert.equal(bus.subscriberCount(), 0);

  // And an event to nobody is a no-op, not an error.
  assert.doesNotThrow(() => bus.emit({ kind: "library.changed" }));
});

test("close ends every stream so the process can exit", () => {
  const bus = new PlayoutEventBus();
  const first = fakeReply();
  const second = fakeReply();
  bus.subscribe(first);
  bus.subscribe(second);

  bus.close();

  assert.equal(bus.subscriberCount(), 0);
  assert.ok(first.ended, "an open SSE socket would otherwise keep node alive");
  assert.ok(second.ended);
});
