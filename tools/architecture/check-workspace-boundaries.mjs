/**
 * Structural guard rail for the three-product split.
 *
 * `docs/architecture.md` fixes four boundaries that no build error would catch:
 *
 * 1. Editor and Playout are separate applications and may not reach into each other.
 * 2. Shared holds application-neutral contracts and may depend on neither.
 * 3. Nothing may depend on a retired package — protocol v2's client in particular, which
 *    the acceptance gates state no packaged application may connect to.
 * 4. Every domain the architecture names is a registered workspace.
 *
 * Checked both ways round, because a dependency can be declared in a manifest or written as
 * a relative import that climbs out of its own tree. The first is what `npm ls` would show;
 * the second is what actually ships.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

/** The domains the architecture names, and which of the others each may not touch. */
const domains = [
  { name: "Editor", forbidden: ["Playout"] },
  { name: "Playout", forbidden: ["Editor"] },
  { name: "Shared", forbidden: ["Editor", "Playout"] }
];

/**
 * Packages that exist only in history. A dependency on one is a live path back to a runtime
 * the architecture retired, so it fails the check rather than merely warning.
 */
const retiredPackages = new Map([
  [
    "@grapix/renderer-protocol",
    "protocol v2 client; the engine speaks protocol v3 via @grapix/render-protocol"
  ]
]);

const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const skippedDirectories = new Set(["dist", "node_modules", "target", "gen", "binaries"]);
const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function walk(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      found.push(...(await walk(path.join(directory, entry.name))));
    } else if (entry.isFile()) {
      found.push(path.join(directory, entry.name));
    }
  }
  return found;
}

function dependenciesOf(manifest) {
  return {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {})
  };
}

const rootManifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8")
);
const configuredWorkspaces = new Set(rootManifest.workspaces ?? []);
const violations = [];

// Every file and manifest in each domain, found once and reused by both checks.
const scanned = new Map();
for (const domain of domains) {
  const root = path.join(repositoryRoot, domain.name);
  const files = await walk(root);
  const manifests = [];
  for (const file of files) {
    if (path.basename(file) !== "package.json") continue;
    manifests.push({ file, manifest: JSON.parse(await readFile(file, "utf8")) });
  }
  scanned.set(domain.name, { root, files, manifests });
}

/** Which domain owns each npm package name. A package outside the three is not our concern. */
const packageOwner = new Map();
for (const [name, { manifests }] of scanned) {
  for (const { manifest } of manifests) {
    if (manifest.name) packageOwner.set(manifest.name, name);
  }
}

for (const domain of domains) {
  if (!configuredWorkspaces.has(domain.name)) {
    violations.push(`root package.json is missing workspace "${domain.name}"`);
  }

  const { files, manifests } = scanned.get(domain.name);

  for (const { file, manifest } of manifests) {
    const relativeManifest = path.relative(repositoryRoot, file);

    for (const dependency of Object.keys(dependenciesOf(manifest))) {
      const owner = packageOwner.get(dependency);
      if (owner && domain.forbidden.includes(owner)) {
        violations.push(
          `${relativeManifest} depends on ${dependency}, which belongs to ${owner}`
        );
      }

      const retired = retiredPackages.get(dependency);
      if (retired) {
        violations.push(`${relativeManifest} depends on retired ${dependency} (${retired})`);
      }
    }
  }

  for (const file of files) {
    if (!sourceExtensions.has(path.extname(file))) continue;

    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];

      const retired = retiredPackages.get(specifier);
      if (retired) {
        violations.push(
          `${path.relative(repositoryRoot, file)} imports retired ${specifier} (${retired})`
        );
        continue;
      }

      if (!specifier.startsWith(".")) continue;

      const resolvedImport = path.resolve(path.dirname(file), specifier);
      for (const forbiddenDomain of domain.forbidden) {
        if (isInside(resolvedImport, path.join(repositoryRoot, forbiddenDomain))) {
          violations.push(
            `${path.relative(repositoryRoot, file)} imports across the ` +
              `${domain.name} -> ${forbiddenDomain} boundary (${specifier})`
          );
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("GrapiX workspace boundary check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  const counted = [...scanned]
    .map(([name, { manifests }]) => `${name} (${manifests.length})`)
    .join(", ");
  console.log(
    `GrapiX workspace boundaries passed: ${counted} are isolated, ` +
      `and no package depends on a retired runtime.`
  );
}
