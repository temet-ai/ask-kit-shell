// The user's own shell history and shell setup: what they typed in a terminal (zsh, bash, fish,
// atuin, nushell) and what their startup files define (aliases, functions, variables,
// PATH). Everything is read from files; no shell is run and nothing is changed.
//
// Shell history is full of credentials, and what this module returns goes to a cloud model, so
// every command passes through redact() before it leaves (see redact.mjs). Searches run on the
// redacted text, so a search cannot be used to test what a hidden value is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { baseName, programOf, redact, redactValue, tokenize, unquote } from "./redact.mjs";
import { SHELLS, loadSetup, shellsWithFiles, simulatePath, summarise } from "./setup.mjs";

const MAX_FILE = 32 * 1024 * 1024; // a history file is read from its end, at most this much
const MAX_ROWS = 100_000; // newest rows read from a history database
const MAX_LIMIT = 1000;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(".000Z", "Z"));
const clip = (s, n = 600) => (s.length > n ? `${s.slice(0, n)}… (${s.length} characters)` : s);
const param = (msg) => {
  throw new Error(msg);
};

// ---- time ---------------------------------------------------------------------------------------

const UNIT = { min: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3, mo: 30 * 86400e3, y: 365 * 86400e3 };

/** A moment from a param: an ISO date or time, epoch seconds, "7d", "36h", "2w", "3mo", today, yesterday, this/last week, this/last month. */
function when(x, now, edge) {
  if (x == null || x === "") return null;
  if (x instanceof Date) return x.getTime();
  if (typeof x === "number") return x < 1e11 ? x * 1000 : x;
  const s = String(x).trim().toLowerCase();
  if (/^\d{9,10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{12,13}$/.test(s)) return Number(s);
  const rel = /^(\d+(?:\.\d+)?)\s*(min|mins|minutes?|h|hours?|d|days?|w|weeks?|mo|months?|y|years?)(?:\s+ago)?$/.exec(s);
  if (rel) {
    const u = rel[2].startsWith("min") ? "min" : rel[2].startsWith("mo") ? "mo" : rel[2][0];
    return now - Number(rel[1]) * UNIT[u];
  }
  const day = (d, add) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + add).getTime();
  const n = new Date(now);
  const start = edge === "since";
  if (s === "now") return now;
  if (s === "today") return start ? day(n, 0) : now;
  if (s === "yesterday") return start ? day(n, -1) : day(n, 0) - 1;
  const dow = (n.getDay() + 6) % 7; // Monday first
  if (s === "this week") return start ? day(n, -dow) : now;
  if (s === "last week") return start ? day(n, -dow - 7) : day(n, -dow) - 1;
  if (s === "this month") return start ? new Date(n.getFullYear(), n.getMonth(), 1).getTime() : now;
  if (s === "last month") return start ? new Date(n.getFullYear(), n.getMonth() - 1, 1).getTime() : new Date(n.getFullYear(), n.getMonth(), 1).getTime() - 1;
  if (s === "this year") return start ? new Date(n.getFullYear(), 0, 1).getTime() : now;
  if (s === "last year") return start ? new Date(n.getFullYear() - 1, 0, 1).getTime() : new Date(n.getFullYear(), 0, 1).getTime() - 1;
  const dateOnly = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s);
  if (dateOnly) return start ? new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]).getTime() : new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3] + 1).getTime() - 1;
  const monthOnly = /^(\d{4})-(\d\d)$/.exec(s);
  if (monthOnly) return start ? new Date(+monthOnly[1], +monthOnly[2] - 1, 1).getTime() : new Date(+monthOnly[1], +monthOnly[2], 1).getTime() - 1;
  const t = Date.parse(String(x).trim());
  if (!Number.isNaN(t)) return t;
  param(`cannot read the time "${x}": give an ISO date or time (2026-10-14, 2026-10-14T03:00:00Z), a span back from now (36h, 7d, 2w, 3mo, 1y; minutes are "30min"), or today, yesterday, this week, last week, this month, last month`);
}

// ---- history files ------------------------------------------------------------------------------

function readTail(file) {
  const st = fs.statSync(file);
  if (st.size <= MAX_FILE) return { buf: fs.readFileSync(file), size: st.size, cut: false };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(MAX_FILE);
    fs.readSync(fd, buf, 0, MAX_FILE, st.size - MAX_FILE);
    const nl = buf.indexOf(10);
    return { buf: buf.subarray(nl + 1), size: st.size, cut: true };
  } finally {
    fs.closeSync(fd);
  }
}

// zsh writes bytes 0x83 to 0xa2 of a command as 0x83 followed by the byte xor 0x20 ("metafied").
// Non-ASCII text in UTF-8 hits that range, so the file is not valid UTF-8 until this is undone.
export function unmetafy(buf) {
  if (buf.indexOf(0x83) < 0) return buf;
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x83 && i + 1 < buf.length) out[j++] = buf[++i] ^ 0x20;
    else out[j++] = buf[i];
  }
  return out.subarray(0, j);
}

function parseZsh(buf) {
  const lines = unmetafy(buf).toString("utf8").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line) continue;
    const parts = [];
    // A newline inside a command is written as a backslash at the end of the line.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      parts.push(line.slice(0, -1));
      line = lines[++i];
    }
    parts.push(line);
    const text = parts.join("\n");
    const m = /^: (\d+):(\d+);([\s\S]*)$/.exec(text);
    if (m) out.push({ ms: Number(m[1]) * 1000, dur: Number(m[2]), raw: m[3] });
    else out.push({ ms: null, raw: text });
  }
  return out;
}

function parseBash(buf) {
  const lines = buf.toString("utf8").split("\n");
  const timed = lines.some((l) => /^#\d{9,11}$/.test(l));
  const out = [];
  if (!timed) {
    for (const l of lines) if (l.trim()) out.push({ ms: null, raw: l });
    return out;
  }
  let cur = null;
  for (const l of lines) {
    const m = /^#(\d{9,11})$/.exec(l);
    if (m) {
      if (cur?.raw) out.push(cur);
      cur = { ms: Number(m[1]) * 1000, raw: "" };
    } else if (cur) cur.raw = cur.raw ? `${cur.raw}\n${l}` : l;
    else if (l.trim()) out.push({ ms: null, raw: l });
  }
  if (cur?.raw) out.push(cur);
  for (const e of out) e.raw = e.raw.replace(/\n+$/, "");
  return out;
}

function parseFish(buf) {
  const out = [];
  let cur = null;
  for (const l of buf.toString("utf8").split("\n")) {
    if (l.startsWith("- cmd: ")) {
      if (cur) out.push(cur);
      cur = { ms: null, raw: l.slice(7).replace(/\\(\\|n)/g, (m, c) => (c === "n" ? "\n" : "\\")) };
    } else if (cur && /^\s+when: \d+/.test(l)) cur.ms = Number(/\d+/.exec(l)[0]) * 1000;
  }
  if (cur) out.push(cur);
  return out;
}

// One command per line; a line ending in the continuation character goes on in the next.
function parsePlain(buf, cont) {
  const out = [];
  let cur = null;
  for (const l of buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    if (cur != null) cur += `\n${l}`;
    else if (l.trim()) cur = l;
    else continue;
    if (cont && cur.endsWith(cont)) {
      cur = cur.slice(0, -1);
      continue;
    }
    out.push({ ms: null, raw: cur });
    cur = null;
  }
  if (cur) out.push({ ms: null, raw: cur });
  return out;
}

// A history database another program may have open. It is opened read-only. When nothing is
// pending in a -wal beside it, it is opened immutable, which creates and locks nothing.
function openDb(file) {
  const wal = (() => {
    try {
      return fs.statSync(`${file}-wal`).size;
    } catch {
      return 0;
    }
  })();
  const uri = `file:${encodeURI(path.resolve(file).split(path.sep).join("/")).replace(/\?/g, "%3f").replace(/#/g, "%23")}?immutable=1`;
  const tries = wal ? [() => new DatabaseSync(file, { readOnly: true, timeout: 1500 }), () => new DatabaseSync(uri, { readOnly: true })] : [() => new DatabaseSync(uri, { readOnly: true }), () => new DatabaseSync(file, { readOnly: true, timeout: 1500 })];
  let last;
  for (const [i, t] of tries.entries()) {
    try {
      const db = t();
      try {
        db.prepare("select count(*) from sqlite_schema").get();
        return { db, note: wal && i === 1 ? "the database has changes waiting in its -wal that could not be read: the newest commands may be missing" : null };
      } catch (e) {
        db.close();
        throw e;
      }
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

function readAtuin(file) {
  const { db, note } = openDb(file);
  try {
    const cols = db.prepare("select name from pragma_table_info('history')").all().map((r) => r.name);
    if (!cols.includes("command") || !cols.includes("timestamp")) throw new Error("no history table with command and timestamp columns: not an atuin database this kit knows");
    const del = cols.includes("deleted_at") ? "where deleted_at is null" : "";
    const rows = db.prepare(`select timestamp / 1000000 as ms, duration / 1000000 as dms, exit, command, cwd, session, hostname from history ${del} order by timestamp desc limit ${MAX_ROWS}`).all();
    rows.reverse();
    return { note, cut: rows.length === MAX_ROWS, entries: rows.map((r) => ({ ms: Number(r.ms), raw: String(r.command), cwd: r.cwd && r.cwd !== "unknown" ? r.cwd : undefined, exit: r.exit == null || Number(r.exit) < 0 || Number(r.dms) < 0 ? undefined : Number(r.exit), dur: Number(r.dms) >= 0 ? Math.round(Number(r.dms)) / 1000 : undefined, host: r.hostname ? String(r.hostname).split(":")[0] : undefined, session: r.session ?? undefined })) };
  } finally {
    db.close();
  }
}

function readNu(file) {
  const { db, note } = openDb(file);
  try {
    const rows = db.prepare(`select command_line, start_timestamp, duration_ms, exit_status, cwd, session_id, hostname from history order by id desc limit ${MAX_ROWS}`).all();
    rows.reverse();
    return { note, cut: rows.length === MAX_ROWS, entries: rows.map((r) => ({ ms: r.start_timestamp == null ? null : Number(r.start_timestamp), raw: String(r.command_line), cwd: r.cwd ?? undefined, exit: r.exit_status == null ? undefined : Number(r.exit_status), dur: r.duration_ms == null ? undefined : Number(r.duration_ms) / 1000, host: r.hostname ?? undefined, session: r.session_id == null ? undefined : String(r.session_id) })) };
  } finally {
    db.close();
  }
}

// Richer sources win when the same command at the same moment is in several.
const RANK = { atuin: 0, nushell: 1, fish: 2, zsh: 3, bash: 4 };

// ---- the module ---------------------------------------------------------------------------------

export function make({ settings = {}, push = () => {} } = {}) {
  const workdir = path.resolve(settings.WORKDIR || process.env.WORKDIR || process.cwd());
  const realHome = path.resolve(os.homedir());
  const defaultHome = settings.SHELL_HOME || process.env.SHELL_HOME || "";
  const cache = new Map();

  /** Where to read: the home folder, whether it is the user's real one, and the folder standing for /etc. */
  function context(o = {}) {
    const given = o.home ?? defaultHome;
    let home = realHome;
    if (given) {
      const s = String(given);
      home = s === "~" ? realHome : s.startsWith("~/") ? path.join(realHome, s.slice(2)) : path.resolve(workdir, s);
    }
    const live = home === realHome;
    if (!fs.existsSync(home)) return { home, live, missing: true };
    const env = live ? process.env : {};
    const sibling = path.join(home, "..", "etc");
    return {
      home,
      live,
      etc: live ? "/etc" : fs.existsSync(sibling) ? sibling : null,
      configHome: env.XDG_CONFIG_HOME || path.join(home, ".config"),
      dataHome: env.XDG_DATA_HOME || path.join(home, ".local", "share"),
      zdotdir: env.ZDOTDIR || null,
      env,
      push,
    };
  }
  const tilde = (ctx, p) => {
    const rel = path.relative(ctx.home, p);
    return !rel ? "~" : !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : p;
  };
  const noHome = (ctx) => ({ error: `no such folder: ${ctx.home}`, hint: "home is the home folder to read; leave it out for the user's own" });

  /** The history files that could exist under this home, in the order they are tried. */
  function candidates(ctx) {
    const h = ctx.home;
    const j = path.join;
    const zdot = ctx.zdotdir || h;
    const list = [
      { shell: "atuin", kind: "atuin", file: ctx.env.ATUIN_DB_PATH || j(ctx.dataHome, "atuin", "history.db") },
      { shell: "zsh", kind: "zsh", file: ctx.env.HISTFILE && /zsh|zhistory/i.test(ctx.env.HISTFILE) ? ctx.env.HISTFILE : null },
      { shell: "zsh", kind: "zsh", file: j(zdot, ".zsh_history") },
      { shell: "zsh", kind: "zsh", file: j(h, ".zsh_history") },
      { shell: "zsh", kind: "zsh", file: j(h, ".zhistory") },
      { shell: "zsh", kind: "zsh", file: j(zdot, ".histfile") },
      { shell: "bash", kind: "bash", file: ctx.env.HISTFILE && /bash/i.test(ctx.env.HISTFILE) ? ctx.env.HISTFILE : null },
      { shell: "bash", kind: "bash", file: j(h, ".bash_history") },
      { shell: "fish", kind: "fish", file: j(ctx.dataHome, "fish", "fish_history") },
      { shell: "nushell", kind: "nu-sqlite", file: j(ctx.configHome, "nushell", "history.sqlite3") },
      { shell: "nushell", kind: "nu-text", file: j(ctx.configHome, "nushell", "history.txt") },
      { shell: "nushell", kind: "nu-sqlite", file: j(h, "Library", "Application Support", "nushell", "history.sqlite3") },
      { shell: "nushell", kind: "nu-text", file: j(h, "Library", "Application Support", "nushell", "history.txt") },
    ];
    const seen = new Set();
    return list.filter((c) => c.file && !seen.has(c.file) && seen.add(c.file));
  }

  /** Read every history source under the home and merge them. Cached until a file changes. */
  function load(ctx) {
    const found = [];
    for (const c of candidates(ctx)) {
      try {
        const st = fs.statSync(c.file);
        if (st.isFile()) found.push({ ...c, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
    const sig = found.map((f) => `${f.file}:${f.size}:${f.mtime}`).join("|");
    const hit = cache.get(ctx.home);
    if (hit?.sig === sig) return hit;

    const sources = [];
    const all = [];
    for (const f of found) {
      const started = Date.now();
      const src = { shell: f.shell, file: tilde(ctx, f.file), format: f.kind };
      let entries = [];
      try {
        if (f.kind === "atuin" || f.kind === "nu-sqlite") {
          const r = f.kind === "atuin" ? readAtuin(f.file) : readNu(f.file);
          entries = r.entries;
          if (r.note) src.note = r.note;
          if (r.cut) src.note = `only the newest ${MAX_ROWS} commands are read`;
        } else {
          const { buf, cut } = readTail(f.file);
          entries = f.kind === "zsh" ? parseZsh(buf) : f.kind === "bash" ? parseBash(buf) : f.kind === "fish" ? parseFish(buf) : parsePlain(buf, null);
          if (cut) src.note = `the file is ${Math.round(f.size / 1048576)} MB: only its last ${MAX_FILE / 1048576} MB is read`;
        }
      } catch (e) {
        src.error = String(e.message ?? e).split("\n")[0];
      }
      push({ kind: f.kind === "atuin" || f.kind === "nu-sqlite" ? "sqlite" : "file", detail: src.file, ms: Date.now() - started, size: f.size, code: src.error ? 1 : 0 });
      entries = entries.filter((e) => e.raw && e.raw.trim());
      const timed = entries.filter((e) => e.ms != null);
      src.commands = entries.length;
      src.times = !entries.length ? null : timed.length === entries.length ? "every command" : timed.length ? `${timed.length} of ${entries.length} commands` : "none";
      if (timed.length) {
        src.from = iso(Math.min(...timed.slice(0, 1).map((e) => e.ms), timed.reduce((m, e) => Math.min(m, e.ms), Infinity)));
        src.to = iso(timed.reduce((m, e) => Math.max(m, e.ms), -Infinity));
      }
      src.knows = ["command", ...(timed.length ? ["time"] : []), ...(entries.some((e) => e.cwd) ? ["folder"] : []), ...(entries.some((e) => e.exit != null) ? ["exit code"] : []), ...(entries.some((e) => e.dur != null) ? ["duration"] : []), ...(entries.some((e) => e.host) ? ["host"] : [])];
      if (entries.length && !timed.length) {
        const why = f.kind === "bash" ? "bash writes times only when HISTTIMEFORMAT is set" : f.kind === "zsh" ? "zsh writes times only with the EXTENDED_HISTORY option" : "this format has no times";
        src.note = [src.note, `no times (${why}): these commands have an order only, oldest first`].filter(Boolean).join("; ");
      }
      sources.push(src);
      let pos = 0;
      for (const e of entries) all.push({ ...e, shell: f.shell, src: sources.length - 1, pos: ++pos });
    }

    // Time order; a source without times keeps its own order and goes first.
    const untimed = all.filter((e) => e.ms == null);
    const timedAll = all.filter((e) => e.ms != null).sort((a, b) => a.ms - b.ms || RANK[a.shell] - RANK[b.shell]);
    // The same command at the same moment in two sources (shared history, an import) is one command.
    const merged = [];
    const lastByCommand = new Map();
    let collapsed = 0;
    for (const e of timedAll) {
      const key = e.raw.trim();
      const prev = lastByCommand.get(key);
      if (prev && prev.src !== e.src && !prev.also?.includes(e.shell) && Math.abs(e.ms - prev.ms) <= 2000) {
        collapsed++;
        const keep = RANK[e.shell] < RANK[prev.shell] ? e : prev;
        const drop = keep === e ? prev : e;
        const also = [...new Set([...(prev.also ?? []), drop.shell])];
        if (keep === e) {
          merged[merged.indexOf(prev)] = e;
          lastByCommand.set(key, e);
        }
        keep.also = also;
        for (const k of ["cwd", "exit", "dur", "host", "session"]) if (keep[k] == null && drop[k] != null) keep[k] = drop[k];
        continue;
      }
      merged.push(e);
      lastByCommand.set(key, e);
    }
    const entries = [...untimed, ...merged];
    const value = { sig, sources, entries, collapsed };
    cache.set(ctx.home, value);
    return value;
  }

  // The redacted text of an entry, worked out once.
  const text = (e) => {
    if (e.red == null) {
      const r = redact(e.raw);
      e.red = r.text;
      e.hid = r.redacted;
    }
    return e.red;
  };
  const programFor = (e) => {
    if (e.prog == null) {
      const words = [];
      for (const t of tokenize(text(e))) {
        if (t.sep) {
          if (/[;|&\n]/.test(t.raw)) break;
        } else words.push(unquote(t.raw));
      }
      const p = programOf(words);
      e.prog = p.name || "";
      e.via = p.via;
    }
    return e.prog;
  };
  const publish = (e) => ({
    time: iso(e.ms),
    ...(e.ms == null ? { position: e.pos } : {}),
    command: clip(text(e)),
    ...(e.cwd ? { cwd: e.cwd } : {}),
    ...(e.exit != null ? { exit: e.exit } : {}),
    ...(e.dur != null ? { duration: e.dur } : {}),
    shell: e.shell,
    ...(e.also ? { also: e.also } : {}),
    ...(e.host ? { host: e.host } : {}),
    ...(e.session ? { session: e.session } : {}),
    ...(e.hid ? { redacted: e.hid } : {}),
  });

  /** A filter over merged entries from the common options. Returns {keep, notes, window}. */
  function filter(ctx, data, o) {
    const now = o.now ? when(o.now, Date.now(), "since") : Date.now();
    const since = when(o.since, now, "since");
    const until = when(o.until, now, "until");
    const notes = [];
    let list = data.entries;
    if (since != null || until != null) {
      const before = list.length;
      const untimed = list.filter((e) => e.ms == null);
      list = list.filter((e) => e.ms != null && (since == null || e.ms >= since) && (until == null || e.ms <= until));
      if (untimed.length && before) {
        const by = [...new Set(untimed.map((e) => data.sources[e.src].file))];
        notes.push(`${untimed.length} commands from ${by.join(", ")} have no times and are left out of a time window`);
      }
    }
    if (o.cwd != null && o.cwd !== "") {
      let want = String(o.cwd);
      if (want === ".") want = workdir;
      else if (want === "~" || want.startsWith("~/")) want = ctx.live ? path.join(ctx.home, want.slice(2)) : want.slice(1);
      const withCwd = list.filter((e) => e.cwd);
      const norm = (p) => p.replace(/\/+$/, "");
      want = norm(want) || "/";
      let match = "exact";
      let got = withCwd.filter((e) => norm(e.cwd) === want || e.cwd.startsWith(`${want}/`));
      if (!got.length && !path.isAbsolute(want)) {
        match = "folder name";
        got = withCwd.filter((e) => baseName(norm(e.cwd)) === want);
      }
      if (!got.length) {
        match = "substring";
        const low = want.toLowerCase();
        got = withCwd.filter((e) => e.cwd.toLowerCase().includes(low));
      }
      const folders = [...new Set(got.map((e) => e.cwd))];
      notes.push(got.length ? `folder matched by ${match}: ${folders.slice(0, 5).join(", ")}${folders.length > 5 ? ` and ${folders.length - 5} more` : ""}` : `no command was recorded in a folder matching ${o.cwd}`);
      const without = [...new Set(data.sources.filter((s) => s.commands && !s.knows.includes("folder")).map((s) => s.shell))];
      if (without.length) notes.push(`${without.join(", ")} history does not record the folder, so its commands cannot be matched to one`);
      if (!withCwd.length) notes.push("no history source here records the folder a command ran in (atuin and nushell's database do)");
      list = got;
    }
    if (o.program != null && o.program !== "") {
      const p = String(o.program).toLowerCase();
      list = list.filter((e) => programFor(e).toLowerCase() === p);
    }
    if (o.shell != null && o.shell !== "") {
      const s = String(o.shell).toLowerCase();
      list = list.filter((e) => e.shell === s || e.also?.includes(s));
    }
    if (o.exit != null && o.exit !== "") {
      const x = String(o.exit).toLowerCase();
      const known = list.filter((e) => e.exit != null);
      if (!known.length && list.length) notes.push("no history source here records exit codes (atuin and nushell's database do)");
      if (/^(failed|fail|nonzero|non-zero|error|!0)$/.test(x)) list = known.filter((e) => e.exit !== 0);
      else if (/^(ok|success|succeeded|0)$/.test(x)) list = known.filter((e) => e.exit === 0);
      else if (/^-?\d+$/.test(x)) list = known.filter((e) => e.exit === Number(x));
      else param(`exit must be a number, "ok" or "failed"; got ${o.exit}`);
    }
    if (o.grep != null && o.grep !== "") {
      let re;
      try {
        re = new RegExp(String(o.grep), "i");
      } catch {
        re = new RegExp(String(o.grep).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        notes.push("grep is not a valid regular expression: matched as plain text");
      }
      list = list.filter((e) => re.test(text(e)));
    }
    return { list, notes, now, window: since != null || until != null ? { since: iso(since), until: iso(until ?? now) } : null };
  }

  const brief = (data) => data.sources.map((s) => ({ shell: s.shell, file: s.file, commands: s.commands, ...(s.from ? { from: s.from, to: s.to } : {}), times: s.times, ...(s.error ? { error: s.error } : {}) }));
  const none = (ctx) => ({ error: `no shell history found under ${ctx.live ? "~" : ctx.home}`, looked: candidates(ctx).map((c) => tilde(ctx, c.file)).slice(0, 12), hint: "history is written when a shell exits; a home with no interactive shell use has none" });
  const limitOf = (o, dflt) => {
    if (o.limit == null || o.limit === "") return dflt;
    const n = Number(o.limit);
    if (!Number.isInteger(n) || n < 1) param(`limit must be a whole number from 1 to ${MAX_LIMIT}; got ${o.limit}`);
    return Math.min(n, MAX_LIMIT);
  };

  // ---- history ----------------------------------------------------------------------------------

  function sources(o = {}) {
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const data = load(ctx);
    const timed = data.entries.filter((e) => e.ms != null);
    return {
      home: ctx.live ? "~" : ctx.home,
      sources: data.sources,
      commands: data.entries.length,
      ...(timed.length ? { from: iso(timed[0].ms), to: iso(timed[timed.length - 1].ms) } : {}),
      ...(data.collapsed ? { collapsed: `${data.collapsed} commands were in two sources at the same moment and are counted once` } : {}),
      notFound: candidates(ctx).map((c) => c.shell).filter((s, i, a) => a.indexOf(s) === i && !data.sources.some((x) => x.shell === s)),
      times: "UTC",
      redaction: "credentials in commands are replaced with <redacted> by pattern; a secret that matches no pattern is not caught",
    };
  }

  function history(o = {}) {
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const data = load(ctx);
    if (!data.entries.length) return { ...none(ctx), sources: data.sources, entries: [], total: 0 };
    const { list, notes, window } = filter(ctx, data, o);
    const limit = limitOf(o, 50);
    const shownList = list.slice(-limit);
    return {
      total: list.length,
      ...(list.length > shownList.length ? { leftOut: `${list.length - shownList.length} earlier matches (the newest ${limit} are shown; narrow with grep, since or until)` } : {}),
      ...(window ? { window } : {}),
      entries: shownList.map(publish),
      ...(notes.length ? { notes } : {}),
      sources: brief(data),
    };
  }

  /** Commands grouped by their exact text. */
  function group(list) {
    const groups = new Map();
    for (const e of list) {
      const key = text(e).trim().replace(/[ \t]+/g, " ");
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { command: key, runs: 0, ok: 0, failed: 0, first: e, last: e, shells: new Set(), cwds: new Map() }));
      g.runs++;
      if (e.exit === 0) g.ok++;
      else if (e.exit != null) g.failed++;
      g.shells.add(e.shell);
      if (e.cwd) g.cwds.set(e.cwd, (g.cwds.get(e.cwd) ?? 0) + 1);
      g.last = e; // the list is in time order
    }
    return [...groups.values()];
  }
  const groupOut = (g) => ({
    command: clip(g.command),
    runs: g.runs,
    lastRun: iso(g.last.ms),
    ...(g.last.ms == null ? { position: g.last.pos } : {}),
    ...(g.runs > 1 && g.first.ms != null ? { firstRun: iso(g.first.ms) } : {}),
    ...(g.last.cwd ? { cwd: g.last.cwd } : {}),
    ...(g.ok + g.failed ? { exit: g.last.exit ?? null, ...(g.failed ? { failedRuns: g.failed } : {}) } : {}),
    shell: [...g.shells].join(", "),
    ...(g.last.hid ? { redacted: g.last.hid } : {}),
  });

  function commands(o = {}) {
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const data = load(ctx);
    if (!data.entries.length) return { ...none(ctx), commands: [], total: 0 };
    const { list, notes, window } = filter(ctx, data, o);
    const limit = limitOf(o, 20);
    const min = Number(o.minRuns ?? 1);
    const groups = group(list).filter((g) => g.runs >= min).sort((a, b) => b.runs - a.runs || (b.last.ms ?? 0) - (a.last.ms ?? 0));
    return { total: list.length, distinct: groups.length, ...(window ? { window } : {}), commands: groups.slice(0, limit).map(groupOut), ...(groups.length > limit ? { leftOut: groups.length - limit } : {}), ...(notes.length ? { notes } : {}) };
  }

  function programs(o = {}) {
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const data = load(ctx);
    if (!data.entries.length) return { ...none(ctx), programs: [], total: 0 };
    const { list, notes, window } = filter(ctx, data, o);
    const limit = limitOf(o, 20);
    const by = new Map();
    for (const e of list) {
      const p = programFor(e);
      if (!p) continue;
      let g = by.get(p);
      if (!g) by.set(p, (g = { program: p, runs: 0, last: e, via: new Map() }));
      g.runs++;
      g.last = e;
      for (const v of e.via ?? []) g.via.set(v, (g.via.get(v) ?? 0) + 1);
    }
    const rows = [...by.values()].sort((a, b) => b.runs - a.runs || a.program.localeCompare(b.program));
    return {
      total: list.length,
      distinct: rows.length,
      ...(window ? { window } : {}),
      programs: rows.slice(0, limit).map((g) => ({ program: g.program, runs: g.runs, lastRun: iso(g.last.ms), ...(g.via.size ? { via: Object.fromEntries(g.via) } : {}) })),
      ...(rows.length > limit ? { leftOut: rows.length - limit } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  const STOP = new Set("the a an i my me to of for in on at it is was did do does how what which when where that this with from and or command commands cmd used use ran run running last time again".split(" "));

  /** Past commands that match words, best first. A word matches when the command contains it; a|b matches either. */
  function recall(words, o = {}) {
    const raw = (Array.isArray(words) ? words.join(" ") : String(words ?? "")).toLowerCase().split(/[\s,]+/).map((w) => w.replace(/^["'`(]+|["'`)?.!]+$/g, "")).filter(Boolean);
    if (!raw.length) param("recall needs words: the program, a file name, a flag or any other text the command would hold (for example \"pg_restore watch\")");
    const kept = raw.filter((w) => !STOP.has(w));
    const terms = [...new Set(kept.length ? kept : raw)].slice(0, 12).map((w) => ({ word: w, any: w.split("|").filter(Boolean) }));
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const data = load(ctx);
    if (!data.entries.length) return { ...none(ctx), matches: [] };
    const { list, notes, window } = filter(ctx, data, o);
    const limit = limitOf(o, 8);
    const groups = group(list);
    const lows = groups.map((g) => g.command.toLowerCase());
    const N = groups.length;
    for (const t of terms) {
      t.df = lows.reduce((n, c) => n + (t.any.some((a) => c.includes(a)) ? 1 : 0), 0);
      t.idf = Math.log(1 + N / (1 + t.df));
    }
    const full = terms.reduce((s, t) => s + t.idf, 0) || 1;
    let scored = [];
    groups.forEach((g, i) => {
      const matched = terms.filter((t) => t.any.some((a) => lows[i].includes(a)));
      if (!matched.length) return;
      let score = matched.reduce((s, t) => s + t.idf, 0) / full;
      const why = [];
      if (g.failed && !g.ok) {
        score *= g.last.exit === 127 ? 0.4 : 0.6;
        why.push(g.last.exit === 127 ? "the program was not found: a typo" : "every recorded run failed");
      }
      scored.push({ g, score, matched: matched.map((t) => t.word), missing: terms.filter((t) => !matched.includes(t)).map((t) => t.word), why });
    });
    scored.sort((a, b) => b.score - a.score);
    // A command that is the start of a better one is a fragment of it.
    const topN = scored.slice(0, 60);
    for (const a of topN) {
      if (topN.some((b) => b !== a && b.g.command.length > a.g.command.length && b.g.command.startsWith(a.g.command) && b.score >= a.score && !(b.g.failed && !b.g.ok))) {
        a.score *= 0.7;
        a.why.push("the start of a longer command that also matched");
      }
    }
    scored.sort((a, b) => b.score - a.score || (b.g.ok > 0) - (a.g.ok > 0) || (b.g.last.ms ?? 0) - (a.g.last.ms ?? 0) || b.g.runs - a.g.runs);
    return {
      words: terms.map((t) => t.word),
      found: scored.length,
      ...(window ? { window } : {}),
      matches: scored.slice(0, limit).map((s) => ({ ...groupOut(s.g), matched: s.matched, ...(s.missing.length ? { missing: s.missing } : {}), score: Math.round(s.score * 100) / 100, ...(s.why.length ? { note: s.why.join("; ") } : {}) })),
      ...(scored.length > limit ? { leftOut: scored.length - limit } : {}),
      ...(terms.some((t) => !t.df) ? { inNoCommand: terms.filter((t) => !t.df).map((t) => t.word) } : {}),
      ...(notes.length ? { notes } : {}),
      sources: brief(data),
    };
  }

  // ---- setup ------------------------------------------------------------------------------------

  function pickShell(ctx, asked) {
    const have = shellsWithFiles(ctx);
    if (asked != null && asked !== "") {
      const s = String(asked).toLowerCase();
      if (!SHELLS.includes(s)) param(`shell must be one of ${SHELLS.join(", ")}; got ${asked}${have.length ? ` (startup files here: ${have.join(", ")})` : ""}`);
      return { shell: s, have, why: "asked for" };
    }
    const login = ctx.live ? baseName(ctx.env.SHELL || "") : "";
    if (SHELLS.includes(login) && (have.includes(login) || !have.length)) return { shell: login, have, why: "$SHELL" };
    if (have.length) return { shell: have[0], have, why: `the first of ${SHELLS.join(", ")} with startup files in this home` };
    return { shell: null, have, why: null };
  }
  function setupFor(ctx, asked) {
    const pick = pickShell(ctx, asked);
    if (!pick.shell) return { pick, setup: null };
    const key = `setup:${ctx.home}:${pick.shell}`;
    const setup = loadSetup(ctx, pick.shell);
    cache.set(key, setup);
    return { pick, setup };
  }
  const noSetup = (ctx) => ({ error: `no startup files of ${SHELLS.join(", ")} under ${ctx.live ? "~" : ctx.home}`, hint: "this kit reads the startup files of zsh, bash and fish" });
  const others = (pick) => {
    const o = pick.have.filter((s) => s !== pick.shell);
    return o.length ? { otherShells: o } : {};
  };

  function startup(o = {}) {
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const { pick, setup } = setupFor(ctx, o.shell);
    if (!setup) return noSetup(ctx);
    const files = setup.files.map((f, i) => ({ order: i + 1, file: f.file, ...(f.sourcedBy ? { sourcedBy: f.sourcedBy } : { readBy: f.role }), ...(f.exists ? { lines: f.lines } : { exists: false }), does: summarise(f), ...(f.note && f.exists ? { note: f.note } : {}) }));
    const cap = 40;
    return {
      shell: pick.shell,
      chosenBy: pick.why,
      ...others(pick),
      files: files.slice(0, cap),
      ...(files.length > cap ? { leftOut: `${files.length - cap} more sourced files` } : {}),
      ...(setup.absent.length ? { absent: setup.absent } : {}),
      ...(setup.notes.length ? { notes: setup.notes } : {}),
      counts: Object.fromEntries(["alias", "abbr", "function", "variable", "path", "source", "eval"].map((k) => [k, setup.defs.filter((d) => d.kind === k).length]).filter(([, n]) => n)),
    };
  }

  const defOut = (d) => ({ kind: d.kind === "unset" ? `unset ${d.what}` : d.kind, name: d.name, ...(d.value != null ? { value: d.value } : {}), ...(d.body ? { body: d.body } : {}), ...(d.text ? { text: d.text } : {}), ...(d.kind === "variable" ? { exported: d.exported } : {}), at: `${d.file}:${d.line}`, ...(d.conditional ? { conditional: true } : {}) });

  /** Every alias, function, variable, PATH change, source or eval line the startup files hold, or those of one kind. */
  function definitions(o = {}) {
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const { pick, setup } = setupFor(ctx, o.shell);
    if (!setup) return noSetup(ctx);
    const kinds = ["alias", "abbr", "function", "variable", "path", "source", "eval", "unset"];
    if (o.kind != null && !kinds.includes(String(o.kind))) param(`kind must be one of ${kinds.join(", ")}; got ${o.kind}`);
    let list = setup.defs.filter((d) => !o.kind || d.kind === o.kind);
    if (o.grep) {
      const low = String(o.grep).toLowerCase();
      list = list.filter((d) => `${d.name} ${d.value ?? ""} ${d.text ?? ""}`.toLowerCase().includes(low));
    }
    const limit = limitOf(o, 100);
    return { shell: pick.shell, total: list.length, definitions: list.slice(0, limit).map(defOut), ...(list.length > limit ? { leftOut: list.length - limit } : {}) };
  }

  function defines(name, o = {}) {
    if (name == null || String(name).trim() === "") param("defines needs a name: an alias, a function or a variable (for example gco, mkcd or JAVA_HOME)");
    const want = String(name).trim().replace(/^\$/, "");
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const first = pickShell(ctx, o.shell);
    if (!first.shell) return noSetup(ctx);
    const order = o.shell ? [first.shell] : [first.shell, ...first.have.filter((s) => s !== first.shell)];
    const NAMED = new Set(["alias", "abbr", "function", "variable", "unset"]);
    let fallback = null;
    for (const sh of order) {
      const setup = loadSetup(ctx, sh);
      const named = setup.defs.filter((d) => NAMED.has(d.kind));
      let matched = "exact";
      let hits = named.filter((d) => d.name === want);
      if (!hits.length) {
        matched = "exact, ignoring case";
        hits = named.filter((d) => d.name.toLowerCase() === want.toLowerCase());
      }
      if (!hits.length && want.length >= 2 && want !== "PATH") {
        matched = "substring";
        hits = named.filter((d) => d.name.toLowerCase().includes(want.toLowerCase()));
      }
      const pathDefs = want === "PATH" ? setup.defs.filter((d) => d.kind === "path") : [];
      if (!hits.length && !pathDefs.length) {
        fallback ??= { setup, sh };
        continue;
      }
      // Within one name and kind, the last definition in load order is the one in effect.
      const out = [];
      const names = [...new Set(hits.map((d) => d.name))];
      const effective = [];
      for (const n of names.slice(0, 20)) {
        const mine = hits.filter((d) => d.name === n);
        const kindOf = (d) => (d.kind === "unset" ? d.what : d.kind);
        for (const k of [...new Set(mine.map(kindOf))]) {
          const chain = mine.filter((d) => kindOf(d) === k);
          const last = chain[chain.length - 1];
          chain.forEach((d, i) => {
            const later = chain[i + 1];
            out.push({ ...defOut(d), ...(later ? { overriddenBy: `${later.file}:${later.line}${later.conditional ? " (conditional)" : ""}` } : { inEffect: d.kind !== "unset" }) });
          });
          if (last.kind !== "unset") effective.push(last);
          else effective.push({ ...last, removed: true });
        }
      }
      const res = { name: want, matched, shell: sh, ...(sh !== first.shell ? { note: `not defined in the ${first.shell} startup files; found in ${sh}'s` } : {}), definitions: out.slice(0, 30) };
      if (hits.length > 30) res.leftOut = hits.length - 30;
      if (pathDefs.length) res.pathChanges = pathDefs.slice(0, 20).map(defOut).concat([]);
      if (pathDefs.length) res.hint = "PATH is built up by several lines: path() gives the resulting order and what adds each entry";
      // What an alias runs when its first word is itself an alias.
      const aliasMap = new Map();
      for (const d of setup.defs) if (d.kind === "alias" || d.kind === "abbr") aliasMap.set(d.name, d.value);
      for (const d of setup.defs) if (d.kind === "unset" && d.what === "alias") aliasMap.delete(d.name);
      const eff = effective.find((d) => (d.kind === "alias" || d.kind === "abbr") && d.name === want);
      if (eff) {
        let value = eff.value;
        const seenNames = new Set([eff.name]);
        for (let i = 0; i < 5; i++) {
          const w0 = value.trim().split(/\s+/)[0];
          if (!aliasMap.has(w0) || seenNames.has(w0)) break;
          seenNames.add(w0);
          value = `${aliasMap.get(w0)}${value.trim().slice(w0.length)}`;
        }
        res.expandsTo = value;
      }
      const kindsHit = new Set(effective.filter((d) => d.name === want && !d.removed).map((d) => d.kind));
      if (kindsHit.has("alias") && kindsHit.has("function")) res.precedence = "an alias and a function share this name: the alias is expanded first when the name is typed as a command";
      if (ctx.live && effective.some((d) => d.kind === "variable" && d.name === want) && process.env[want] != null) res.inThisProcess = clip(redactValue(want, process.env[want]), 300);
      const win = effective.filter((d) => d.name === want || names.length === 1);
      res.verdict = !out.length
        ? `PATH is changed by ${pathDefs.length} line${pathDefs.length === 1 ? "" : "s"}`
        : names.length > 1
          ? `no ${want} exactly; ${names.length} names contain it: ${names.slice(0, 8).join(", ")}`
          : win.map((d) => (d.removed ? `${d.what} ${d.name} is removed at ${d.file}:${d.line}` : `${d.kind} ${d.name} is set at ${d.file}:${d.line}${d.value != null ? ` to ${clip(d.value, 120)}` : ""}`)).join("; ") + (out.some((d) => d.overriddenBy) ? `; ${out.filter((d) => d.overriddenBy).length} earlier definition${out.filter((d) => d.overriddenBy).length === 1 ? " is" : "s are"} overridden` : "");
      return res;
    }
    const { setup, sh } = fallback;
    const count = (k) => setup.defs.filter((d) => d.kind === k).length;
    const res = { name: want, found: false, shell: sh, ...(order.length > 1 ? { alsoSearched: order.slice(1) } : {}), verdict: `${want} is not set in the ${order.join(", ")} startup files this kit read`, have: { aliases: count("alias") + count("abbr"), functions: count("function"), variables: count("variable") } };
    const evals = setup.defs.filter((d) => d.kind === "eval" || (d.kind === "source" && !d.read));
    if (evals.length) res.couldComeFrom = evals.slice(0, 8).map((d) => `${d.file}:${d.line} ${d.kind === "eval" ? d.text : `source ${d.name} (${d.why})`}`);
    if (ctx.live && process.env[want] != null) res.inThisProcess = `${clip(redactValue(want, process.env[want]), 300)} (set in the environment, but not by a startup file this kit read: it may come from the system, the terminal, a login manager or an eval line)`;
    return res;
  }

  /** Whether dir holds a program called name that can be run. Returns the file or null. */
  function programIn(dir, name) {
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) return null;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      return null;
    }
  }

  function pathOf(o = {}) {
    const ctx = context(o);
    if (ctx.missing) return noHome(ctx);
    const { pick, setup } = setupFor(ctx, o.shell);
    const defs = setup?.defs ?? [];
    const sim = simulatePath(defs);
    const probe = (dir) => {
      if (!path.isAbsolute(dir)) return null;
      if (!ctx.live) {
        const rel = path.relative(ctx.home, dir);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // outside the home that is being read: not looked at
      }
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    };
    const show = (dir) => (path.isAbsolute(dir) ? tilde(ctx, dir) : dir);
    const fromFiles = sim.map((e) => (e.inherited ? { inherited: "the PATH the shell starts with (from the system, the terminal or the login session)" } : { dir: show(e.dir), addedBy: e.addedBy, how: e.how, ...(e.conditional ? { conditional: true } : {}), ...(e.unresolved ? { unresolved: "holds a variable or command the files do not set" } : { exists: probe(e.dir) }) }));
    const byDir = new Map();
    for (const e of sim) if (!e.inherited && !byDir.has(e.dir)) byDir.set(e.dir, e);
    // The order that counts: this process's PATH when the home is the user's own, otherwise what the files build.
    let entries;
    let basis;
    if (ctx.live) {
      basis = "the PATH of the ask-kit process, with each entry matched to the startup file line that adds it";
      const seenDirs = new Set();
      entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => {
        const e = byDir.get(dir) ?? byDir.get(dir.replace(/\/+$/, ""));
        const dup = seenDirs.has(dir);
        seenDirs.add(dir);
        return { real: dir, dir: show(dir), ...(e ? { addedBy: e.addedBy } : {}), exists: probe(dir), ...(dup ? { duplicate: true } : {}) };
      });
    } else {
      basis = "the order the startup files build; folders outside the home that is being read are not looked at";
      entries = sim.filter((e) => !e.inherited).map((e) => ({ real: e.dir, dir: show(e.dir), addedBy: e.addedBy, exists: e.unresolved ? null : probe(e.dir) }));
    }
    entries.forEach((e, i) => (e.entry = i + 1));
    const evals = defs.filter((d) => d.kind === "eval" && ["mise", "nvm", "pyenv", "rbenv", "homebrew", "fnm", "asdf", "conda", "volta", "sdkman", "nix"].includes(d.name));
    const srcs = defs.filter((d) => d.kind === "source" && !d.read);
    const hidden = [...evals.map((d) => `${d.file}:${d.line} ${d.text}`), ...srcs.map((d) => `${d.file}:${d.line} source ${d.name} (${d.why})`)];
    const base = {
      shell: pick.shell,
      basis,
      ...(setup ? {} : { note: `no startup files of ${SHELLS.join(", ")} here: entries cannot be matched to a line` }),
    };
    const out = (e) => ({ entry: e.entry, dir: e.dir, ...(e.addedBy ? { addedBy: e.addedBy } : {}), ...(e.exists == null ? {} : { exists: e.exists }), ...(e.duplicate ? { duplicate: true } : {}) });
    const also = hidden.length ? { alsoChangePath: hidden.slice(0, 8), alsoChangePathNote: "these lines change PATH when they run, in ways the files do not show" } : {};

    if (o.program != null && o.program !== "") {
      const name = String(o.program).trim();
      if (name.includes("/")) param(`program is a bare name such as node, not a path; got ${name}`);
      const copies = [];
      for (const e of entries) {
        if (e.exists !== true || e.duplicate) continue;
        const file = programIn(e.real, name);
        if (!file) continue;
        let target = null;
        try {
          const realFile = fs.realpathSync(file);
          if (realFile !== file) target = tilde(ctx, realFile);
        } catch {}
        copies.push({ ...out(e), file: `${e.dir}/${path.basename(file)}`.replace(/\/\//g, "/"), ...(target ? { linksTo: target } : {}) });
      }
      const shadow = defs.filter((d) => (d.kind === "alias" || d.kind === "function" || d.kind === "abbr") && d.name === name);
      const sh = shadow[shadow.length - 1];
      const win = copies[0];
      const verdict = !win
        ? `no ${name} in any PATH folder ${ctx.live ? "of this process" : "under this home that the files add"}`
        : `${name} runs from ${win.file}: entry ${win.entry} of PATH${win.addedBy ? `, added by ${win.addedBy}` : ", not added by a startup file this kit read"}${copies.length > 1 ? `; it comes before ${copies.slice(1).map((c) => `${c.file} (entry ${c.entry}${c.addedBy ? `, ${c.addedBy}` : ""})`).join(", ")}` : "; no other copy on PATH"}`;
      return {
        verdict: sh ? `${sh.kind} ${name} at ${sh.file}:${sh.line} is used before PATH is searched${sh.value ? ` (${clip(sh.value, 80)})` : ""}; on PATH, ${verdict}` : verdict,
        program: name,
        ...base,
        wins: win ?? null,
        copies,
        ...(sh ? { shadowedBy: defOut(sh) } : {}),
        ...(setup ? { pathChanges: defs.filter((d) => d.kind === "path").slice(0, 20).map((d) => ({ at: `${d.file}:${d.line}`, how: d.how, dirs: d.dirs.map((x) => show(x.dir)), ...(d.conditional ? { conditional: true } : {}) })) } : {}),
        ...also,
      };
    }
    const cap = 60;
    const missing = entries.filter((e) => e.exists === false);
    return {
      verdict: `${entries.length} PATH entries${missing.length ? `, ${missing.length} of them folders that do not exist` : ""}; first is ${entries[0]?.dir ?? "none"}${entries[0]?.addedBy ? ` (added by ${entries[0].addedBy})` : ""}`,
      ...base,
      entries: entries.slice(0, cap).map(out),
      ...(entries.length > cap ? { leftOut: entries.length - cap } : {}),
      ...(ctx.live && setup ? { fromFiles: fromFiles.slice(0, cap) } : {}),
      ...also,
    };
  }

  return {
    home: defaultHome ? context().home : realHome,
    sources,
    history,
    commands,
    programs,
    recall,
    startup,
    definitions,
    defines,
    path: pathOf,
    /** What the kit would return for a command: the text with credentials replaced. */
    redact: (command) => redact(command),
  };
}
