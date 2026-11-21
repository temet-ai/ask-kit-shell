export const meta = {
  purpose:
    "What gets typed most: the programs run most often, or the most repeated exact commands, in a period or folder. For 'which commands do I run most', 'what do I use git for', 'what did I repeat this month'. Shows both lists, so a command worth an alias stands out.",
  params: {
    since: "start: 2026-10-01, 30d, this month",
    until: "end",
    cwd: "folder (needs atuin or nushell history)",
    program: "count only commands of this program",
    minRuns: "for the repeated commands, the fewest runs, default 2",
    limit: "rows in each list, default 15",
    home: "a home folder to read instead of the user's own (tests)",
  },
  returns: "{verdict, total, programs:[{program, runs, lastRun, via?}], repeated:[{command, runs, lastRun, exit?, shell}], notes?}",
  example: 'await scripts.run("usage", { since: "30d" })',
};

export default async function ({ shell }, { since, until, cwd, program, minRuns, limit, home } = {}) {
  const o = { since, until, cwd, program, home, limit: limit ?? 15 };
  const p = shell.programs(o);
  if (p.error) return { verdict: p.error, ...p };
  const c = shell.commands({ ...o, minRuns: minRuns ?? 2 });
  const notes = [...new Set([...(p.notes ?? []), ...(c.notes ?? [])])];
  const top = p.programs[0];
  return {
    verdict: `${p.total} commands, ${p.distinct} programs${top ? `; most run: ${top.program} (${top.runs})` : ""}${c.commands[0] ? `; most repeated command: ${c.commands[0].command} (${c.commands[0].runs})` : ""}`,
    total: p.total,
    programs: p.programs,
    ...(p.leftOut ? { programsLeftOut: p.leftOut } : {}),
    repeated: c.commands,
    ...(c.leftOut ? { repeatedLeftOut: c.leftOut } : {}),
    ...(notes.length ? { notes } : {}),
  };
}
