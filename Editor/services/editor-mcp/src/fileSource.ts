/**
 * How an import tool receives a file.
 *
 * Two forms, because an agent has two situations: the file already exists on
 * the machine running this server (a path), or the agent produced the bytes
 * itself (base64). Both are supported everywhere an import is accepted, so a
 * caller never has to write a file to disk just to import it.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolContext } from "./toolkit.js";

export const fileSourceFields = {
  file_path: z
    .string()
    .max(4096)
    .optional()
    .describe("Absolute path, or a path relative to the GrapiX repository root, of the file to import."),
  file_base64: z
    .string()
    .max(400_000_000)
    .optional()
    .describe("File contents as base64. Use instead of file_path when the bytes are not on disk."),
  file_name: z
    .string()
    .max(255)
    .optional()
    .describe(
      "File name including extension. Required with file_base64 — importers dispatch on the extension. Defaults to the basename of file_path."
    )
};

export interface FileSourceArgs {
  file_path?: string;
  file_base64?: string;
  file_name?: string;
}

/**
 * A relative `file_path` resolves against the repository root, not the process
 * working directory: a stdio server's cwd is whatever the MCP client chose to
 * launch it with, which the caller cannot see and should not have to guess.
 */
export async function readSource(
  args: FileSourceArgs,
  context: ToolContext
): Promise<{ bytes: Uint8Array; fileName: string }> {
  if (args.file_base64) {
    if (!args.file_name) {
      throw new Error(
        "file_name is required when passing file_base64, because importers dispatch on the file extension."
      );
    }
    return { bytes: Buffer.from(args.file_base64, "base64"), fileName: args.file_name };
  }

  if (!args.file_path) {
    throw new Error("Provide either file_path, or file_base64 together with file_name.");
  }

  const absolute = path.isAbsolute(args.file_path)
    ? args.file_path
    : path.resolve(context.config.repositoryRoot, args.file_path);

  try {
    const bytes = await readFile(absolute);
    return { bytes, fileName: args.file_name ?? path.basename(absolute) };
  } catch (error) {
    throw new Error(
      `Could not read "${absolute}": ${error instanceof Error ? error.message : String(error)}. ` +
        "Pass an absolute path, or a path relative to the GrapiX repository root."
    );
  }
}
