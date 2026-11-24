// Who is operating Playout (build plan 2.15): the person, not only the credential.
//
// The shell owns the signed-in operator and every Program command carries them to the
// engine; this module is only the page's own check of a name before it asks the shell
// to sign in, so a typo is told at once. The shell and the engine check the same rules
// again (`gx_contracts::auth::OperatorName`), and `Shared/contracts/fixtures/operator-names.json`
// is read by both tests so the two cannot disagree.

export const OPERATOR_NAME_MAX = 64;

const ALLOWED = /^[\p{Alphabetic}\p{N} .'_-]+$/u;
const STARTS = /^[\p{Alphabetic}\p{N}]/u;

/** @param {string} input
 *  @returns {{ ok: true, name: string } | { ok: false, reason: "empty" | "tooLong" | "badCharacter" | "badStart" | "doubleSpace" }} */
export function parseOperatorName(input) {
  const name = String(input).trim();
  if (name === "") return { ok: false, reason: "empty" };
  if ([...name].length > OPERATOR_NAME_MAX) return { ok: false, reason: "tooLong" };
  if (!ALLOWED.test(name)) return { ok: false, reason: "badCharacter" };
  if (!STARTS.test(name)) return { ok: false, reason: "badStart" };
  if (name.includes("  ")) return { ok: false, reason: "doubleSpace" };
  return { ok: true, name };
}

const REASONS = {
  empty: "Enter your name to sign in.",
  tooLong: `A name is at most ${OPERATOR_NAME_MAX} characters.`,
  badCharacter: "Use letters, digits, spaces and . ' - _ only.",
  badStart: "A name starts with a letter or a digit.",
  doubleSpace: "Use a single space between words.",
};

/** The sentence an operator reads for a refused name. */
export function describeNameFault(reason) {
  return REASONS[reason] ?? "That name is not accepted.";
}
