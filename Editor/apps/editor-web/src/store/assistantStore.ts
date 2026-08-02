import { create } from "zustand";
import type { AssistantEvent, AssistantStatus } from "../lib/assistantClient";

export type ToolStatus = "executing" | "done" | "staged" | "skipped";

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  read: boolean;
  status: ToolStatus;
  result?: string;
  isError?: boolean;
}

export interface TextItem {
  kind: "user" | "assistant" | "error";
  id: string;
  text: string;
  streaming?: boolean;
}

export type ChatItem = TextItem | ToolItem;

const dockHeightStorageKey = "grapix-assistant-dock-height";

function readDockHeight(): number {
  const stored = Number(localStorage.getItem(dockHeightStorageKey));
  return Number.isFinite(stored) && stored >= 220 && stored <= 720 ? stored : 380;
}

interface AssistantStoreState {
  status: AssistantStatus | null;
  open: boolean;
  sessionId: string | null;
  items: ChatItem[];
  sending: boolean;
  dockHeight: number;

  setStatus: (status: AssistantStatus) => void;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setSession: (sessionId: string) => void;
  setDockHeight: (height: number) => void;
  pushUser: (text: string) => void;
  setToolStatus: (id: string, status: ToolStatus) => void;
  ingest: (event: AssistantEvent) => void;
  clear: () => void;
}

let itemCounter = 0;
function nextId(): string {
  itemCounter += 1;
  return `item-${itemCounter}`;
}

export const useAssistantStore = create<AssistantStoreState>((set) => ({
  status: null,
  open: false,
  sessionId: null,
  items: [],
  sending: false,
  dockHeight: readDockHeight(),

  setStatus: (status) => set({ status }),
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
  setSession: (sessionId) => set({ sessionId }),
  setDockHeight: (height) => {
    const clamped = Math.max(220, Math.min(720, Math.round(height)));
    localStorage.setItem(dockHeightStorageKey, String(clamped));
    set({ dockHeight: clamped });
  },

  pushUser: (text) =>
    set((state) => ({
      sending: true,
      items: [...state.items, { kind: "user", id: nextId(), text }]
    })),

  setToolStatus: (id, status) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.kind === "tool" && item.id === id ? { ...item, status } : item
      )
    })),

  ingest: (event) =>
    set((state) => {
      const items = [...state.items];
      switch (event.type) {
        case "text": {
          const last = items[items.length - 1];
          if (last && last.kind === "assistant" && last.streaming) {
            items[items.length - 1] = { ...last, text: last.text + event.text };
          } else {
            items.push({ kind: "assistant", id: nextId(), text: event.text, streaming: true });
          }
          return { items };
        }
        case "tool-executing": {
          const index = items.findIndex((item) => item.kind === "tool" && item.id === event.id);
          const row: ToolItem = {
            kind: "tool",
            id: event.id,
            name: event.name,
            input: event.input,
            read: event.read,
            status: "executing"
          };
          if (index >= 0) items[index] = { ...(items[index] as ToolItem), ...row };
          else items.push(row);
          return { items };
        }
        case "staged": {
          items.push({
            kind: "tool",
            id: event.call.id,
            name: event.call.name,
            input: event.call.input,
            read: false,
            status: "staged"
          });
          return { items };
        }
        case "tool-result": {
          const index = items.findIndex((item) => item.kind === "tool" && item.id === event.id);
          if (index >= 0) {
            const existing = items[index] as ToolItem;
            // A skipped row stays skipped; the broker's note is its result text.
            const status: ToolStatus = existing.status === "skipped" ? "skipped" : "done";
            items[index] = { ...existing, status, result: event.text, isError: event.isError };
          }
          return { items };
        }
        case "error": {
          items.push({ kind: "error", id: nextId(), text: event.message });
          return { items, sending: false };
        }
        case "done": {
          const last = items[items.length - 1];
          if (last && last.kind === "assistant" && last.streaming) {
            items[items.length - 1] = { ...last, streaming: false };
          }
          return { items, sending: false };
        }
        default:
          return { items };
      }
    }),

  clear: () => set({ items: [] })
}));
