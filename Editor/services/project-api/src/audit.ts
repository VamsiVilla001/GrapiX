import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Four levels: src (or dist) -> project-api -> services -> Editor -> repository
// root. The project API moved a level deeper in the Phase 2 migration, and the data
// root has to keep pointing at the repository's `data/`.
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);
const dataRoot = process.env.GRAPIX_DATA_ROOT?.trim()
  ? path.resolve(process.env.GRAPIX_DATA_ROOT)
  : path.join(workspaceRoot, "data");
const logRoot = path.join(dataRoot, "logs");
const operatorLog = path.join(logRoot, "operator-actions.jsonl");
let auditQueue: Promise<void> = Promise.resolve();

export interface OperatorAction {
  timestamp: string;
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  actor: "local" | "authenticated-remote";
  remoteAddress: string;
  contentLength: number;
}

export function recordOperatorAction(action: OperatorAction): Promise<void> {
  auditQueue = auditQueue
    .catch(() => undefined)
    .then(async () => {
      await mkdir(logRoot, { recursive: true });
      await appendFile(operatorLog, `${JSON.stringify(action)}\n`, { encoding: "utf8" });
    });
  return auditQueue;
}
