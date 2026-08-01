import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { duplicateInstanceMessage, inspectPort } from "../dist/preflight.js";

/**
 * Refusing to be the second control service.
 *
 * The failure this prevents is cross-process and misleading: `EngineSupervisor` connects from
 * its constructor while Fastify binds last, so a duplicate launch became a phantom engine
 * client for its whole startup — fighting the running service for the connection and making
 * the engine look broken — before dying on `EADDRINUSE`. The port is the lock, so it is
 * checked before anything touches the engine.
 */

/**
 * A server on an ephemeral port, so tests never collide with a real service.
 *
 * Sockets are tracked and destroyed on close. `close()` waits for open connections, and the
 * probe deliberately leaves one behind when the listener never answers — without this the
 * helper hangs and takes every later test in the file with it.
 */
async function listen(handler) {
  const server = handler ? http.createServer(handler) : net.createServer();
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const ready = Promise.withResolvers();
  server.listen(0, "127.0.0.1", () => ready.resolve());
  await ready.promise;

  const { port } = server.address();
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const closed = Promise.withResolvers();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  };
}

test("a free port is reported as free", async () => {
  // Bind then release, so the number is real but nothing is on it.
  const server = await listen(null);
  const { port } = server;
  await server.close();

  const occupant = await inspectPort("127.0.0.1", port);
  assert.equal(occupant.occupied, false);
  assert.equal(occupant.isPlayoutControl, false);
});

test("another control service is identified as one, with its data root", async () => {
  const server = await listen((request, response) => {
    if (request.url === "/api/playout/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ service: "grapix-playout-control", dataRoot: "D:/data/playout" }));
      return;
    }
    response.writeHead(404).end();
  });

  const occupant = await inspectPort("127.0.0.1", server.port);
  assert.equal(occupant.occupied, true);
  assert.equal(occupant.isPlayoutControl, true, "a duplicate launch must be recognised as one");
  assert.equal(occupant.dataRoot, "D:/data/playout");
  await server.close();
});

test("an unrelated listener is occupied but not ours", async () => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("some other service");
  });

  const occupant = await inspectPort("127.0.0.1", server.port);
  assert.equal(occupant.occupied, true);
  // Blaming a duplicate launch when the port belongs to something else would send the
  // operator hunting for a process that does not exist.
  assert.equal(occupant.isPlayoutControl, false);
  await server.close();
});

test("a listener that accepts but never answers is occupied, not ours", async () => {
  // A raw TCP listener: connects fine, no HTTP. The probe must not hang on it.
  const server = await listen(null);
  const occupant = await inspectPort("127.0.0.1", server.port);
  assert.equal(occupant.occupied, true);
  assert.equal(occupant.isPlayoutControl, false);
  await server.close();
});

test("the refusal names the cause and the remedy", () => {
  const message = duplicateInstanceMessage("127.0.0.1", 4300, {
    occupied: true,
    isPlayoutControl: true,
    dataRoot: "D:/data/playout"
  });

  assert.match(message, /127\.0\.0\.1:4300/);
  assert.match(message, /duplicate launch/);
  assert.match(message, /D:\/data\/playout/);
  // The harm an operator needs to understand, stated explicitly: not that the launch is
  // redundant, but that two services would both be able to put something on air.
  assert.match(message, /single authority over Program/);
  assert.match(message, /Load, Cue/);
  assert.match(message, /GRAPIX_PLAYOUT_PORT/);
});

test("a non-GrapiX occupant gets a different explanation", () => {
  const message = duplicateInstanceMessage("127.0.0.1", 4300, {
    occupied: true,
    isPlayoutControl: false
  });

  assert.match(message, /not a GrapiX control service/);
  assert.doesNotMatch(message, /duplicate launch/);
  assert.match(message, /GRAPIX_PLAYOUT_PORT/);
});
