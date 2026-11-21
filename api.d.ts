// The user's own shell, read from files: the history of what they typed and the startup files that define
// aliases, functions, variables and PATH. No shell is run and nothing is changed; there is no calling change.
//
// Every function takes `home` as an option: a home folder to read instead of the user's own. Leave it out.
// A result with `error` is a failure: read it (`looked` lists where history was looked for).
//
// Shell history holds secrets typed on command lines, and your answers go to a cloud model, so every command
// returned has credentials replaced with "<redacted>" (passwords, tokens, keys, Authorization headers, user:pass@
// in URLs, strings shaped like known keys, values of NAME=value where NAME looks like a credential). Searches run
// on the redacted text, so a search cannot find a hidden value. Do not try other expressions to read one: say
// that the command held a credential and is not shown. `redacted` on a row is how many values were hidden. The
// rules go by pattern, so a secret in an unusual form can get through: if you see one, do not repeat it.
//
// Times are UTC. History that has no times (bash without HISTTIMEFORMAT) has an order only, as `position`.
// Folders, exit codes and durations exist only in atuin and nushell databases; a question about them over zsh or
// bash history cannot be answered, and the result's notes say so.

interface Entry {
  time: string | null; position?: number; // position when the history has no times
  command: string;                         // redacted, at most 600 characters
  cwd?: string; exit?: number; duration?: number; // seconds
  shell: string; also?: string[];          // the same command in another history at the same moment
  host?: string; session?: string; redacted?: number;
}
interface Group { command: string; runs: number; lastRun: string | null; firstRun?: string; cwd?: string; exit?: number | null; failedRuns?: number; shell: string; position?: number; redacted?: number }
interface HistorySource { shell: string; file: string; commands: number; from?: string; to?: string; times: string | null; error?: string }
interface Failure { error: string; hint?: string; looked?: string[] }
interface Definition { kind: string; name: string; value?: string; body?: string; text?: string; exported?: boolean; at: string; conditional?: boolean; overriddenBy?: string; inEffect?: boolean }

interface Window { since: string | null; until: string }
// Options shared by history, commands, programs and recall:
//   since, until: an ISO date or time (2026-10-14, 2026-10-14T03:00:00Z), a span back from now (36h, 7d, 2w, 3mo, 1y; "30min"), or today, yesterday, this week, last week, this month, last month, this year
//   cwd: a path, "~/x", "." (the working folder) or a folder name; only atuin and nushell record folders
//   program: the first program of the command, looking through sudo, env, time, nohup and the like
//   shell: zsh, bash, fish, atuin, nushell    exit: "failed", "ok" or a number    grep: text or a regular expression
//   limit: 1 to 1000
interface Filter { since?: string | number; until?: string | number; cwd?: string; program?: string; shell?: string; exit?: "failed" | "ok" | number | string; grep?: string; limit?: number; home?: string }

declare const shell: {
  // Which history files exist, how many commands, from when to when, which are merged, which shells were not found.
  sources(o?: { home?: string }): { home: string; sources: (HistorySource & { format: string; knows: string[]; note?: string })[]; commands: number; from?: string; to?: string; collapsed?: string; notFound: string[]; times: "UTC"; redaction: string } | Failure;

  // Commands in time order, the newest `limit` (default 50) of those that match. total counts every match.
  history(o?: Filter): { total: number; leftOut?: string; window?: Window; entries: Entry[]; notes?: string[]; sources: HistorySource[] } | (Failure & { entries: Entry[]; total: number });

  // The same command grouped: runs, last run, failed runs. Most-run first. minRuns default 1, limit default 20.
  commands(o?: Filter & { minRuns?: number }): { total: number; distinct: number; window?: Window; commands: Group[]; leftOut?: number; notes?: string[] } | Failure;

  // Programs by how often they were run. via counts the wrappers (sudo, builtin) a program ran through. limit default 20.
  programs(o?: Filter): { total: number; distinct: number; window?: Window; programs: { program: string; runs: number; lastRun: string | null; via?: Record<string, number> }[]; leftOut?: number; notes?: string[] } | Failure;

  // Past commands that hold the words, best first. Use it for "what was the command I used for X": give the words the
  // command would hold (program, file name, flag), not the words of the question. "a|b" in one word matches either.
  // Stop words (the, how, command, ran ...) are dropped. A command whose runs all failed scores lower (exit 127 is a
  // typo). matched/missing say which words a match holds. limit default 8.
  recall(words: string | string[], o?: Pick<Filter, Exclude<keyof Filter, "grep" | "exit">>): { words: string[]; found: number; window?: Window; matches: (Group & { matched: string[]; missing?: string[]; score: number; note?: string })[]; leftOut?: number; inNoCommand?: string[]; notes?: string[]; sources: HistorySource[] } | (Failure & { matches: Entry[] });

  // The startup files of a shell (zsh, bash or fish; default $SHELL) in the order the shell reads them, with what each
  // does, and counts of what they define. The files are read as text; a sourced file whose name says it holds
  // credentials (.env, secrets, token, .npmrc) is named, never read.
  startup(o?: { shell?: string; home?: string }): { shell: string; chosenBy: string; otherShells?: string[]; files: { order: number; file: string; sourcedBy?: string; readBy?: string; lines?: number; exists?: boolean; does: string; note?: string }[]; leftOut?: string; absent?: string[]; notes?: string[]; counts: Record<string, number> } | Failure;

  // Every definition the startup files hold, or of one kind: alias, abbr, function, variable, path, source, eval, unset.
  // grep matches the name, value or text. limit default 100.
  definitions(o?: { shell?: string; kind?: string; grep?: string; limit?: number; home?: string }): { shell: string; total: number; definitions: Definition[]; leftOut?: number } | Failure;

  // Where one alias, function or variable is defined: every definition in load order, the last one in effect, an
  // alias's final expansion, and what could set it without showing (eval and sourced files). Looks in the login
  // shell's files, then the others. A part of a name is tried when nothing matches exactly. `PATH` gives its changes.
  // inThisProcess is the variable's value in the process answering (credentials redacted), not in the user's terminal.
  defines(name: string, o?: { shell?: string; home?: string }): { name: string; matched?: string; shell: string; definitions?: Definition[]; expandsTo?: string; precedence?: string; inThisProcess?: string; pathChanges?: Definition[]; verdict: string; found?: false; couldComeFrom?: string[]; have?: Record<string, number> } | Failure;

  // PATH in order, each entry with the startup line that adds it; or, with `program`, every copy of that program on PATH
  // in order (wins is the first), where a copy is a link to, and an alias or function of that name that is used first.
  // With the user's own home, the order is the PATH of the process answering; with another home, the order the files build.
  path(o?: { program?: string; shell?: string; home?: string }): { verdict: string; shell: string | null; basis: string; wins?: any; copies?: any[]; shadowedBy?: Definition; entries?: { entry: number; dir: string; addedBy?: string; exists?: boolean; duplicate?: boolean }[]; pathChanges?: any[]; alsoChangePath?: string[] } | Failure;

  // What a command looks like once credentials are hidden: for checking text before you quote it.
  redact(command: string): { text: string; redacted: number };

  home: string;
};
