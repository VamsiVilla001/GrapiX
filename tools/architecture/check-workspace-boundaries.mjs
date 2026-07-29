import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

const domains = [
  {
    name: "Editor",
    root: path.join(repositoryRoot, "Editor"),
    forbiddenRoots: ["Playout"],
    forbiddenPackages: ["@grapix/playout-workspace"]
  },
  {
    name: "Playout",
    root: path.join(repositoryRoot, "Playout"),
    forbiddenRoots: ["Editor"],
    forbiddenPackages: ["@grapix/editor-workspace"]
  },
  {
    name: "Shared",
    root: path.join(repositoryRoot, "Shared"),
    forbiddenRoots: ["Editor", "Playout"],
    forbiddenPackages: [
      "@grapix/editor-workspace",
      "@grapix/playout-workspace"
    ]
  }
];

const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx"
]);
const skippedDirectories = new Set(["dist", "node_modules", "target"]);
const importPattern =
  /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function dependenciesOf(manifest) {
  return Object.assign(
    {},
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies
  );
}

const rootManifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8")
);
const configuredWorkspaces = new Set(rootManifest.workspaces ?? []);
const violations = [];

for (const domain of domains) {
  if (!configuredWorkspaces.has(domain.name)) {
    violations.push(`root package.json is missing workspace "${domain.name}"`);
  }

  const files = await walk(domain.root);
  const manifestPath = path.join(domain.root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const dependencies = dependenciesOf(manifest);

  for (const packageName of domain.forbiddenPackages) {
    if (packageName in dependencies) {
      violations.push(
        `${domain.name}/package.json depends on forbidden package ${packageName}`
      );
    }
  }

  for (const file of files) {
    if (!sourceExtensions.has(path.extname(file))) {
      continue;
    }

    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        continue;
      }

      const resolvedImport = path.resolve(path.dirname(file), specifier);
      for (const forbiddenRoot of domain.forbiddenRoots) {
        const absoluteForbiddenRoot = path.join(repositoryRoot, forbiddenRoot);
        if (isInside(resolvedImport, absoluteForbiddenRoot)) {
          violations.push(
            `${path.relative(repositoryRoot, file)} imports across the ` +
              `${domain.name} -> ${forbiddenRoot} boundary (${specifier})`
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
  console.log(
    "GrapiX workspace boundaries passed: Editor, Playout, and Shared are isolated."
  );
}
