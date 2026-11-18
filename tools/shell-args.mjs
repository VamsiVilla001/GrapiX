// Arguments for a child process that is started through the Windows shell.
//
// `spawn(command, args, { shell: true })` joins the arguments with spaces and
// hands the line to `cmd.exe`, quoting nothing. An argument that contains a
// space is then several arguments: the launcher's engine got
// `--package-dir D:\Project KK\Personal projects\...` and refused `KK\Personal`
// as an unknown argument, so the engine never started and no shell could connect
// (row 5.10 introduced the absolute path; this repository's path has spaces).
//
// The Windows shell is needed only for `.cmd` programs such as `npx`; an `.exe`
// is started without it. Where a shell is used, every argument that needs it is
// quoted here.

/** Quote one argument for `cmd.exe` if it holds a space, a tab or a quote. */
export function quoteForCmd(argument) {
  if (argument === "") return '""';
  if (!/[\s"]/.test(argument)) return argument;
  // A double quote inside is escaped, and backslashes before it or at the end double
  // up so they do not escape the quote that closes the argument.
  const escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

/** The arguments to pass to `spawn` for a given platform and shell choice. */
export function shellArguments(args, { shell, platform = process.platform }) {
  return shell && platform === "win32" ? args.map(quoteForCmd) : args;
}
