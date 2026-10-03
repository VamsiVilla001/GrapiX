// The browser's one authoring mutation path (11.36).
//
// Rust owns every open document, its history and the project store. The web
// layer sends an `EditorCommand` and renders the `SessionView` that comes
// back; it never writes a document and never sends one. The other shell calls
// are pure reads, publication and preview, each named literally at its call
// site so the boundary guard (R4) can check it.

import type { CommandOutcome, EditorCommand } from "@grapix/contracts";

/** The slice of Tauri's core bridge this layer uses. */
export interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** Tauri v2's global bridge. Typed narrowly: core invoke and the file
 *  dialogs, and nothing this layer does not call. */
export interface TauriGlobal {
  readonly core: TauriCore;
  readonly dialog?: {
    open(options?: Record<string, unknown>): Promise<string | string[] | null>;
    save(options?: Record<string, unknown>): Promise<string | null>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

/** The shell's core bridge, or a named failure outside the Editor shell. */
export function shell(): TauriCore {
  const tauri = typeof window === "undefined" ? undefined : window.__TAURI__;
  if (!tauri) throw new Error("not running inside the Editor shell");
  return tauri.core;
}

/** Execute one command through the single authoring mutation surface. */
export async function execute(command: EditorCommand): Promise<CommandOutcome> {
  return shell().invoke<CommandOutcome>("cmd_execute", { command });
}

/**
 * The single documented number→bigint cast (memory rule 22, spec 11.36 §4.8).
 *
 * ts-rs types every Rust `u64` as `bigint`, but serde reads a frame from a
 * JSON number, and `JSON.stringify` cannot serialise a real `BigInt` at all.
 * So the value stays a number at runtime and only its static type changes.
 * It is checked first: a fractional or negative frame is refused here, by
 * name, rather than reaching Rust as a parse failure.
 */
export function wireFrame(frame: number): bigint {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new RangeError(`frame must be a non-negative whole number, got ${frame}`);
  }
  return frame as unknown as bigint;
}
