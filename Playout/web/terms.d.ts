// GENERATED from Shared/web-panels/terms.d.ts by tools/sync-shared-web.mjs. Do not edit: edit the source and run `npm run sync:web`.
// Types for terms.js (build plan 11.127). No imports, so this file can be copied into an app's web folder as it is.

export type TermKey =
  | "sceneId"
  | "cue"
  | "cueId"
  | "cueControl"
  | "preload"
  | "preloaded"
  | "style"
  | "effects"
  | "stack"
  | "playline"
  | "sceneBank"
  | "inputs"
  | "airview"
  | "element"
  | "phase"
  | "playRules"
  | "dataHub"
  | "replayLab"
  | "field";

export type TermApp = "editor" | "playout";

export interface Term {
  /** What a person reads. A working title: change it here and every screen follows. */
  readonly name: string;
  readonly meaning: string;
  /** The wire protocol's own word for the same thing, where there is one (display names never change the wire). */
  readonly wire?: string;
  /** Old names the screens of `apps` must no longer show. */
  readonly replaces: readonly string[];
  readonly apps: readonly TermApp[];
}

export const TERMS: Readonly<Record<TermKey, Term>>;

/** The name a person reads for `key`. Throws on an unknown key. */
export function term(key: TermKey): string;

/** Old names found in `text` that `app` must no longer show. */
export function oldWordsIn(text: string, app: TermApp): { key: TermKey; word: string }[];
