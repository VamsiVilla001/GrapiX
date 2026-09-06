/**
 * Credentials for Adobe's Photoshop API, as issued by the Adobe Developer Console.
 *
 * These are the same four values `adobe/adobe-photoshop-api-sdk` puts in `config/adobe.js`.
 * They are read from the environment and never written to a scene, a log or the panel:
 * a client secret in an operator log is a leaked Adobe organisation.
 */
export interface PhotoshopApiCredentials {
  clientId: string;
  clientSecret: string;
  orgId: string;
  scopes: string[];
}

export interface GatewayConfig {
  port: number;
  host: string;
  token: string;
  allowPublic: boolean;
  /** Absent when the deployment has not configured the Photoshop API. */
  photoshopApi?: PhotoshopApiCredentials;
}

/** The scopes the Photoshop API SDK's own samples request. */
const DEFAULT_PS_API_SCOPES = ["openid", "AdobeID", "read_organizations"];

/** A short shared secret is readily guessable by another local process. */
const MIN_GATEWAY_TOKEN_LENGTH = 16;

export function loadGatewayConfig(override?: Partial<GatewayConfig>): GatewayConfig {
  const port = override?.port ?? parseInt(process.env.GRAPIX_ADOBE_GATEWAY_PORT || "4784", 10);
  const host = override?.host ?? (process.env.GRAPIX_ADOBE_GATEWAY_HOST || "127.0.0.1");
  const token = override?.token ?? process.env.GRAPIX_ADOBE_GATEWAY_TOKEN;
  if (!token || token.length < MIN_GATEWAY_TOKEN_LENGTH) {
    throw new Error(
      `GRAPIX_ADOBE_GATEWAY_TOKEN must be set to at least ${MIN_GATEWAY_TOKEN_LENGTH} characters before starting the Adobe MCP gateway.`
    );
  }
  const allowPublic = override?.allowPublic ?? process.env.GRAPIX_ADOBE_ALLOW_PUBLIC === "true";

  return {
    port,
    host,
    token,
    allowPublic,
    photoshopApi: override?.photoshopApi ?? readPhotoshopApiCredentials()
  };
}

/**
 * All four values or none.
 *
 * A partially configured Photoshop API is the worst outcome: the panel would advertise a
 * cloud transport that fails on the first call, so a missing value disables it outright
 * and `describeMissingPhotoshopApiConfig` names what is absent.
 */
function readPhotoshopApiCredentials(): PhotoshopApiCredentials | undefined {
  const clientId = process.env.GRAPIX_PS_API_CLIENT_ID;
  const clientSecret = process.env.GRAPIX_PS_API_CLIENT_SECRET;
  const orgId = process.env.GRAPIX_PS_API_ORG_ID;
  if (!clientId || !clientSecret || !orgId) return undefined;

  const scopes = process.env.GRAPIX_PS_API_SCOPES?.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  return {
    clientId,
    clientSecret,
    orgId,
    scopes: scopes && scopes.length > 0 ? scopes : DEFAULT_PS_API_SCOPES
  };
}

/** What the operator has to set before the Photoshop API transport can be used. */
export function describeMissingPhotoshopApiConfig(): string {
  const missing = [
    process.env.GRAPIX_PS_API_CLIENT_ID ? null : "GRAPIX_PS_API_CLIENT_ID",
    process.env.GRAPIX_PS_API_CLIENT_SECRET ? null : "GRAPIX_PS_API_CLIENT_SECRET",
    process.env.GRAPIX_PS_API_ORG_ID ? null : "GRAPIX_PS_API_ORG_ID"
  ].filter((name): name is string => name !== null);

  if (missing.length === 0) return "the Photoshop API is configured";
  return `the Photoshop API is not configured: set ${missing.join(", ")} from your Adobe Developer Console project`;
}
