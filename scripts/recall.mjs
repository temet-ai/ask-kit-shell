export const meta = {
  purpose:
    "Which command did I run for something: past commands that match the words, best first, with when it last ran, in which folder, whether it worked and how often. The answer to 'what was the command I used to restore the database', 'how did I convert that video'. Give the words the command would hold (a program, a file name, a flag); a|b matches either word. Commands that always failed or were a typo rank low. Credentials in commands are hidden as <redacted>.",
  params: {
    words: "the words the command would hold, for example 'pg_restore dump' or 'ffmpeg scale'",
    since: "only commands after this: 2026-10-12, 7d, 2w, yesterday, this week",
    until: "only commands before this",
    cwd: "only commands run in this folder (needs atuin or nushell history); a path or a folder name",
    program: "only commands that start with this program",
    limit: "matches to return, default 8",
    home: "a home folder to read instead of the user's own (tests)",
  },
  returns: "{verdict, words, found, matches:[{command, runs, lastRun, cwd?, exit?, failedRuns?, shell, matched, missing?, score, note?}], inNoCommand?, notes?, sources}",
  example: 'await scripts.run("recall", { words: "pg_restore dump" })',
};

export default async function ({ shell }, { words, since, until, cwd, program, limit, home } = {}) {
  if (!words) throw new Error("recall needs `words`: the program, file name or flag the command would hold");
  const r = shell.recall(words, { since, until, cwd, program, limit, home });
  if (r.error) return { verdict: r.error, ...r };
  const top = r.matches[0];
  const verdict = !top
    ? `no past command holds ${r.words.join(", ")}${r.inNoCommand?.length ? ` (no command has ${r.inNoCommand.join(", ")})` : ""}`
    : `${r.found} command${r.found === 1 ? "" : "s"} match; best: ${top.command}${top.lastRun ? ` (last run ${top.lastRun}${top.runs > 1 ? `, ${top.runs} runs` : ""}${top.cwd ? ` in ${top.cwd}` : ""}${top.exit != null ? `, exit ${top.exit}` : ""})` : ""}`;
  return { verdict, ...r };
}
