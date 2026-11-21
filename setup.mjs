// The shell's startup files, read in the order the shell reads them, and an index of what they
// define: aliases, functions, variables, PATH changes, and the lines that source or eval something.
// The files are read as text. The shell is never run: a login shell can be slow, hang or have
// side effects.
import fs from "node:fs";
import path from "node:path";
import { redact, redactValue, tokenize, unquote } from "./redact.mjs";

export const SHELLS = ["zsh", "bash", "fish"];
const MAX_DEPTH = 4;
const MAX_FILES = 80;
const MAX_BYTES = 512 * 1024;
const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}… (${s.length} characters)` : s);

// A sourced file that by its name holds credentials: noted, never read.
const SECRETS_FILE = /secret|credential|token|passw|private|(^|[./_-])env(\.|$)|\.netrc|api[-_]?keys?|\.npmrc|\.pgpass|\.aws|auth/i;

// Programs whose eval or source line changes the environment in ways the files do not show.
const TOOLS = [
  ["mise", /\bmise\b/], ["nvm", /\bnvm(\.sh)?\b/], ["direnv", /\bdirenv\b/], ["pyenv", /\bpyenv\b/], ["rbenv", /\brbenv\b/],
  ["homebrew", /\bbrew\b/], ["starship", /\bstarship\b/], ["zoxide", /\bzoxide\b/], ["fnm", /\bfnm\b/], ["asdf", /\basdf\b/],
  ["conda", /\b(conda|mamba)\b/], ["atuin", /\batuin\b/], ["fzf", /\bfzf\b/], ["volta", /\bvolta\b/], ["sdkman", /sdkman/],
  ["cargo", /\.cargo\/env/], ["oh-my-zsh", /oh-my-zsh/], ["nix", /\bnix\b/], ["rustup", /\brustup\b/], ["thefuck", /\bthefuck\b/],
  ["lesspipe", /\blesspipe\b/], ["dircolors", /\bdircolors\b/], ["ssh-agent", /\bssh-agent\b/], ["keychain", /\bkeychain\b/],
];
const CHANGES_PATH = new Set(["mise", "nvm", "pyenv", "rbenv", "homebrew", "fnm", "asdf", "conda", "volta", "sdkman", "cargo", "nix"]);
const toolOf = (text) => TOOLS.find(([, re]) => re.test(text))?.[0] ?? null;

/** Which of zsh, bash and fish have startup files of the user's own under this home. */
export function shellsWithFiles(ctx) {
  const has = (...p) => fs.existsSync(path.join(...p));
  const out = [];
  const zdot = ctx.zdotdir ?? ctx.home;
  if ([".zshenv", ".zprofile", ".zshrc", ".zlogin"].some((f) => has(zdot, f) || has(ctx.home, f))) out.push("zsh");
  if ([".bash_profile", ".bash_login", ".profile", ".bashrc"].some((f) => has(ctx.home, f))) out.push("bash");
  if (has(ctx.configHome, "fish", "config.fish") || has(ctx.configHome, "fish", "conf.d")) out.push("fish");
  return out;
}

/**
 * Read one shell's startup files. ctx: {home, etc (the folder standing for /etc, or null), live, zdotdir, configHome, push}.
 * Returns {shell, files:[...], defs:[...], notes:[...]} with defs in the order the shell meets them.
 */
export function loadSetup(ctx, shell) {
  const vars = new Map([["HOME", ctx.home]]);
  if (ctx.configHome) vars.set("XDG_CONFIG_HOME", ctx.configHome);
  if (ctx.zdotdir) vars.set("ZDOTDIR", ctx.zdotdir);
  const files = [];
  const defs = [];
  const notes = [];
  const seen = new Set();
  let seq = 0;

  const shown = (p) => {
    const rel = path.relative(ctx.home, p);
    if (!rel) return "~";
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `~/${rel.split(path.sep).join("/")}`;
    if (ctx.etc && !ctx.live) {
      const r = path.relative(ctx.etc, p);
      if (!r.startsWith("..") && !path.isAbsolute(r)) return `/etc/${r.split(path.sep).join("/")}`;
    }
    return p;
  };
  // Where a path written in a startup file is on disk: /etc maps to the fixture's etc when the home is not the real one.
  const onDisk = (p) => {
    if (ctx.live) return p;
    if (p === "/etc" || p.startsWith("/etc/")) return ctx.etc ? path.join(ctx.etc, p.slice(5)) : null;
    const rel = path.relative(ctx.home, p);
    return !rel.startsWith("..") && !path.isAbsolute(rel) ? p : null;
  };

  // Expand ~ and variables in a word from a startup file. {text, unresolved}
  const expand = (raw) => {
    let unresolved = false;
    let t = unquote(String(raw).trim());
    t = t.replace(/^~(?=$|\/)/, ctx.home);
    t = t.replace(/\$\{([A-Za-z_]\w*)(?::?[-=]([^}]*))?\}|\$([A-Za-z_]\w*)/g, (m, a, dflt, b) => {
      const name = a ?? b;
      if (vars.has(name)) return vars.get(name);
      if (dflt != null) return dflt.replace(/^~(?=$|\/)/, ctx.home).replace(/\$HOME\b|\$\{HOME\}/g, ctx.home);
      unresolved = true;
      return m;
    });
    if (/\$\(|`/.test(t)) unresolved = true;
    return { text: t, unresolved };
  };
  const add = (d) => {
    d.order = ++seq;
    defs.push(d);
    return d;
  };

  function glob(pattern) {
    // One * in the last segment is all the startup files use: /etc/profile.d/*.sh, conf.d/*.fish.
    const dir = onDisk(path.dirname(pattern));
    if (!dir) return [];
    const base = path.basename(pattern);
    const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => re.test(f))
        .sort()
        .map((f) => path.join(path.dirname(pattern), f));
    } catch {
      return [];
    }
  }

  /** Read one file and everything it sources. `written` is the path as the shell sees it. */
  function load(written, role, via, depth) {
    const real = onDisk(written);
    const entry = { file: real ? shown(real) : written, role, ...(via ? { sourcedBy: via } : {}), exists: false, defs: [] };
    if (!real) {
      entry.note = "outside the home folder that is being read: not read";
      files.push(entry);
      return entry;
    }
    if (seen.has(real)) return null;
    let st;
    try {
      st = fs.statSync(real);
    } catch {
      if (via) files.push({ ...entry, note: "sourced, but the file does not exist" });
      return entry;
    }
    if (!st.isFile()) return entry;
    entry.exists = true;
    seen.add(real);
    files.push(entry);
    if (files.length > MAX_FILES) {
      entry.note = `not read: more than ${MAX_FILES} files`;
      return entry;
    }
    if (st.size > MAX_BYTES) {
      entry.note = `not read: ${Math.round(st.size / 1024)} KB is over the ${MAX_BYTES / 1024} KB limit for a startup file`;
      return entry;
    }
    const started = Date.now();
    let text;
    try {
      text = fs.readFileSync(real, "utf8");
    } catch (e) {
      entry.note = `cannot be read: ${e.code ?? e.message}`;
      return entry;
    }
    ctx.push?.({ kind: "file", detail: entry.file, ms: Date.now() - started, size: st.size });
    entry.lines = text.split("\n").length;
    const from = defs.length;
    const here = { file: entry.file, real, depth };
    if (real.endsWith(".fish") || shell === "fish") parseFish(text, here);
    else parseSh(text, here);
    entry.defs = defs.slice(from).filter((d) => d.file === entry.file);
    return entry;
  }

  function source(target, here, line, conditional) {
    const e = expand(target);
    const where = `${here.file}:${line}`;
    const base = { kind: "source", name: e.text, file: here.file, line, conditional };
    if (e.unresolved) return add({ ...base, read: false, why: "the path holds a variable or a command the files do not set" });
    const written = path.isAbsolute(e.text) ? e.text : path.resolve(path.dirname(here.real), e.text);
    if (SECRETS_FILE.test(path.basename(written))) return add({ ...base, name: shownWritten(written), secrets: true, read: false, why: "by its name this file holds credentials: it is not read" });
    if (here.depth + 1 > MAX_DEPTH) return add({ ...base, name: shownWritten(written), read: false, why: `sourced more than ${MAX_DEPTH} files deep` });
    const d = add({ ...base, name: shownWritten(written), read: true });
    const got = load(written, "sourced", where, here.depth + 1);
    if (got && !got.exists) {
      d.read = false;
      d.why = got.note ?? "the file does not exist";
    } else if (got?.note) {
      d.read = false;
      d.why = got.note;
    }
    return d;
  }
  const shownWritten = (written) => {
    const real = onDisk(written);
    return real ? shown(real) : written;
  };

  // One PATH change. `items` are the words in order; the marker is where the old PATH goes.
  function pathChange(items, here, line, conditional, text) {
    const dirs = [];
    let marker = -1;
    for (const it of items) {
      if (/^("?)\$\{?(PATH|path|fish_user_paths)\}?\1$/.test(it.trim()) || /^"?\$\{?PATH[:}]/.test(it.trim())) {
        marker = dirs.length;
        continue;
      }
      if (!it.trim()) continue;
      const e = expand(it);
      dirs.push({ dir: e.text, ...(e.unresolved ? { unresolved: true } : {}) });
    }
    if (!dirs.length) return;
    const how = marker < 0 ? "replace" : marker === 0 ? "append" : marker === dirs.length ? "prepend" : "around";
    add({ kind: "path", name: "PATH", how, dirs, marker, file: here.file, line, conditional, text: clip(redact(text.trim()).text) });
  }

  function variable(name, rawValue, exported, here, line, conditional, text) {
    if (name === "PATH") {
      pathChange(unquote(rawValue).split(":"), here, line, conditional, text);
      return;
    }
    const e = expand(rawValue);
    if (!e.unresolved && !/[\s;]/.test(e.text) && e.text.length < 400) vars.set(name, e.text);
    add({ kind: "variable", name, value: clip(redactValue(name, unquote(rawValue))), exported, file: here.file, line, conditional });
  }

  function parseSh(text, here) {
    const lines = text.split("\n");
    let depthIf = 0;
    let fn = null; // {indent, def}
    let loop = null; // {name, patterns}
    for (let n = 0; n < lines.length; n++) {
      let lineNo = n + 1;
      let line = lines[n];
      while (line.endsWith("\\") && n + 1 < lines.length) line = line.slice(0, -1) + lines[++n];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;

      if (fn) {
        if (/^\}/.test(trimmed) && indent <= fn.indent) fn = null;
        else if (fn.def.body.length < 3) fn.def.body.push(clip(redact(trimmed).text, 120));
        continue;
      }
      const f = /^(?:function\s+([\w:.+-]+)\s*(?:\(\s*\))?|([\w:.+-]+)\s*\(\s*\))\s*(\{?)\s*(.*)$/.exec(trimmed);
      if (f && !/^(if|while|for|case|until|select)$/.test(f[1] ?? f[2])) {
        const def = add({ kind: "function", name: f[1] ?? f[2], body: [], file: here.file, line: lineNo, conditional: depthIf > 0 });
        const rest = f[4];
        if (rest && /\}\s*;?\s*$/.test(rest)) def.body.push(clip(redact(rest.replace(/;?\s*\}\s*;?\s*$/, "")).text, 120));
        else {
          if (rest) def.body.push(clip(redact(rest).text, 120));
          fn = { indent, def };
        }
        continue;
      }

      const lead = /&&|\|\|/.test(trimmed) || /^(if|elif|else|case|\[)/.test(trimmed);
      const conditional = depthIf > 0 || lead;
      if (/^(if|case|while|until)\b/.test(trimmed) && !/\b(fi|esac|done)\s*;?\s*$/.test(trimmed)) depthIf++;
      const fo = /^for\s+(\w+)\s+in\s+(.+?)\s*(?:;\s*do\b.*)?$/.exec(trimmed);
      if (fo) {
        loop = { name: fo[1], patterns: tokenize(fo[2]).filter((t) => !t.sep).map((t) => t.raw) };
        if (!/\bdone\s*;?\s*$/.test(trimmed)) depthIf++;
      }
      if (/^(fi|esac|done)\b/.test(trimmed)) {
        depthIf = Math.max(0, depthIf - 1);
        if (/^done\b/.test(trimmed)) loop = null;
        continue;
      }

      // Statements on the line: split at ; && || and the words then, do, else.
      const words = tokenize(trimmed);
      const stmts = [[]];
      for (const t of words) {
        if (t.sep) {
          if (/[;&|\n]/.test(t.raw)) stmts.push([]);
          continue;
        }
        if (/^(then|do|else|\{|\})$/.test(t.raw) && stmts[stmts.length - 1].length === 0) continue;
        if (t.raw.startsWith("#") && !/^#!/.test(t.raw)) break;
        if (/^(then|do|else)$/.test(t.raw)) {
          stmts.push([]);
          continue;
        }
        stmts[stmts.length - 1].push(t.raw);
      }
      for (const st of stmts) {
        if (!st.length) continue;
        const [w0, ...rest] = st;
        const stText = st.join(" ");
        if (w0 === "alias") {
          for (const a of rest) {
            if (a.startsWith("-")) continue;
            const m = /^([^=\s]+)=([\s\S]*)$/.exec(a);
            if (m) add({ kind: "alias", name: m[1], value: clip(redact(unquote(m[2])).text), file: here.file, line: lineNo, conditional });
          }
        } else if (w0 === "export" || ((w0 === "typeset" || w0 === "declare" || w0 === "local" || w0 === "readonly") && rest.length)) {
          const exported = w0 === "export" || /^-\w*x/.test(rest[0] ?? "");
          for (const a of rest) {
            if (a.startsWith("-")) continue;
            const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(a);
            if (m) variable(m[1], m[2], exported, here, lineNo, conditional, stText);
          }
        } else if (/^(path|PATH)\+?=\(/.test(w0)) {
          const inner = stText.replace(/^(path|PATH)\+?=\(/, "").replace(/\)\s*$/, "");
          const items = tokenize(inner).filter((t) => !t.sep).map((t) => t.raw);
          pathChange(/^(path|PATH)\+=/.test(w0) ? ["$path", ...items] : items, here, lineNo, conditional, stText);
        } else if (/^PATH\+=/.test(w0)) {
          pathChange(["$PATH", ...unquote(w0.slice(6)).split(":")], here, lineNo, conditional, stText);
        } else if (/^[A-Za-z_]\w*=/.test(w0) && rest.length === 0) {
          const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(w0);
          variable(m[1], m[2], false, here, lineNo, conditional, stText);
        } else if ((w0 === "source" || w0 === "." || w0 === "\\.") && rest[0]) {
          if (/^<\(/.test(rest[0])) add({ kind: "eval", name: toolOf(stText) ?? "command", text: clip(redact(stText).text), file: here.file, line: lineNo, conditional });
          else {
            const v = /^"?\$\{?(\w+)\}?"?$/.exec(rest[0]);
            if (loop && v && v[1] === loop.name) {
              for (const pat of loop.patterns) {
                const e = expand(pat);
                if (e.unresolved) continue;
                for (const file of /[*?]/.test(e.text) ? glob(e.text) : [e.text]) source(file, here, lineNo, true);
              }
            } else source(rest[0], here, lineNo, conditional);
          }
        } else if (w0 === "eval" && rest.length) {
          add({ kind: "eval", name: toolOf(stText) ?? "command", text: clip(redact(stText).text), file: here.file, line: lineNo, conditional });
        } else if ((w0 === "unset" || w0 === "unalias" || w0 === "unfunction" || w0 === "unsetopt") && rest.length && w0 !== "unsetopt") {
          for (const a of rest) if (!a.startsWith("-")) add({ kind: "unset", name: a, what: w0 === "unalias" ? "alias" : w0 === "unfunction" ? "function" : "variable", file: here.file, line: lineNo, conditional });
        }
      }
    }
  }

  function parseFish(text, here) {
    const lines = text.split("\n");
    let block = 0;
    let fn = null; // {depth, def}
    for (let n = 0; n < lines.length; n++) {
      const lineNo = n + 1;
      const trimmed = lines[n].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const opens = /^(if|for|while|switch|begin|function)\b/.test(trimmed) && !/;\s*end\s*$/.test(trimmed);
      if (fn) {
        if (opens) block++;
        else if (/^end\b/.test(trimmed)) {
          block--;
          if (block < fn.depth) fn = null;
        } else if (fn.def.body.length < 3) fn.def.body.push(clip(redact(trimmed).text, 120));
        if (fn && opens && fn.def.body.length < 3) fn.def.body.push(clip(redact(trimmed).text, 120));
        continue;
      }
      const words = tokenize(trimmed).filter((t) => !t.sep).map((t) => t.raw);
      const [w0, ...rest] = words;
      const conditional = block > 0;
      if (w0 === "function" && rest[0]) {
        const def = add({ kind: "function", name: rest[0], body: [], file: here.file, line: lineNo, conditional });
        const one = /;\s*(.*?);\s*end\s*$/.exec(trimmed);
        if (one) def.body.push(clip(redact(one[1]).text, 120));
        else {
          block++;
          fn = { depth: block, def };
        }
        continue;
      }
      if (opens) {
        block++;
        continue;
      }
      if (/^end\b/.test(trimmed)) {
        block = Math.max(0, block - 1);
        continue;
      }
      const args = rest.filter((a) => !a.startsWith("-"));
      const flags = rest.filter((a) => a.startsWith("-")).join(" ");
      if (/\|\s*source\s*$/.test(trimmed) || w0 === "eval") {
        add({ kind: "eval", name: toolOf(trimmed) ?? "command", text: clip(redact(trimmed).text), file: here.file, line: lineNo, conditional });
      } else if (w0 === "alias" && args.length) {
        const m = /^([^=\s]+)=([\s\S]*)$/.exec(args[0]);
        const name = m ? m[1] : args[0];
        const value = m ? unquote(m[2]) : args.slice(1).map(unquote).join(" ");
        add({ kind: "alias", name, value: clip(redact(value).text), file: here.file, line: lineNo, conditional });
      } else if (w0 === "abbr" && args.length >= 2 && !/-e\b|--erase/.test(flags)) {
        add({ kind: "abbr", name: args[0], value: clip(redact(args.slice(1).map(unquote).join(" ")).text), file: here.file, line: lineNo, conditional });
      } else if (w0 === "set" && args.length) {
        const name = args[0];
        if (/(^|\s)-\w*e|--erase/.test(flags)) add({ kind: "unset", name, what: "variable", file: here.file, line: lineNo, conditional });
        else if (name === "PATH" || name === "fish_user_paths") pathChange(args.slice(1), here, lineNo, conditional, trimmed);
        else if (args.length >= 2) {
          const exported = /(^|\s)-\w*x|--export/.test(flags);
          const raw = args.slice(1).join(" ");
          const e = expand(args[1]);
          if (!e.unresolved && args.length === 2) vars.set(name, e.text);
          add({ kind: "variable", name, value: clip(redactValue(name, args.slice(1).map(unquote).join(" "))), exported, file: here.file, line: lineNo, conditional, ...(raw ? {} : {}) });
        }
      } else if (w0 === "fish_add_path" && args.length) {
        const append = /(^|\s)-\w*a|--append/.test(flags);
        pathChange(append ? ["$PATH", ...args] : [...args, "$PATH"], here, lineNo, conditional, trimmed);
      } else if (w0 === "source" && rest[0]) {
        source(rest[0], here, lineNo, conditional);
      }
    }
  }

  // ---- the files, in the order the shell reads them ---------------------------------------------
  const etcFirst = (...names) => names.map((n) => `/etc/${n}`).find((p) => onDisk(p) && fs.existsSync(onDisk(p)));
  const absent = [];
  const top = (written, role) => {
    const got = load(written, role, null, 0);
    if (got && !got.exists && !got.note) absent.push(shownWritten(written));
  };
  if (shell === "zsh") {
    const sys = (n) => etcFirst(n, `zsh/${n}`);
    const zd = () => vars.get("ZDOTDIR") || ctx.home;
    if (sys("zshenv")) top(sys("zshenv"), "every zsh, first");
    top(path.join(zd(), ".zshenv"), "every zsh");
    // .zshenv often sets ZDOTDIR; the files after it are then read from there.
    if (sys("zprofile")) top(sys("zprofile"), "login shells");
    top(path.join(zd(), ".zprofile"), "login shells");
    if (sys("zshrc")) top(sys("zshrc"), "interactive shells");
    top(path.join(zd(), ".zshrc"), "interactive shells");
    if (sys("zlogin")) top(sys("zlogin"), "login shells, after .zshrc");
    top(path.join(zd(), ".zlogin"), "login shells, after .zshrc");
    if (zd() !== ctx.home) notes.push(`ZDOTDIR is ${shown(zd())}: zsh reads its files from there`);
  } else if (shell === "bash") {
    if (etcFirst("profile")) top("/etc/profile", "login shells, first");
    const login = [".bash_profile", ".bash_login", ".profile"].map((f) => path.join(ctx.home, f));
    const first = login.find((p) => fs.existsSync(p));
    if (first) {
      top(first, "login shells (bash reads the first of ~/.bash_profile, ~/.bash_login, ~/.profile that exists)");
      for (const p of login) if (p !== first && fs.existsSync(p) && !seen.has(p)) notes.push(`${shown(p)} exists but bash does not read it: ${shown(first)} comes first and does not source it`);
    } else absent.push("~/.bash_profile", "~/.profile");
    const rc = path.join(ctx.home, ".bashrc");
    if (!seen.has(rc)) {
      const sysrc = etcFirst("bash.bashrc", "bashrc");
      if (sysrc && !seen.has(onDisk(sysrc))) top(sysrc, "interactive shells that are not login shells");
      if (fs.existsSync(rc)) {
        top(rc, "interactive shells that are not login shells");
        if (first) notes.push(`${shown(first)} does not source ~/.bashrc, so a login shell (a new terminal on macOS, an ssh session) does not read it`);
      } else absent.push("~/.bashrc");
    }
  } else if (shell === "fish") {
    const dir = path.join(ctx.configHome, "fish");
    const sysConf = etcFirst("fish/config.fish");
    for (const f of glob("/etc/fish/conf.d/*.fish")) top(f, "every fish (system conf.d)");
    for (const f of glob(path.join(dir, "conf.d", "*.fish"))) top(f, "every fish (conf.d, in name order, before config.fish)");
    if (sysConf) top(sysConf, "every fish (system)");
    top(path.join(dir, "config.fish"), "every fish");
    for (const f of glob(path.join(dir, "functions", "*.fish"))) load(f, "a function file, loaded when the function is first called", null, 0);
  }
  return { shell, files, defs, notes, absent };
}

/** One line saying what a file does. */
export function summarise(file) {
  const by = (k) => file.defs.filter((d) => d.kind === k);
  const names = (list, n = 6) => {
    const u = [...new Set(list)];
    return u.slice(0, n).join(", ") + (u.length > n ? ` and ${u.length - n} more` : "");
  };
  const parts = [];
  const al = [...by("alias"), ...by("abbr")];
  if (al.length) parts.push(`${al.length} alias${al.length === 1 ? "" : "es"} (${names(al.map((d) => d.name))})`);
  const fn = by("function");
  if (fn.length) parts.push(`${fn.length} function${fn.length === 1 ? "" : "s"} (${names(fn.map((d) => d.name))})`);
  const ex = by("variable").filter((d) => d.exported);
  if (ex.length) parts.push(`exports ${names(ex.map((d) => d.name))}`);
  const loc = by("variable").filter((d) => !d.exported);
  if (loc.length) parts.push(`sets ${names(loc.map((d) => d.name))}`);
  for (const p of by("path")) parts.push(`PATH: ${p.how === "replace" ? "replaces it with" : p.how === "append" ? "appends" : p.how === "prepend" ? "prepends" : "adds"} ${names(p.dirs.map((d) => d.dir), 4)}`);
  const src = by("source");
  if (src.length) parts.push(`sources ${src.slice(0, 6).map((d) => d.name + (d.secrets ? " (a secrets file, not read)" : d.read ? "" : " (not read)")).join(", ")}${src.length > 6 ? ` and ${src.length - 6} more` : ""}`);
  const ev = by("eval");
  if (ev.length) parts.push(`evals ${names(ev.map((d) => d.name))}`);
  if (!parts.length) return file.exists ? (file.note ?? "defines nothing this kit indexes (options, prompt, completion or plain commands)") : (file.note ?? "does not exist");
  return parts.join("; ");
}

/** The PATH the files build, in order. The item {inherited: true} stands for the PATH the shell starts with. */
export function simulatePath(defs) {
  let sim = [{ inherited: true }];
  for (const d of defs) {
    if (d.kind !== "path") continue;
    const mine = d.dirs.map((x) => ({ dir: x.dir, ...(x.unresolved ? { unresolved: true } : {}), addedBy: `${d.file}:${d.line}`, how: d.how, ...(d.conditional ? { conditional: true } : {}) }));
    if (d.marker < 0) sim = mine;
    else sim = [...mine.slice(0, d.marker), ...sim, ...mine.slice(d.marker)];
  }
  return sim;
}
