export const meta = {
  purpose:
    "What was typed in a terminal in a period or a folder: the newest commands that match, in time order, with folder, exit code and duration where the history records them. For 'what did I run yesterday', 'what did I run in ~/work/app', 'which commands failed today', 'every ssh command this week'. Credentials in commands are hidden as <redacted>.",
  params: {
    since: "start: 2026-10-12, 36h, 7d, 2w, today, yesterday, this week, last month",
    until: "end, in the same forms",
    cwd: "folder (a path, ~ or a folder name; needs atuin or nushell history)",
    grep: "text or regular expression the command must hold (searched after redaction)",
    program: "only commands that start with this program (sudo, env and time are looked through)",
    exit: "'failed', 'ok' or a number (needs atuin or nushell history)",
    shell: "zsh, bash, fish, atuin or nushell",
    limit: "commands to return, the newest, default 30",
    home: "a home folder to read instead of the user's own (tests)",
  },
  returns: "{verdict, total, entries:[{time, command, cwd?, exit?, duration?, shell, also?, redacted?}], leftOut?, window?, notes?, sources}",
  example: 'await scripts.run("history", { since: "yesterday", program: "ssh" })',
};

export default async function ({ shell }, { since, until, cwd, grep, program, exit, shell: sh, limit, home } = {}) {
  const r = shell.history({ since, until, cwd, grep, program, exit, shell: sh, home, limit: limit ?? 30 });
  if (r.error) return { verdict: r.error, ...r };
  const span = r.window ? ` between ${r.window.since ?? "the start"} and ${r.window.until}` : "";
  return { verdict: `${r.total} command${r.total === 1 ? "" : "s"}${span}${r.leftOut ? `; the newest ${r.entries.length} are shown` : ""}`, ...r };
}
