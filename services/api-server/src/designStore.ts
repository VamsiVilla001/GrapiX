/**
 * DesignIR storage.
 *
 * A DesignIR is immutable once written: a re-import produces a new revision rather than
 * mutating the old one, so a rig can always be diffed against the design it was built on.
 * Files are keyed by designId, which already folds in the source ref and revision.
 */

import { summarizeDesignIR, type DesignIR, type DesignIRSummary } from "@grapix/design-ir";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const designRoot = path.join(workspaceRoot, "data", "designs");

export async function ensureDesignStorage(): Promise<void> {
  await mkdir(designRoot, { recursive: true });
}

export async function saveDesign(design: DesignIR): Promise<DesignIRSummary> {
  await ensureDesignStorage();

  // Atomic write, so a concurrent list never parses a half-written design.
  const target = designPath(design.designId);
  const temp = `${target}.${process.pid}.tmp`;

  await writeFile(temp, `${JSON.stringify(design, null, 2)}\n`, "utf8");
  await rename(temp, target);

  return summarizeDesignIR(design);
}

export async function listDesigns(): Promise<DesignIRSummary[]> {
  await ensureDesignStorage();
  const files = await readdir(designRoot);
  const summaries: DesignIRSummary[] = [];

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const design = JSON.parse(await readFile(path.join(designRoot, file), "utf8")) as DesignIR;
      summaries.push(summarizeDesignIR(design));
    } catch {
      // A partially written or hand-edited file must not take the whole list down.
    }
  }

  return summaries.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function readDesign(designId: string): Promise<DesignIR | null> {
  try {
    return JSON.parse(await readFile(designPath(designId), "utf8")) as DesignIR;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function deleteDesign(designId: string): Promise<boolean> {
  try {
    await unlink(designPath(designId));

    return true;
  } catch {
    return false;
  }
}

function designPath(designId: string): string {
  return path.join(designRoot, `${designId.replace(/[^a-zA-Z0-9_-]+/g, "-")}.json`);
}
