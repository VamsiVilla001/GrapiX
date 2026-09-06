/**
 * Structural guard rail for port allocation.
 *
 * `Shared/service-discovery/src/ports.ts` is the register of every port GrapiX binds. A register
 * nobody checks is a comment, and this repository already learned what that costs: the ports were
 * correct, spread across TypeScript, Rust, two Vite configs and a launch profile, and the only
 * written record was a partial list in a memory file.
 *
 * Three things are checked, and each is a failure a build would not catch:
 *
 * 1. **No two services claim the same port.** The whole point of the register.
 * 2. **No service claims a retired port.** A retired port is not a free port — something on the
 *    network may still be trying to reach what used to answer there.
 * 3. **Each service's own source still declares the port the register records.** This is the one
 *    that matters most, because it is the only way a cross-language default can be held to a
 *    single source of truth: `services/render-engine/src/config.rs` cannot import TypeScript, so
 *    nothing but a text check can notice it drifting.
 *
 * Read from the built `dist` so the register is checked in the form the services consume, not in a
 * form only the type checker ever sees.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const registryUrl = new URL(
  `file://${path.resolve(repositoryRoot, "Shared/service-discovery/dist/ports.js").replace(/\\/g, "/")}`
);

const { GRAPIX_SERVICE_PORTS, GRAPIX_RETIRED_PORTS } = await import(registryUrl.href).catch(() => {
  console.error(
    "GrapiX port check: the register is not built.\n"
    + "  Run `npm run build:shared` (or `npm test -w @grapix/service-discovery`) first."
  );
  process.exit(2);
});

const failures = [];

/* 1. Uniqueness. */
const byPort = new Map();
for (const service of GRAPIX_SERVICE_PORTS) {
  const existing = byPort.get(service.port);
  if (existing) {
    failures.push(
      `port ${service.port} is claimed by both "${existing.id}" (${existing.name}) and `
      + `"${service.id}" (${service.name})`
    );
  }
  byPort.set(service.port, service);
}

/* Ids are how the checker and diagnostics name a service, so they must be unique too. */
const byId = new Set();
for (const service of GRAPIX_SERVICE_PORTS) {
  if (byId.has(service.id)) failures.push(`service id "${service.id}" is registered twice`);
  byId.add(service.id);
}

/* 2. Nothing reoccupies a retired port. */
for (const retired of GRAPIX_RETIRED_PORTS) {
  const claimant = byPort.get(retired.port);
  if (claimant) {
    failures.push(
      `port ${retired.port} was retired on ${retired.retired} and is now claimed by `
      + `"${claimant.id}". A retired port is not a free port: ${retired.reason}`
    );
  }
}

/* 3. Each declaration still says what the register says it says. */
for (const service of GRAPIX_SERVICE_PORTS) {
  const declaredPath = path.resolve(repositoryRoot, service.declaredIn.file);
  let source;
  try {
    source = await readFile(declaredPath, "utf8");
  } catch {
    failures.push(
      `"${service.id}" says its port is declared in ${service.declaredIn.file}, which does not exist`
    );
    continue;
  }

  if (!source.includes(service.declaredIn.contains)) {
    failures.push(
      `"${service.id}" (port ${service.port}) declares \`${service.declaredIn.contains}\` in `
      + `${service.declaredIn.file}, but that text is no longer there. Either the port moved and `
      + `the register was not updated, or the declaration was reworded — fix whichever is wrong.`
    );
  }
}

/*
 * 4. The engine's local scan range does not run into anybody else.
 *
 * The engine looks for a local peer by trying `DEFAULT_LOCAL_ENGINE_PORTS` in order, so those ports
 * are claimed in practice even though only the first is a service's default. This check used to be
 * a hand-written set inside `render-protocol`'s own tests, where it had already fallen four
 * services behind — a package cannot maintain a list of what every other package uses. Here it is
 * compared against the register itself.
 */
const engineScanPorts = await import(
  new URL(
    `file://${path.resolve(repositoryRoot, "Shared/render-protocol/dist/registry.js").replace(/\\/g, "/")}`
  ).href
).then((module) => module.DEFAULT_LOCAL_ENGINE_PORTS ?? [], () => []);

for (const port of engineScanPorts) {
  const claimant = byPort.get(port);
  if (claimant && claimant.owner !== "engine") {
    failures.push(
      `the engine scans port ${port}, which "${claimant.id}" (${claimant.name}) binds. `
      + "A local all-services run would have one of them fail to start."
    );
  }
  const retired = GRAPIX_RETIRED_PORTS.find((entry) => entry.port === port);
  if (retired) {
    failures.push(
      `the engine scans port ${port}, retired on ${retired.retired}. An engine must never adopt the `
      + `port a previous renderer owned: ${retired.reason}`
    );
  }
}

if (failures.length > 0) {
  console.error("GrapiX port allocation failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nThe register is Shared/service-discovery/src/ports.ts. Add a service there before giving it "
    + "a port, and never reuse a retired one."
  );
  process.exit(1);
}

const owners = GRAPIX_SERVICE_PORTS.reduce((counts, service) => {
  counts[service.owner] = (counts[service.owner] ?? 0) + 1;
  return counts;
}, {});

console.log(
  `GrapiX port allocation passed: ${GRAPIX_SERVICE_PORTS.length} services hold distinct ports `
  + `(${Object.entries(owners).map(([owner, count]) => `${owner} ${count}`).join(", ")}), `
  + `${GRAPIX_RETIRED_PORTS.length} retired port${GRAPIX_RETIRED_PORTS.length === 1 ? "" : "s"} left unclaimed, `
  + "and every declaration matches its source."
);
