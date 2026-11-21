export const meta = {
  purpose:
    "Where an alias, function, abbreviation or environment variable is set: the file and line of every definition in the shell's startup files, in load order, which one is in effect, and what an alias finally expands to. For 'where is gco defined', 'where does JAVA_HOME come from', 'why does EDITOR say vim'. Also says what in the files could set it without showing (an eval or a sourced secrets file). Values that look like credentials are hidden. The files are read as text; no shell is run.",
  params: {
    name: "the alias, function or variable name; $ is ignored. A part of a name works when nothing matches exactly",
    shell: "zsh, bash or fish; default the login shell ($SHELL), then the others",
    home: "a home folder to read instead of the user's own (tests)",
  },
  returns: "{verdict, name, matched, shell, definitions:[{kind, name, value?, body?, at, overriddenBy?, inEffect?, conditional?}], expandsTo?, precedence?, inThisProcess?, couldComeFrom?, pathChanges?}",
  example: 'await scripts.run("defines", { name: "gco" })',
};

export default async function ({ shell }, { name, shell: sh, home } = {}) {
  if (!name) throw new Error("defines needs `name`: an alias, function or variable");
  const r = shell.defines(name, { shell: sh, home });
  if (r.error) return { verdict: r.error, ...r };
  return r;
}
