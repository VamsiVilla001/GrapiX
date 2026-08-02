import {
  AFTER_EFFECTS_TOOLS,
  GATEWAY_VERSION,
  PHOTOSHOP_TOOLS,
  type AdobeApp,
  type AdobeApplicationStatus,
  type AdobeGatewayStatus,
  type AdobeTransport
} from "@grapix/adobe-common-schema";

export interface BridgeRecord {
  peerId: string;
  app: AdobeApp;
  transport: AdobeTransport;
  appVersion?: string;
  bridgeVersion?: string;
  /** Tools the bridge declared at hello. Empty means "the full namespace". */
  tools: string[];
  activeDocument?: string;
  connectedAt: number;
  send(payload: unknown): void;
}

/** `photoshop:local`, `photoshop:cloud`, `after-effects:local`. */
type BridgeKey = `${AdobeApp}:${AdobeTransport}`;

function keyOf(app: AdobeApp, transport: AdobeTransport): BridgeKey {
  return `${app}:${transport}`;
}

/**
 * Which Adobe applications are reachable right now, and over which transport.
 *
 * One bridge per (application, transport): a second Photoshop plugin connecting replaces
 * the first, because two plugins driving one document would race on every mutating call.
 * The displaced bridge is returned so the caller can close it rather than leak the socket.
 *
 * Local and cloud coexist deliberately — the same PSD can be reachable through the
 * operator's open Photoshop and through Adobe's API, and the caller chooses.
 */
export class BridgeRegistry {
  private readonly bridges = new Map<BridgeKey, BridgeRecord>();
  /** Applications the host reported as installed, whether or not a bridge is up. */
  private readonly installed = new Map<AdobeApp, boolean>();
  /** Why an application's cloud transport is unusable, when it is. */
  private readonly cloudDetail = new Map<AdobeApp, string>();

  register(record: BridgeRecord): BridgeRecord | undefined {
    const key = keyOf(record.app, record.transport);
    const displaced = this.bridges.get(key);
    this.bridges.set(key, record);
    // Only a local plugin proves the application is installed on this machine; the cloud
    // API says nothing about it.
    if (record.transport === "local") this.installed.set(record.app, true);
    return displaced && displaced.peerId !== record.peerId ? displaced : undefined;
  }

  unregister(peerId: string): { app: AdobeApp; transport: AdobeTransport } | undefined {
    for (const [key, record] of this.bridges) {
      if (record.peerId === peerId) {
        this.bridges.delete(key);
        return { app: record.app, transport: record.transport };
      }
    }
    return undefined;
  }

  get(app: AdobeApp, transport: AdobeTransport): BridgeRecord | undefined {
    return this.bridges.get(keyOf(app, transport));
  }

  /**
   * Pick the bridge for a call.
   *
   * With no explicit transport, the local plugin wins: it sees the document the operator
   * actually has open, which the cloud API cannot. Cloud is the fallback, so a machine
   * without Photoshop still works.
   */
  resolve(app: AdobeApp, transport?: AdobeTransport): BridgeRecord | undefined {
    if (transport) return this.get(app, transport);
    return this.get(app, "local") ?? this.get(app, "cloud");
  }

  setInstalled(app: AdobeApp, installed: boolean): void {
    this.installed.set(app, installed);
  }

  setCloudDetail(app: AdobeApp, detail: string): void {
    this.cloudDetail.set(app, detail);
  }

  setActiveDocument(app: AdobeApp, transport: AdobeTransport, documentName: string | undefined): void {
    const record = this.bridges.get(keyOf(app, transport));
    if (record) record.activeDocument = documentName;
  }

  /** Tools a client may call: the declared set, or the full namespace when none was declared. */
  toolsFor(app: AdobeApp, transport?: AdobeTransport): readonly string[] {
    const record = this.resolve(app, transport);
    if (record && record.tools.length > 0) return record.tools;
    return app === "photoshop" ? PHOTOSHOP_TOOLS : AFTER_EFFECTS_TOOLS;
  }

  statusFor(app: AdobeApp): AdobeApplicationStatus {
    const local = this.get(app, "local");
    const cloud = this.get(app, "cloud");
    return {
      app,
      installed: this.installed.get(app) ?? Boolean(local),
      connected: Boolean(local),
      version: local?.appVersion,
      bridgeVersion: local?.bridgeVersion,
      activeDocument: local?.activeDocument ?? cloud?.activeDocument,
      permissionsStatus: local ? "granted" : "pending",
      lastConnectedAt: local?.connectedAt,
      cloudAvailable: Boolean(cloud),
      cloudDetail: this.cloudDetail.get(app)
    };
  }

  snapshot(port: number, protocol: string, connectedClients: number): AdobeGatewayStatus {
    return {
      gatewayVersion: GATEWAY_VERSION,
      port,
      protocol,
      applications: {
        photoshop: this.statusFor("photoshop"),
        "after-effects": this.statusFor("after-effects")
      },
      connectedClients
    };
  }
}
