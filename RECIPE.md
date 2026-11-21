# Recipe: the shell kit

## What it answers

The command typed for something before; what was run in a period or a folder, and what failed;
which programs and commands are run most; where an alias, function or environment variable is
set; why one program runs instead of another because of PATH. It does not act.

## What it needs

- ask-kit 0.3.0 or later (`min_ask_kit = "0.3.0"`), `platforms = ["linux", "macos"]`.
- Node.js 22.13 or newer for `node:sqlite` (atuin and nushell databases). No program is run.
- Settings: `WORKDIR` (detected) and `SHELL_HOME` (empty: the user's own home).

## What it reads

History: atuin (`$ATUIN_DB_PATH` or `$XDG_DATA_HOME/atuin/history.db`), zsh (`$HISTFILE` when it
names zsh, `$ZDOTDIR/.zsh_history`, `~/.zsh_history`, `.zhistory`, `.histfile`), bash
(`~/.bash_history`), fish (`$XDG_DATA_HOME/fish/fish_history`), nushell (`history.sqlite3` or
`history.txt` under the config folder or `~/Library/Application Support/nushell`). A file larger
than 32 MB is read from its end; a database, the newest 100,000 rows. The same command at the same
moment in two histories counts once. zsh's metafied bytes and continuation lines are undone.
Atuin's exit -1 (a command with no recorded end) is treated as unknown, not as failed.

Startup files, as text, in the order the shell reads them: zsh (`/etc/zshenv` and its siblings, `.zshenv`,
`.zprofile`, `.zshrc`, `.zlogin`, with `$ZDOTDIR`), bash (`/etc/profile`, `.bash_profile`,
`.bash_login`, `.profile`, `.bashrc`) and fish (`config.fish`, `conf.d`, `functions`), following
`source` and `.` up to 4 files deep and 80 files. It indexes aliases, abbreviations, functions,
exports and assignments, PATH changes, `source` lines and `eval` lines of well-known tools. A
sourced file whose name says it holds credentials (`.env`, secrets, token, `.npmrc`, `.aws`) is
named and not read. Nothing is evaluated: a PATH built by `mise activate` or by a command
substitution is reported as hidden (`alsoChangePath`), not computed.

PATH with the user's own home is the PATH of the ask-kit process, each entry matched to the startup
line that adds it; with another home it is what the files build, and only folders inside that home
are looked at. A program is looked for with `stat` and an execute-permission check in each folder.

## Redaction

`redact.mjs` runs on every command before it leaves `shell.mjs`, and on the value of every
variable. Rules by pattern: flag and variable names that look like credentials, the password flags
of programs (mysql `-p`, sshpass, curl `-u`, docker login and others), headers, URL userinfo,
strings shaped like known keys, `NAME=value` with a credential name, secrets fed on standard input,
`secret set` commands, and the Claude Code `--teleport` id. Search runs on redacted text. A secret
in a shape no rule knows is not caught.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.shell`, name `shell`, `says`, `keywords`,
`route_hint`, `cite`, `platforms`, the two settings, one `[[sources]]` of kind `module`, name
`shell`, module `shell.mjs`, api `api.d.ts`, `instructions = "instructions.md"`, and one
`[[actions]]`, `which`).

`redact.mjs` exports `redact(command) -> {text, redacted}`, `redactValue(name, value)`, `tokenize`,
`unquote`, `baseName` and `programOf` (the first program of a command through `sudo`, `env`,
`time`). `setup.mjs` exports `loadSetup(ctx, shell)` (files in load order and their definitions),
`summarise`, `simulatePath` and `shellsWithFiles`. `shell.mjs` exports `make({settings, push})`
returning `sources`, `history`, `commands`, `programs`, `recall` (words scored by inverse document
frequency over distinct commands, failed commands and fragments of longer matches scored lower),
`startup`, `definitions`, `defines`, `path` and `redact`. Every function takes `home`.

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and
`export default async function ({shell}, params)`): `recall`, `history`, `usage`, `defines`,
`which`, `overview`, each returning a `verdict` or the module's `error`.

`instructions.md` follows the docker kit's structure: scripts first; `recall` takes the words the
command would hold; only atuin and nushell record folders and exit codes; the last definition in
load order is in effect; evals can hide changes; an alias hides its program; credentials are
off limits; the kit only reads.

## Bench

`node bench/fixture/build.mjs` builds the fake home. `node bench/check.mjs ask-kit` runs the 13
shots through `ask-kit run`. The 5 questions (`q`) need `ask-kit kit test shell`, which calls a
model; it has not been run.

## Results

Shots, 2026-11-21, Linux: 13/13. No model run yet.
