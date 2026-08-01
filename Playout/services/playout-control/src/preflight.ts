/**
 * Refuse to be the second control service.
 *
 * `EngineSupervisor` connects to the render engine from its constructor, and Fastify binds its
 * port last. So a second instance connects to the engine, becomes a second client authorised to
 * drive Program, and only then dies on `EADDRINUSE` — reported as a raw stack trace.
 *
 * The harm is the window, not the crash. Two control services both hold a `playout` role
 * connection and both issue Load, Cue and Take against the same engine, so whichever spoke last
 * decides what is on air. Playout is meant to be the single authority over Program; a duplicate
 * quietly breaks that.
 *
 * The port is the lock. Checking it before anything touches the engine turns a confusing
 * cross-process failure into one line that names the cause.
 *
 * This is a check, not a mutex: between the probe and Fastify's bind another process could
 * win the race. That is why `index.ts` also handles `EADDRINUSE` from `listen` — this makes
 * the common case clear, and that makes the rare case clean.
 */

import net from "node:net";

export interface PortOccupant {
  /** Something is listening. */
  occupied: boolean;
  /** It answered as a GrapiX control service, so this is a duplicate launch. */
  isPlayoutControl: boolean;
  /** Data root of the service already running, when it identified itself. */
  dataRoot?: string;
}

/** Is anything listening? Short timeout: this runs on every start. */
function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = net.createConnection({ host, port });
  const done = (occupied: boolean) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(occupied);
  };
  socket.setTimeout(timeoutMs);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
  return promise;
}

/** Ask whoever is listening whether they are us. */
async function identify(host: string, port: number): Promise<{ ours: boolean; dataRoot?: string }> {
  try {
    const response = await fetch(`http://${host}:${port}/api/playout/health`, {
      signal: AbortSignal.timeout(1_500)
    });
    if (!response.ok) return { ours: false };
    const body = (await response.json()) as { service?: string; dataRoot?: string };
    return body.service === "grapix-playout-control"
      ? { ours: true, ...(body.dataRoot ? { dataRoot: body.dataRoot } : {}) }
      : { ours: false };
  } catch {
    // Listening but not answering our health route: not ours, and not our problem.
    return { ours: false };
  }
}

export async function inspectPort(host: string, port: number): Promise<PortOccupant> {
  if (!(await probe(host, port, 600))) {
    return { occupied: false, isPlayoutControl: false };
  }
  const { ours, dataRoot } = await identify(host, port);
  return { occupied: true, isPlayoutControl: ours, ...(dataRoot ? { dataRoot } : {}) };
}

/**
 * The message a person needs, not a stack trace.
 *
 * Names what is holding the port, why a second instance is harmful rather than merely
 * redundant, and the command that resolves it.
 */
export function duplicateInstanceMessage(
  host: string,
  port: number,
  occupant: PortOccupant
): string {
  const lines = [
    `[playout] another process is already listening on ${host}:${port}.`
  ];
  if (occupant.isPlayoutControl) {
    lines.push(
      "[playout] it is a GrapiX playout-control, so this would be a duplicate launch."
        + (occupant.dataRoot ? ` Its data root is ${occupant.dataRoot}.` : "")
    );
    lines.push(
      "[playout] refusing to start: a second control service cannot serve the port, but it"
    );
    lines.push(
      "[playout] would still connect to the render engine as a second client able to Load, Cue"
    );
    lines.push(
      "[playout] and Take — so whichever spoke last would decide what is on air. Playout must be"
    );
    lines.push(
      "[playout] the single authority over Program."
    );
  } else {
    lines.push("[playout] refusing to start: it is not a GrapiX control service.");
  }
  lines.push(
    `[playout] stop the other process, or set GRAPIX_PLAYOUT_PORT to a free port.`
  );
  return lines.join("\n");
}
