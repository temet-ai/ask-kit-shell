export const meta = {
  purpose:
    "Why a program is not the one expected: every copy of it on PATH in order, which one runs, which startup file line put its folder where it is, where each copy is a link to, and whether an alias or function with the same name is used before PATH is searched. For 'why does node run the wrong version', 'which python is first', 'what is on my PATH'. Without a program: the whole PATH in order, with folders that do not exist and duplicates marked.",
  params: {
    program: "a bare program name such as node; leave out for the whole PATH",
    shell: "zsh, bash or fish; default the login shell",
    home: "a home folder to read instead of the user's own (tests); its PATH is the one its startup files build",
  },
  returns: "{verdict, program?, wins, copies:[{entry, dir, file, addedBy?, linksTo?}], shadowedBy?, pathChanges, alsoChangePath?} or {verdict, entries:[{entry, dir, addedBy?, exists, duplicate?}], leftOut?}",
  example: 'await scripts.run("which", { program: "node" })',
};

export default async function ({ shell }, { program, shell: sh, home } = {}) {
  const r = shell.path({ program, shell: sh, home });
  if (r.error) return { verdict: r.error, ...r };
  return r;
}
