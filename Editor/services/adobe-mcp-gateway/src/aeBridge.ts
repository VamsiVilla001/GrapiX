/**
 * The After Effects side of the bridge: find the installed application and run the bundled
 * exporter against a project.
 *
 * This is one of two readers, and the one that needs the application. When After Effects is
 * installed this launches it headless (`afterfx.exe -r`) with `jsx/grapix-ae-export.jsx`, which
 * reads the project through the supported ExtendScript object model and writes the shared
 * `AeManifest` JSON. When After Effects is not installed the exporter throws a typed
 * `AeBridgeError` with `code: "ae-not-installed"`, which the import route turns into a `503`
 * naming the native reader rather than silently switching to it — the two paths do not read the
 * same amount of a project, so which one ran is the author's to know.
 *
 * The other reader parses the binary directly and is the default
 * (`Shared/adobe-common-schema/src/ae/aepParser.ts`).
 *
 * Detection and launch live here, in the gateway service, because the gateway already owns
 * the After Effects transport. The project-api reaches this through the gateway client as the
 * `aftereffects.exportProjectManifest` tool.
 */

import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AeManifest } from "@grapix/shared-types";

const execFileAsync = promisify(execFile);

export class AeBridgeError extends Error {
  constructor(
    readonly code: "ae-not-installed" | "ae-export-failed" | "ae-manifest-unreadable",
    message: string
  ) {
    super(message);
    this.name = "AeBridgeError";
  }
}

/**
 * Where the bundled exporter lives.
 *
 * Three layouts have to work and they nest differently, so the first that exists wins rather
 * than one guessed path:
 * - development from `src/` and the plain `dist/` build → `../jsx/`
 * - installed, esbuild-bundled to `services/grapix-adobe-mcp-gateway.mjs` → `./jsx/`, which is
 *   where the desktop installer stages the folder (see `resources` in `tauri.conf.json`).
 * A missing exporter is reported as `ae-export-failed` naming the paths tried, because an
 * ENOENT from deep inside a spawn is not a diagnosis.
 */
const EXPORTER_CANDIDATES = ["../jsx/grapix-ae-export.jsx", "./jsx/grapix-ae-export.jsx"].map(
  (relative) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), relative)
);

async function locateExporter(): Promise<string> {
  for (const candidate of EXPORTER_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next layout
    }
  }
  throw new AeBridgeError(
    "ae-export-failed",
    `the bundled After Effects exporter was not found (looked in: ${EXPORTER_CANDIDATES.join(", ")})`
  );
}

/**
 * Candidate install locations for `afterfx.exe`, newest first.
 *
 * After Effects registers under `HKLM\SOFTWARE\Adobe\After Effects\<version>` with an
 * `InstallPath`, but reading the registry needs a native call. Enumerating the Adobe program
 * directory needs neither elevation nor a hardcoded version list — which matters, because a
 * pinned list of years silently stops finding After Effects the release after it was written
 * (the first list here missed a 2026 install on the first machine it ran on). An explicit
 * override wins so a non-standard install is one environment variable away.
 */
async function candidateExecutables(): Promise<string[]> {
  const override = process.env.GRAPIX_AE_EXECUTABLE?.trim();
  const candidates: string[] = override ? [override] : [];

  const roots = [process.env["ProgramFiles"], process.env["ProgramW6432"], "C:\\Program Files"]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(root, "Adobe"));

  const seen = new Set<string>();
  for (const adobeRoot of roots) {
    if (seen.has(adobeRoot)) continue;
    seen.add(adobeRoot);
    let entries: string[];
    try {
      entries = await readdir(adobeRoot);
    } catch {
      continue;
    }
    // Newest first: "Adobe After Effects 2026" sorts above "… 2025" descending.
    const installs = entries
      .filter((entry) => /^Adobe After Effects/i.test(entry))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const install of installs) {
      candidates.push(path.join(adobeRoot, install, "Support Files", "afterfx.exe"));
    }
  }
  return candidates;
}

/** The first `afterfx.exe` that exists, or `undefined` when After Effects is not installed. */
export async function findAfterEffects(): Promise<string | undefined> {
  for (const candidate of await candidateExecutables()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export interface AeExportProgress {
  phase: "launching" | "exporting" | "reading";
  fraction: number;
  message: string;
}

/**
 * A directory to stage the launch scripts in whose path contains no spaces.
 *
 * After Effects' `-r` argument parsing splits on spaces and silently runs nothing: given
 * `-r "C:\Users\Some One\Temp\run.jsx"` it starts, ignores the script and exits 0, which is
 * indistinguishable from a script that did nothing. The system temp directory is used when it
 * is safe; otherwise the scripts are staged at the system drive root, which never has one.
 */
function scriptStagingRoot(): string {
  const temp = tmpdir();
  if (!temp.includes(" ")) return temp;
  const systemDrive = process.env["SystemDrive"] ?? "C:";
  return path.join(`${systemDrive}\\`, "GrapiX", "ae-bridge");
}

/**
 * Export a project to a manifest by running After Effects headless.
 *
 * The launcher writes a small bootstrap .jsx that sets the two globals the exporter reads and
 * then runs it, because `afterfx -r` passes no arguments to a script. Progress is coarse —
 * After Effects gives no mid-export signal — so the phases are launch / export / read.
 */
export async function exportProjectManifest(
  projectPath: string,
  onProgress?: (progress: AeExportProgress) => void
): Promise<AeManifest> {
  // Checked before After Effects is launched: handed a path that does not exist, AE opens with
  // an error dialog and sits there until the timeout kills it — five minutes to learn what one
  // stat answers immediately.
  try {
    await access(projectPath);
  } catch {
    throw new AeBridgeError("ae-export-failed", `the project file does not exist: ${projectPath}`);
  }

  const executable = await findAfterEffects();
  if (!executable) {
    throw new AeBridgeError(
      "ae-not-installed",
      "After Effects is not installed: no afterfx.exe found under the Adobe install paths. " +
      "Set GRAPIX_AE_EXECUTABLE to a non-standard install, or import the project as .aepx instead."
    );
  }

  onProgress?.({ phase: "launching", fraction: 0.1, message: "Starting After Effects" });

  const stagingRoot = scriptStagingRoot();
  await mkdir(stagingRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(stagingRoot, "grapix-ae-"));
  const manifestPath = path.join(workDir, "grapix-ae-manifest.json");
  const bootstrapPath = path.join(workDir, "run-export.jsx");
  // Staged beside the bootstrap so an installed build's exporter (under
  // `C:\Program Files\GrapiX\…`) is reachable from a path AE will accept.
  const stagedExporter = path.join(workDir, "grapix-ae-export.jsx");
  await copyFile(await locateExporter(), stagedExporter);

  // The bootstrap sets the two paths the exporter reads and then includes it. ExtendScript
  // `$.evalFile` runs a file in the current scope, which is how the globals reach it. Paths
  // inside the script are quoted string literals, so only the path on the command line is
  // subject to After Effects' own argument parsing.
  const bootstrap = [
    `var GRAPIX_AE_PROJECT = ${JSON.stringify(projectPath)};`,
    `var GRAPIX_AE_MANIFEST = ${JSON.stringify(manifestPath)};`,
    `$.evalFile(${JSON.stringify(stagedExporter)});`
  ].join("\n");
  await writeFile(bootstrapPath, bootstrap, "utf8");

  try {
    onProgress?.({ phase: "exporting", fraction: 0.4, message: "Reading the project in After Effects" });
    // `-r` runs the script and quits. A generous timeout: a large project takes real time to
    // open and walk, and killing mid-export would leave a half-written manifest.
    await execFileAsync(executable, ["-r", bootstrapPath], {
      timeout: 5 * 60 * 1000,
      windowsHide: true
    });

    onProgress?.({ phase: "reading", fraction: 0.9, message: "Reading the exported manifest" });
    const text = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(text) as AeManifest;
    if (manifest.producer !== "ae-bridge") {
      throw new AeBridgeError("ae-manifest-unreadable", "After Effects produced a manifest with no ae-bridge producer marker");
    }
    return manifest;
  } catch (error) {
    if (error instanceof AeBridgeError) throw error;
    throw new AeBridgeError(
      "ae-export-failed",
      `After Effects export failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
