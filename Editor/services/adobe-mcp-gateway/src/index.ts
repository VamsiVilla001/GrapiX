export { AdobeGateway } from "./gateway.js";
export { BridgeRegistry } from "./registry.js";
export { LogRing } from "./logs.js";
export { loadGatewayConfig, type GatewayConfig } from "./config.js";

import { pathToFileURL } from "node:url";

import { AdobeGateway } from "./gateway.js";
import { loadGatewayConfig } from "./config.js";

/**
 * Started directly, rather than imported by a test or a shell.
 *
 * Compares this module's URL against the process entry path rather than matching a
 * filename. The packaged desktop build runs a single-file bundle named
 * `grapix-adobe-mcp-gateway.mjs`, so an `endsWith("index.js")` check silently started
 * nothing and exited 0 — the gateway "could not be reached" with no error to read.
 */
const entryPath = process.argv[1];
const isEntrypoint = Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);

if (isEntrypoint) {
  const config = loadGatewayConfig();
  const gateway = new AdobeGateway(config);
  const port = await gateway.listen();
  process.stdout.write(`[adobe-mcp-gateway] ws://${config.host}:${port} (protocol grapix-adobe/1)\n`);

  const shutdown = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
