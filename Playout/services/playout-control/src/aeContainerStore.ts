import type { AeRuntimeContainer } from "@grapix/ae-runtime-contract";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class AeContainerStore {
  private readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(dataRoot: string) { this.root = path.join(dataRoot, "ae-containers"); }

  async list(): Promise<AeRuntimeContainer[]> {
    await mkdir(this.root, { recursive: true });
    const files = (await readdir(this.root)).filter((file) => file.endsWith(".json"));
    const containers = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(this.root, file), "utf8")) as AeRuntimeContainer));
    return containers.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async read(id: string): Promise<AeRuntimeContainer | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    try { return JSON.parse(await readFile(path.join(this.root, `${id}.json`), "utf8")) as AeRuntimeContainer; }
    catch { return null; }
  }

  async write(container: AeRuntimeContainer): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = path.join(this.root, `${container.id}.json`);
    const previous = this.writes.get(target) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(container, null, 2)}\n`);
      await rename(temporary, target);
    });
    this.writes.set(target, pending);
    try { await pending; } finally { if (this.writes.get(target) === pending) this.writes.delete(target); }
  }
}
