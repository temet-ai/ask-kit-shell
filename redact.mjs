// Redaction of shell commands and of values from startup files. Shell history is full of
// credentials, and everything the kit returns goes to a cloud model, so every command passes
// through redact() before it leaves the module. The flag or the name stays and the value becomes
// <redacted>, so the command is still readable.
//
// The rules go by pattern: flags and names that look like credentials, the flags of programs that
// take a password, headers, URLs, and strings shaped like known keys. A secret that matches none
// of them (a password typed as a plain argument to an unknown program) is not caught.

export const R = "<redacted>";

// ---- names ------------------------------------------------------------------------------------

const CRED_PARTS = new Set([
  "password", "passwd", "passphrase", "pass", "pwd", "pw", "passcode", "token", "tokens", "secret", "secrets", "apikey", "apikeys",
  "credential", "credentials", "cred", "creds", "auth", "bearer", "cookie", "cookies", "signature", "otp", "pat", "authtoken",
  "accesskey", "secretkey", "privatekey", "accesstoken", "authorization", "dsn", "teleport",
]);
// A name part before "key" that makes it a credential: API_KEY, access-key, SIGNING_KEY.
const KEY_KINDS = new Set(["api", "access", "secret", "private", "auth", "license", "licence", "encryption", "master", "signing", "session", "app", "consumer", "client", "account", "storage", "deploy", "service", "admin", "shared", "sas", "webhook"]);
// A last part that says the value is not the credential itself: --password-file, TOKEN_URL, SSH_AUTH_SOCK.
const NOT_VALUE = new Set([
  "file", "files", "path", "dir", "stdin", "name", "names", "id", "type", "method", "mode", "url", "uri", "endpoint", "length", "len", "ttl",
  "expiry", "expires", "prompt", "cmd", "command", "helper", "sock", "socket", "store", "policy", "timeout", "version", "count", "enabled",
  "required", "fd", "format", "algorithm", "algo", "scope", "scopes", "plugin", "provider", "realm", "user", "username", "host", "port",
  "source", "header", "prefix", "suffix", "location", "manager", "backend", "check", "strength", "age", "days",
]);

export function nameParts(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a variable, flag, header or key name looks like it holds a credential. */
export function isCredName(name) {
  const parts = nameParts(name);
  if (!parts.length) return false;
  if (/^(no|without|skip|with|disable|enable|use|show|ask|prompt|generate|new|reset|forgot|change|check|verify|validate|require|requires)$/.test(parts[0]) && parts.length > 1) return false;
  if (NOT_VALUE.has(parts[parts.length - 1])) return false;
  for (let i = 0; i < parts.length; i++) {
    if (CRED_PARTS.has(parts[i])) return true;
    if ((parts[i] === "key" || parts[i] === "keys") && i > 0 && KEY_KINDS.has(parts[i - 1])) return true;
  }
  return false;
}

// A value that is safe to keep: empty, a reference to a variable or a command, a boolean, or already redacted.
function keepable(value) {
  const v = unquote(value).trim();
  if (!v) return true;
  if (v.includes(R)) return v.replace(/<redacted>/g, "").replace(/[\w-]{0,12}[:=@ ]?/g, "").length < 6;
  if (/^\$\{?[A-Za-z_][\w.:]*\}?$/.test(v) || /^\$\(|^`|^<\(/.test(v)) return true;
  if (/^(true|false|yes|no|on|off|none|null|nil|0|1|-|\*+|x+|changeme|xxx+|\.\.\.)$/i.test(v)) return true;
  return false;
}

export function unquote(raw) {
  const s = String(raw);
  const m = /^\$?(['"])([\s\S]*)\1$/.exec(s);
  if (m) return m[2];
  return s.replace(/\\(.)/g, "$1").replace(/['"]/g, "");
}

// The redacted form of a whole word, keeping its quotes.
function hide(raw) {
  const m = /^\$?(['"])[\s\S]*\1$/.exec(raw);
  return m ? `${m[1]}${R}${m[1]}` : R;
}

// ---- strings shaped like known keys -----------------------------------------------------------

const SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bxox[abposer]-[A-Za-z0-9-]{8,}/g, // Slack
  /\bxapp-[A-Za-z0-9-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic and others
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g, // Google
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bpypi-[A-Za-z0-9_-]{30,}/g,
  /\bhf_[A-Za-z0-9]{24,}/g,
  /\bdop_v1_[a-f0-9]{32,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bhv[sb]\.[A-Za-z0-9_-]{20,}/g, // Vault
  /\bAGE-SECRET-KEY-1[A-Z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{4,})?/g, // JWT
  /(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]{12,}/g,
  /(discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9/_-]{12,}/g,
];

function shapes(s) {
  for (const re of SHAPES) s = s.replace(re, (m, keep) => (typeof keep === "string" ? keep + R : R));
  return s;
}

// A long run of key-like characters with both letters and digits: hex, base64, an opaque token.
function isBlob(v) {
  if (v.length < 20 || !/^[A-Za-z0-9+/_.][A-Za-z0-9+/_.-]*={0,2}$/.test(v)) return false;
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (v.includes("/") && !/[+=]/.test(v)) return false; // a path
  if (/\.(json|ya?ml|txt|pem|key|crt|env|conf|cfg|sh|sql|gz|zip|tar|log|csv|dump|db|html?|js|py|toml)$/i.test(v)) return false; // a file
  if (/^\d{4}-\d\d-\d\d/.test(v)) return false; // a date
  return true;
}

// ---- words ------------------------------------------------------------------------------------

/** Split a command into words and the separators between them. Quotes, $( ) and backticks stay inside a word. */
export function tokenize(s) {
  const out = [];
  const n = s.length;
  const sepAt = (i) => /[\s;|&]/.test(s[i]);
  let i = 0;
  while (i < n) {
    let j = i;
    if (sepAt(i)) {
      while (j < n && sepAt(j)) j++;
      out.push({ sep: true, raw: s.slice(i, j) });
      i = j;
      continue;
    }
    while (j < n && !sepAt(j)) {
      const d = s[j];
      if (d === "\\") j += 2;
      else if (d === "'") {
        const k = s.indexOf("'", j + 1);
        j = k < 0 ? n : k + 1;
      } else if (d === '"') {
        j++;
        while (j < n && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
        j++;
      } else if (d === "`") {
        const k = s.indexOf("`", j + 1);
        j = k < 0 ? n : k + 1;
      } else if (d === "$" && s[j + 1] === "(") {
        let depth = 0;
        for (; j < n; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")" && --depth === 0) {
            j++;
            break;
          }
        }
      } else j++;
    }
    j = Math.min(j, n);
    out.push({ raw: s.slice(i, j) });
    i = j;
  }
  return out;
}

// Words that run another command: the program is what follows them.
const PREFIX_VALUE_FLAGS = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t"],
  doas: ["-u", "-C"],
  nice: ["-n"],
  ionice: ["-c", "-n", "-p"],
  timeout: ["-k", "-s"],
  watch: ["-n", "-d"],
  env: ["-u", "-C", "-S"],
  time: [],
  nohup: [],
  command: [],
  builtin: [],
  exec: ["-a"],
  noglob: [],
  nocorrect: [],
  stdbuf: [],
  caffeinate: ["-t", "-w"],
  setsid: [],
  chronic: [],
  unbuffer: [],
};

export function baseName(word) {
  return String(word).split(/[\\/]/).pop().replace(/\.exe$/i, "");
}

/** The program a list of words runs, looking through sudo, env X=1, time and the like. {name, index, via:[prefixes]} */
export function programOf(texts) {
  const via = [];
  let i = 0;
  while (i < texts.length) {
    const w = texts[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    const b = baseName(w);
    const flags = PREFIX_VALUE_FLAGS[b];
    if (!flags) return { name: b, index: i, via };
    via.push(b);
    i++;
    while (i < texts.length && (texts[i].startsWith("-") || (b === "env" && /^[A-Za-z_]\w*=/.test(texts[i])))) {
      if (flags.includes(texts[i])) i++;
      i++;
    }
    if (b === "timeout" && i < texts.length && /^\d+(\.\d+)?[smhd]?$/.test(texts[i])) i++;
  }
  return { name: via.length ? via[via.length - 1] : "", index: Math.max(0, texts.length - 1), via: via.slice(0, -1) };
}

// Short flags that take a password, by program. `attached` is -pVALUE, `separate` is -p VALUE.
const MYSQL = { attached: ["-p"] };
const MONGO = { attached: ["-p"], separate: ["-p"] };
const LOGIN = { attached: ["-p"], separate: ["-p"], needs: "login" };
const LDAP = { separate: ["-w"], attached: ["-w"] };
const PROGRAM_FLAGS = {
  mysql: MYSQL, mysqldump: MYSQL, mysqladmin: MYSQL, mariadb: MYSQL, "mariadb-dump": MYSQL, "mariadb-admin": MYSQL, mysqlsh: MYSQL, mycli: MYSQL, mysqlimport: MYSQL, mysqlcheck: MYSQL, mysqlpump: MYSQL, mydumper: MYSQL, myloader: MYSQL,
  sshpass: { attached: ["-p"], separate: ["-p"] },
  mongo: MONGO, mongosh: MONGO, mongodump: MONGO, mongorestore: MONGO, mongoexport: MONGO, mongoimport: MONGO, mongostat: MONGO,
  "redis-cli": { separate: ["-a"] },
  docker: LOGIN, podman: LOGIN, nerdctl: LOGIN, helm: LOGIN, buildah: LOGIN, skopeo: LOGIN, oras: LOGIN, crane: LOGIN, az: LOGIN, oc: LOGIN, cf: LOGIN,
  "npm-cli-login": { separate: ["-p"] },
  zip: { separate: ["-P"], attached: ["-P"] }, unzip: { separate: ["-P"], attached: ["-P"] },
  "7z": { attached: ["-p"] }, "7za": { attached: ["-p"] }, "7zr": { attached: ["-p"] }, rar: { attached: ["-p", "-hp"] }, unrar: { attached: ["-p"] },
  ldapsearch: LDAP, ldapmodify: LDAP, ldapadd: LDAP, ldapdelete: LDAP, ldapwhoami: LDAP, ldappasswd: { separate: ["-w", "-s", "-a"] },
  openssl: { separate: ["-k", "-pass", "-passin", "-passout"] },
  "ssh-keygen": { separate: ["-N", "-P"] },
  useradd: { separate: ["-p"] }, usermod: { separate: ["-p"] },
  mosquitto_pub: { separate: ["-P"] }, mosquitto_sub: { separate: ["-P"] },
  rabbitmqadmin: { separate: ["-p"] },
  smbclient: { separate: ["-U"], userSep: "%" }, rpcclient: { separate: ["-U"], userSep: "%" }, smbmap: { separate: ["-p"] },
  curl: { separate: ["-u", "--user", "-U", "--proxy-user"], userSep: ":" },
  http: { separate: ["-a", "--auth"], userSep: ":" }, https: { separate: ["-a", "--auth"], userSep: ":" }, xh: { separate: ["-a", "--auth"], userSep: ":" },
  lftp: { separate: ["-u"], userSep: "," },
  wget: {}, psql: {},
  htpasswd: {}, wpa_passphrase: {}, rabbitmqctl: {}, vault: {},
};

// What follows a pipe or reads a here-string and takes a secret on standard input.
const READS_SECRET = /--password-stdin|--with-token|--token-stdin|--passphrase-fd|--pass(?:word)?-stdin|\bsudo\b[^|;&]*\s-\w*S|\bchpasswd\b|\bpasswd\b[^|;&]*--stdin|\b(?:docker|podman|nerdctl|helm)\s+(?:\S+\s+)*login\b|\bgh\s+(?:auth|secret)\b|\bkubectl\s+create\s+secret\b|\bvault\s+(?:login|write|kv)\b|\bpass\s+insert\b|\bsecret-tool\b|\bsecurity\s+add-|\bcryptsetup\b|\bkinit\b|\bsu\b|\bssh-add\b|\bgpg\b[^|;&]*--passphrase|\bopenssl\b[^|;&]*-pass(?:in)?\s+stdin|\bwrangler\s+secret\b|\bfly(?:ctl)?\s+secrets\b|\bnpm\s+(?:login|adduser)\b|\bxclip\b|\bpbcopy\b/;

// name=value inside a word, where the name looks like a credential: export TOKEN=x, --password=x,
// ?api_key=x in a URL, user=sam&password=x in a body, password=x in mount options.
const ASSIGN = /([A-Za-z_][A-Za-z0-9_.-]*)(=)(\$\([^)]*\)|"(?:[^"\\]|\\.)*"|'[^']*'|(?:[^\s&;'",]|,(?![\w.-]+=))+)/g;

function inline(raw, all = false) {
  return raw.replace(ASSIGN, (m, name, eq, value) => {
    if (!(all || isCredName(name)) || keepable(value)) return m;
    return name + eq + hide(value);
  });
}

function userPass(raw, sep) {
  const text = unquote(raw);
  const at = text.indexOf(sep);
  if (at < 0) return raw; // only a user name: the program prompts
  if (keepable(text.slice(at + 1))) return raw;
  const q = /^(['"])/.exec(raw)?.[1] ?? "";
  return `${q}${text.slice(0, at + 1)}${R}${q}`;
}

function redactSegment(words, opts) {
  const texts = words.map((w) => unquote(w.raw));
  const prog = programOf(texts);
  const table = PROGRAM_FLAGS[prog.name];
  const has = (w) => texts.includes(w);
  const hideAt = (i) => {
    if (i >= 0 && i < words.length && !keepable(words[i].raw)) words[i].raw = hide(words[i].raw);
  };
  const positional = (from) => {
    const out = [];
    for (let i = from; i < words.length; i++) if (!texts[i].startsWith("-")) out.push(i);
    return out;
  };

  // Standard input: echo SECRET | docker login --password-stdin, and cmd <<< SECRET.
  if (opts.feedsSecret && /^(echo|printf|print|cat|Write-Output)$/i.test(prog.name)) for (const i of positional(prog.index + 1)) hideAt(i);
  const here = texts.indexOf("<<<");
  if (here >= 0 && READS_SECRET.test(texts.join(" "))) hideAt(here + 1);

  let sawCred = false;
  for (let i = 0; i < words.length; i++) {
    const t = texts[i];
    const next = i + 1 < words.length ? texts[i + 1] : null;

    // A header: -H "Authorization: Bearer x", Cookie: a=b, X-Api-Key:abc.
    const h = /^([A-Za-z][\w-]*):\s*([\s\S]+)$/.exec(t);
    const afterH = i > 0 && /^(-H|--header)$/.test(texts[i - 1]);
    const known = h && /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(h[1]);
    if (h && !/^\/\//.test(h[2]) && (known || (isCredName(h[1]) && (afterH || /^x-/i.test(h[1]) || !/\s/.test(h[2])))) && !keepable(h[2])) {
      const scheme = /^(Bearer|Basic|Token|Digest|ApiKey|Negotiate|AWS4-HMAC-SHA256)\s+/i.exec(h[2])?.[0] ?? "";
      const q = /^\$?(['"])/.exec(words[i].raw)?.[1] ?? "";
      words[i].raw = `${q}${h[1]}: ${scheme}${R}${q}`;
      continue;
    }

    if (t.startsWith("-") && !t.includes("=")) {
      // Short flags of programs that take a password.
      if (table && (!table.needs || has(table.needs))) {
        if (table.separate?.includes(t) && next != null && !(next.startsWith("-") && next.length === 2)) {
          if (table.userSep) words[i + 1].raw = userPass(words[i + 1].raw, table.userSep);
          else if (/^(env|file|fd|stdin):/.test(next)) {
            // a reference
          } else if (next.startsWith("pass:")) words[i + 1].raw = `pass:${R}`;
          else hideAt(i + 1);
          continue;
        }
        const att = table.attached?.find((f) => t.startsWith(f) && t.length > f.length && i > prog.index);
        if (att && !keepable(t.slice(att.length))) {
          words[i].raw = att + R;
          continue;
        }
      }
      // A flag whose name looks like a credential: --password x, -token x, -Password x.
      const name = t.replace(/^-+/, "");
      if (name.length > 2 && /^[A-Za-z][A-Za-z_-]*$/.test(name) && isCredName(name) && next != null && !/^[-<>|]/.test(next)) {
        const kind = /^(pass|env|file|fd|stdin):/.exec(next)?.[1];
        if (kind && kind !== "pass") {
          // openssl -passin file:key.pass, env:NAME: a reference, not the secret
        } else if (kind === "pass") words[i + 1].raw = `pass:${R}`;
        else if (table?.userSep && table.separate?.includes(t)) words[i + 1].raw = userPass(words[i + 1].raw, table.userSep);
        else hideAt(i + 1);
        continue;
      }
      // gh secret set NAME --body VALUE
      if ((t === "--body" || t === "-b") && (has("secret") || has("secrets")) && next != null) hideAt(i + 1);
    }

    // set NAME VALUE and config NAME VALUE: aws configure set, npm config set, git config, fish set -gx.
    if (/^(set|config|configure|config:set|setx|setenv|set-credentials)$/i.test(t)) {
      const p = positional(i + 1);
      const at = p[0] != null && /^(set|config|configure)$/.test(texts[p[0]]) ? 1 : 0;
      if (p[at] != null && p[at + 1] != null && isCredName(texts[p[at]])) hideAt(p[at + 1]);
    }

    // A long opaque string after a credential word in the same command.
    if (sawCred && i > prog.index && isBlob(t)) hideAt(i);
    if (!sawCred) {
      const parts = nameParts(t.length > 60 ? t.slice(0, 60) : t);
      if (parts.some((p) => CRED_PARTS.has(p))) sawCred = true;
    }
  }

  // Positional secrets of particular programs.
  const p = positional(prog.index + 1);
  const sub = p.map((i) => texts[i]);
  if (prog.name === "vault") {
    if (sub[0] === "login" && p[1] != null) hideAt(p[1]);
    if (/^(write|kv)$/.test(sub[0] ?? "")) for (const i of p) if (/^[\w.-]+=/.test(texts[i])) words[i].raw = inline(words[i].raw, true);
  }
  if (prog.name === "htpasswd" && texts.some((t) => /^-[a-zA-Z0-9]*b/.test(t)) && p.length >= 3) hideAt(p[p.length - 1]);
  if (prog.name === "wpa_passphrase" && p[1] != null) hideAt(p[1]);
  if (prog.name === "rabbitmqctl" && /^(add_user|change_password|authenticate_user)$/.test(sub[0] ?? "") && p[2] != null) hideAt(p[2]);
  if (/^mysqladmin|mariadb-admin$/.test(prog.name)) {
    const at = sub.indexOf("password");
    if (at >= 0 && p[at + 1] != null) hideAt(p[at + 1]);
  }
  if (/^ConvertTo-SecureString$/i.test(prog.name)) {
    if (p[0] != null) hideAt(p[0]);
  }
  // A command about secrets: every KEY=VALUE is one. kubectl create secret, fly secrets set, gh secret set, docker secret.
  if (sub.slice(0, 4).some((w) => /^secrets?$/.test(w))) {
    for (let i = prog.index + 1; i < words.length; i++) {
      if (/^--from-literal=/.test(texts[i])) words[i].raw = words[i].raw.replace(/^(--from-literal=[^=\s]+=)([\s\S]+)$/, (m, a, v) => (keepable(v) ? m : a + R));
      else if (/^[A-Za-z_][\w.-]*=/.test(texts[i])) words[i].raw = inline(words[i].raw, true);
    }
  }
}

// Whether a command could hold anything the rules look for. Most commands (ls, cd, git status) do not.
const MAYBE = /[=:@]|-p|-a |-w |-k |pass|token|secret|key|auth|teleport|login|cred|AKIA|ASIA|eyJ|xox|sk-|gh[pousr]_|glpat|BEGIN|user|secure|sudo|vault|<<</i;

/** A command with its credentials replaced by <redacted>. Returns {text, redacted}: redacted is how many values were replaced. */
export function redact(input) {
  let s = String(input ?? "");
  if (!MAYBE.test(s)) return { text: s, redacted: 0 };
  const before = s;

  s = shapes(s);
  // URLs with a password, or a token as the user: https://user:pw@host, redis://:pw@host, https://TOKEN@host.
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@'"]*):([^\s/'"]+)@/gi, (m, scheme, user, pw) => (keepable(pw) ? m : `${scheme}${user}:${R}@`));
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_.~%-]{20,})@/gi, (m, scheme) => `${scheme}${R}@`);
  // user:password@host with no scheme (not git@host:path, not image@sha256).
  s = s.replace(/(^|[\s'"=])([A-Za-z0-9_.-]+):([^\s@/:'"]{3,})@([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+)/g, (m, pre, user, pw, host) => (keepable(pw) ? m : `${pre}${user}:${R}@${host}`));
  // Authorization headers wherever they stand.
  s = s.replace(/((?:proxy-)?authorization\s*[:=]\s*\\?["']?)(?:(bearer|basic|token|digest|apikey)\s+)?([^\s"'\\]+)/gi, (m, pre, scheme, v) => (keepable(v) ? m : `${pre}${scheme ? scheme + " " : ""}${R}`));
  // JSON and YAML keys: {"password": "x"}, "api_key":"x", password: 'x'.
  s = s.replace(/(\\?["']?)([A-Za-z_][\w.-]*)\1(\s*:\s*)(\\?["'])((?:(?!\4).)+)\4/g, (m, q, name, colon, vq, v) => (isCredName(name) && !keepable(v) ? `${q}${name}${q}${colon}${vq}${R}${vq}` : m));
  // NAME = "value" with spaces around the sign: nushell $env.TOKEN = "x".
  s = s.replace(/([A-Za-z_][\w.-]*)(\s+=\s+)(["'])((?:(?!\3).)+)\3/g, (m, name, eq, q, v) => (isCredName(name) && !keepable(v) ? `${name}${eq}${q}${R}${q}` : m));
  // SQL: IDENTIFIED BY 'x', PASSWORD 'x'.
  s = s.replace(/\b(identified\s+by|password)(\s+)(\\?['"])((?:(?!\3).)+)\3/gi, (m, kw, sp, q, v) => (keepable(v) ? m : `${kw}${sp}${q}${R}${q}`));

  const tokens = tokenize(s);
  // Segments between ; | & and newlines; a segment that feeds a secret reader through a pipe is marked.
  const segments = [];
  let cur = { words: [], pipedInto: null };
  for (const t of tokens) {
    if (!t.sep) cur.words.push(t);
    else if (/[;|&\n]/.test(t.raw)) {
      const next = { words: [], pipedInto: null };
      if (/^\s*\|&?\s*$/.test(t.raw)) cur.pipedInto = next;
      segments.push(cur);
      cur = next;
    }
  }
  segments.push(cur);
  for (const seg of segments) {
    if (!seg.words.length) continue;
    const feedsSecret = !!seg.pipedInto && READS_SECRET.test(seg.pipedInto.words.map((w) => w.raw).join(" "));
    redactSegment(seg.words, { feedsSecret });
  }
  for (const t of tokens) if (!t.sep && t.raw.includes("=")) t.raw = inline(t.raw);
  s = tokens.map((t) => t.raw).join("");

  if (s === before) return { text: s, redacted: 0 };
  return { text: s, redacted: s.split(R).length - 1 };
}

/** The value of a variable from a startup file: hidden when the name looks like a credential, otherwise passed through redact(). */
export function redactValue(name, value) {
  const v = String(value ?? "");
  if (isCredName(name) && !keepable(v)) return R;
  return redact(v).text;
}
