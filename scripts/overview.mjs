export const meta = {
  purpose:
    "What this kit can read: which shell history files exist (zsh, bash, fish, atuin, nushell), how many commands and over which dates, whether each records times, folders and exit codes, and which startup files the login shell reads in order with what each does. Start here when a question does not say which shell, or to learn why a question about folders or exit codes has no answer.",
  params: { shell: "the shell whose startup files to list, default the login shell", home: "a home folder to read instead of the user's own (tests)" },
  returns: "{verdict, history:{commands, from, to, sources:[{shell, file, commands, from, to, times, knows, note?}]}, startup:{shell, chosenBy, files:[{order, file, readBy|sourcedBy, lines, does}], counts}}",
  example: 'await scripts.run("overview")',
};

export default async function ({ shell }, { shell: sh, home } = {}) {
  const h = shell.sources({ home });
  if (h.error) return { verdict: h.error, ...h };
  const s = shell.startup({ shell: sh, home });
  const hist = { commands: h.commands, ...(h.from ? { from: h.from, to: h.to } : {}), times: h.times, sources: h.sources, ...(h.collapsed ? { collapsed: h.collapsed } : {}), redaction: h.redaction };
  const names = h.sources.map((x) => `${x.shell} ${x.commands}`).join(", ");
  return {
    verdict: `history: ${h.commands} commands (${names || "none found"}); startup: ${s.error ? s.error : `${s.shell}, ${s.files.length} files`}`,
    history: hist,
    startup: s.error ? { error: s.error, hint: s.hint } : s,
  };
}
