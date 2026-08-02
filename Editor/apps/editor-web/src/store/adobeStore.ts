import { create } from "zustand";
import { AdobeClient, type ConnectionState } from "@grapix/adobe-client";
import type { AdobeApp, AdobeGatewayStatus, LogMessage } from "@grapix/adobe-common-schema";

/**
 * The Editor's connection to the Adobe MCP gateway (`ws://127.0.0.1:4784`).
 *
 * One client per window, held here rather than in the panel, so the connection and the
 * operator's mutation approval survive the Adobe dialog being closed and reopened.
 */

/** Injected by the desktop shell; the dev fallback matches the gateway's own default. */
const gatewayUrl = readEnv("VITE_ADOBE_GATEWAY_URL") ?? "ws://127.0.0.1:4784";
const gatewayToken = readEnv("VITE_ADOBE_GATEWAY_TOKEN") ?? "grapix-adobe-token-secret";

function readEnv(key: string): string | undefined {
  const value = import.meta.env?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface AdobeStoreState {
  client: AdobeClient | null;
  connection: ConnectionState;
  /** Why the connection is down, when the gateway said. */
  detail?: string;
  status: AdobeGatewayStatus | null;
  logs: LogMessage[];
  /** This session may modify open Adobe documents. Cleared whenever the socket drops. */
  approved: boolean;
  busy: boolean;
  error: string | null;

  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  refreshLogs: () => Promise<void>;
  setApproval: (approved: boolean) => Promise<void>;
  restartBridge: (app: AdobeApp) => Promise<void>;
}

export const useAdobeStore = create<AdobeStoreState>((set, get) => ({
  client: null,
  connection: "disconnected",
  status: null,
  logs: [],
  approved: false,
  busy: false,
  error: null,

  connect: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });

    let client = get().client;
    if (!client) {
      client = new AdobeClient({ url: gatewayUrl, token: gatewayToken });
      client.on("state", (connection, detail) => {
        // Approval is per gateway session: a reconnect is a new session and must be re-granted.
        set(connection === "connected" ? { connection, detail } : { connection, detail, approved: false });
      });
      client.on("status", (status) => set({ status }));
      set({ client });
    }

    try {
      await client.connect();
      set({ status: await client.discover() });
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      set({ busy: false });
    }
  },

  disconnect: () => {
    get().client?.disconnect();
    set({ status: null, approved: false, error: null });
  },

  refresh: async () => {
    const client = get().client;
    if (!client || client.state !== "connected") return;
    try {
      set({ status: await client.discover(), error: null });
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  },

  refreshLogs: async () => {
    const client = get().client;
    if (!client || client.state !== "connected") return;
    try {
      set({ logs: await client.readLogs(200), error: null });
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  },

  setApproval: async (approved) => {
    const client = get().client;
    if (!client || client.state !== "connected") return;
    try {
      set({ approved: await client.setApproval(approved), error: null });
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  },

  restartBridge: async (app) => {
    const client = get().client;
    if (!client || client.state !== "connected") return;
    set({ busy: true });
    try {
      const dropped = await client.restartBridge(app);
      set({
        status: await client.discover(),
        error: dropped ? null : `${app} had no bridge connected, so nothing was restarted.`
      });
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      set({ busy: false });
    }
  }
}));
