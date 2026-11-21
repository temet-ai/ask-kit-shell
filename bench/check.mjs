// Runs every shot (`do`) in bench/questions.json through `ask-kit run`, with no model, and tests its patterns.
// Usage, from the kit's folder: node bench/check.mjs <path to an ask-kit command>   (e.g. ask-kit)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const ak = process.argv[2] || "ask-kit";
const bench = JSON.parse(fs.readFileSync("bench/questions.json", "utf8"));
let bad = 0;
for (const q of bench.questions.filter((x) => x.do)) {
  const args = ["run", "shell", q.do, ...Object.entries(q.params ?? {}).map(([k, v]) => `${k}=${v}`)];
  let out;
  try {
    out = execFileSync(ak, args, { encoding: "utf8", timeout: 60000 });
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const miss = q.expect.filter((p) => !new RegExp(p).test(out));
  console.log(`${miss.length ? "BAD" : "ok "} ${q.id}${miss.length ? `  missing: ${miss.join(" | ")}` : ""}`);
  bad += miss.length ? 1 : 0;
}
console.log(bad ? `${bad} failed` : "all shots pass");
process.exit(bad ? 1 : 0);
