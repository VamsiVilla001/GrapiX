export { AdobeGateway } from "./gateway.js";
export { BridgeRegistry } from "./registry.js";
export { LogRing } from "./logs.js";
export { loadGatewayConfig, type GatewayConfig } from "./config.js";

import { AdobeGateway } from "./gateway.js";
import { loadGatewayConfig } from "./config.js";

/** Started directly (npm run dev:adobe), rather than imported by a test or a shell. */
const isEntrypoint = process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts");

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
