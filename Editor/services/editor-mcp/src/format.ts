/**
 * Result shaping shared by every tool: one response format switch, one
 * pagination shape, one truncation rule.
 *
 * These live together because inconsistency here is what makes an agent give up
 * on a server. A tool that silently returns half a scene reads identically to
 * one that returned all of it, so truncation always names the parameter that
 * would have narrowed the result.
 */

import { CHARACTER_LIMIT, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./constants.js";

export type ResponseFormat = "markdown" | "json";

export interface Page<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
}

export function paginate<T>(items: T[], offset: number, limit: number): Page<T> {
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE_SIZE);
  const slice = items.slice(safeOffset, safeOffset + safeLimit);
  const consumed = safeOffset + slice.length;

  return {
    total: items.length,
    count: slice.length,
    offset: safeOffset,
    items: slice,
    has_more: items.length > consumed,
    ...(items.length > consumed ? { next_offset: consumed } : {})
  };
}

export const DEFAULT_LIMIT = DEFAULT_PAGE_SIZE;

/**
 * Applies the character budget to already-serialised text. `hint` must name the
 * concrete parameter or narrower call that returns less, never a vague
 * "try a smaller request".
 */
export function truncate(text: string, hint: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };

  const keep = text.slice(0, CHARACTER_LIMIT);
  return {
    text:
      `${keep}\n\n[... truncated: ${text.length - CHARACTER_LIMIT} of ${text.length} ` +
      `characters omitted. ${hint}]`,
    truncated: true
  };
}

/** Markdown key/value line, skipping fields that carry no information. */
export function field(label: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  return `- **${label}**: ${Array.isArray(value) ? value.join(", ") : String(value)}`;
}

export function lines(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined).join("\n");
}

export function heading(level: number, text: string): string {
  return `${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}`;
}

/**
 * Renders a page of records as a markdown table with a stable column order.
 * Columns are declared as label/accessor pairs so a list tool never has to
 * hand-write row strings.
 */
export function table<T>(
  rows: T[],
  columns: { label: string; value: (row: T) => unknown }[]
): string {
  if (rows.length === 0) return "_No matching records._";

  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) =>
      `| ${columns
        .map((column) => {
          const value = column.value(row);
          return value === undefined || value === null ? "—" : String(value).replace(/\|/g, "\\|");
        })
        .join(" | ")} |`
  );

  return [header, divider, ...body].join("\n");
}

export function pageFooter(page: Page<unknown>, parameterName = "offset"): string {
  return page.has_more
    ? `\nShowing ${page.count} of ${page.total}. Pass \`${parameterName}: ${page.next_offset}\` for the next page.`
    : `\nShowing all ${page.total}.`;
}
