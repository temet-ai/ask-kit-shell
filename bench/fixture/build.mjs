// Builds the fake home folder the bench reads: bench/fixture/home. Everything in it is invented
// (the Ankh-Morpork City Watch's developer), including the passwords and tokens in the history,
// which are there to prove that redaction hides them. Run: node bench/fixture/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "home");
fs.rmSync(root, { recursive: true, force: true });
const put = (rel, text, mode) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, mode ? { mode } : undefined);
};
const at = (day, hh, mm = 0) => Math.floor(Date.UTC(2026, 9, day, hh, mm) / 1000); // October 2026, UTC

// ---- startup files ----------------------------------------------------------------------------
put(".zshenv", `# read by every zsh
export PATH="$HOME/.local/bin:$PATH"
export EDITOR=vim
export PAGER=less
`);
put(".zshrc", `# interactive zsh
export PATH="$HOME/bin:$PATH"
export EDITOR=hx
export WATCH_ENV=staging
export WATCH_TOKEN=fake-token-0000
alias gco='git checkout'
alias gs='git status -sb'
alias g=git
alias ll='ls -la'
alias python=python3
mkcd() { mkdir -p "$1" && cd "$1"; }
[ -f ~/.config/watch/extra.zsh ] && source ~/.config/watch/extra.zsh
eval "$(mise activate zsh)"
`);
put(".config/watch/extra.zsh", `# the City Watch's own helpers
alias gco='git checkout -b'
export WATCH_ENV=production
`);
put(".bashrc", `export EDITOR=nano
alias ll='ls -l'
`);
put(".config/fish/config.fish", `set -gx EDITOR micro
abbr -a gs git status
`);

// ---- programs on PATH -------------------------------------------------------------------------
const script = (name) => `#!/bin/sh\necho ${name}\n`;
put("bin/node", script("node from ~/bin (an old shim)"), 0o755);
put("bin/python", script("python 2 wrapper"), 0o755);
put(".local/bin/python", script("python 3"), 0o755);
put(".local/share/nvm/v18/bin/node", script("node 18"), 0o755);
fs.mkdirSync(path.join(root, ".local/bin"), { recursive: true });
fs.symlinkSync("../share/nvm/v18/bin/node", path.join(root, ".local/bin/node"));

// ---- zsh history (extended format, times in UTC) ----------------------------------------------
const zsh = [
  [at(12, 8, 58), "cd ~/work/watch-api"],
  [at(12, 9, 1), "git pull --rebase"],
  [at(12, 9, 4), "docker compose up -d db"],
  [at(12, 9, 6), "pg_restore --clean --no-owner -d watch_dev ~/dumps/watch-2026-10-10.dump"],
  [at(12, 9, 20), "git status"],
  [at(12, 9, 31), "curl -s -H \"Authorization: Bearer fake-hunter2-token\" https://api.example.com/v1/patrols"],
  [at(12, 9, 40), "mysql -u vimes -pSamuel123 watch"],
  [at(12, 9, 52), "psql postgres://watch:ankh123@localhost:5432/watch_dev -c 'select count(*) from patrols'"],
  [at(12, 10, 5), "export WATCH_TOKEN=abc123fake"],
  [at(12, 10, 30), "npm run dev -- --port 4000"],
  [at(12, 11, 2), "git status"],
  [at(12, 11, 3), "git commit -m 'fix the night patrol rota'"],
  [at(13, 8, 40), "ffmpeg -i briefing.mov -vf scale=1280:-2 -c:v libx264 -crf 23 briefing.mp4"],
  [at(13, 9, 10), "tar -czf watch-api-backup.tgz ~/work/watch-api"],
  [at(13, 9, 30), "gti status"],
  [at(13, 9, 31), "git status"],
  [at(13, 10, 15), "cargo build --release"],
  [at(13, 10, 25), "cargo test -p patrol"],
  [at(13, 14, 0), "ssh -i ~/.ssh/id_ed25519 vimes@pseudopolis.example.com"],
  [at(13, 14, 20), "rsync -avz --delete ./dist/ deploy@watch.example.com:/var/www/watch/"],
  [at(14, 8, 45), "kubectl rollout restart deployment/patrol -n watch"],
  [at(14, 9, 5), "sudo systemctl restart nginx"],
  [at(14, 9, 50), "git status"],
  [at(14, 10, 30), "docker run --rm -e DB_PASSWORD=ankhmorpork -p 5432:5432 postgres:16"],
  [at(14, 11, 0), "mkcd ~/work/ephebe && git init"],
  [at(15, 9, 0), "git status"],
  [at(15, 9, 12), "npm test"],
  [at(15, 9, 40), "npm test"],
  [at(15, 10, 0), "aws s3 sync ./dist s3://watch-assets --profile watch --delete"],
];
put(".zsh_history", zsh.map(([t, c]) => `: ${t}:0;${c}`).join("\n") + "\n: " + at(15, 11, 0) + ":0;docker build -t watch-api \\\n  --build-arg VERSION=1.4 .\n");

// ---- bash and fish history --------------------------------------------------------------------
put(".bash_history", "ls /etc/hosts\nsudo apt-get update\nsudo apt-get install -y ripgrep\nssh-keygen -t ed25519 -C vimes@watch.example.com\n");
put(".local/share/fish/fish_history", `- cmd: echo hello from fish\n  when: ${at(11, 20)}\n- cmd: fish_add_path ~/.cargo/bin\n  when: ${at(11, 21)}\n`);

// ---- atuin database: the same shell, with folder, exit code and duration ----------------------
fs.mkdirSync(path.join(root, ".local/share/atuin"), { recursive: true });
const db = new DatabaseSync(path.join(root, ".local/share/atuin/history.db"));
db.exec("create table history (id text primary key, timestamp integer not null, duration integer not null, exit integer not null, command text not null, cwd text not null, session text not null, hostname text not null, deleted_at integer)");
const ins = db.prepare("insert into history values (?, ?, ?, ?, ?, ?, 'sess-1', 'watch-house:vimes', null)");
const atuin = [
  [at(12, 9, 6), 4.2, 0, "pg_restore --clean --no-owner -d watch_dev ~/dumps/watch-2026-10-10.dump", "~/work/watch-api"],
  [at(13, 9, 30), 0.1, 127, "gti status", "~/work/watch-api"],
  [at(13, 9, 31), 0.1, 0, "git status", "~/work/watch-api"],
  [at(14, 9, 50), 0.1, 0, "git status", "~/work/ephebe"],
  [at(15, 9, 12), 31, 1, "npm test", "~/work/watch-api"],
  [at(15, 9, 40), 28, 0, "npm test", "~/work/watch-api"],
  [at(15, 10, 0), 12, 0, "aws s3 sync ./dist s3://watch-assets --profile watch --delete", "~/work/watch-api"],
  [at(16, 9, 0), 2, 0, "pg_dump -Fc -d watch_dev -f ~/dumps/watch-2026-10-16.dump", "~/work/watch-api"],
  [at(16, 9, 30), 0.2, 2, "ls /nonexistent", "~/work/ephebe"],
];
atuin.forEach(([t, dur, exit, cmd, cwd], i) => ins.run(`a${i}`, t * 1e9, Math.round(dur * 1e9), exit, cmd, cwd.replace("~", "/home/vimes")));
db.close();
console.log("built", root);
