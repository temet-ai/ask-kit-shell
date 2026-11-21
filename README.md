# ask-kit-shell

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about your own shell. A cheap model reads your shell history and startup files
outside your agent's context and answers with the command, the time and the file and line it
found. It reads zsh, bash and fish history, an atuin database when there is one, and the startup
files of zsh, bash and fish. It runs no shell and changes nothing.

Questions it is for:

- What was the command I used to restore the database dump?
- Where is the alias `gco` set, and what does it run?
- Why does `node` run the wrong version: which copy is first on PATH, and which line of my
  startup files put its folder there?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) 0.3 or later and Node.js 22.13 or
newer (ask-kit needs a recent Node anyway). Nothing else is installed. Linux and macOS.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-shell
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-shell        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-shell --yes  # installs and enables it
```

Restart your agents so `ask` lists `shell`. Two optional settings: `WORKDIR`, the folder a
question means by "here" (detected), and `SHELL_HOME`, a home folder to read instead of your own.

## What it carries

Scripts, each of which also runs with no model (`ask-kit run shell <script> key=value`):

- `recall`: past commands that match words, best first, with when, where and whether it worked.
- `history`: what was run in a period or a folder, filtered by program, text, shell or exit code.
- `usage`: the programs and the exact commands run most often.
- `defines`: every definition of an alias, function or variable in load order, the one in effect
  and what an alias expands to.
- `which`: every copy of a program on PATH in order, which runs, which startup line added each
  folder, and an alias or function that hides it; with no program, the whole PATH.
- `overview`: which history files exist, how many commands, which record folders and exit codes,
  and the startup files in the order the shell reads them.

The kit has no skills or roles: each question is one call.

## What it can change

Nothing. Every call reads files. A history database in WAL mode is opened read-only, and a
database with no pending journal is opened immutable, so no file is created beside it. SQLite may
update the shared-memory file of a WAL database it reads.

Shell history holds secrets typed on command lines, and what the kit returns goes to a cloud
model, so everything it returns is redacted by pattern: values of passwords, tokens and keys
(`-pSECRET`, `--password x`, `API_KEY=x`, `Authorization: Bearer x`, `user:pass@host`, strings
shaped like known keys, `--teleport x`) become `<redacted>`, and searches run on the redacted
text. A secret typed in a form no pattern knows, such as a bare argument to an unfamiliar
program, is not caught. Startup files whose names say they hold credentials are never read, and
values of variables named like credentials are redacted. `bench/questions.json` has a fake history
with invented secrets and checks that none comes back.

## How well it works

`bench/questions.json` holds 13 shots that run with no model and 5 questions for a model, all put
to a fake home folder built by `bench/fixture/build.mjs`. The 13 shots passed on 2026-11-21 on
Linux (`node bench/check.mjs ask-kit`). The 5 questions have not been run on a model. They were
written for the fixture, not taken from recorded sessions.

The scripts were also run on a real zsh and atuin history of 9,600 commands, and the redaction
was checked over all of it for the common secret shapes. macOS paths for atuin and nushell
history are in the code but were not run on a Mac, and fish history was read only from the
fixture.

[RECIPE.md](RECIPE.md) says what it reads and how to rebuild it. MIT licence.
