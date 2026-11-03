import { it, expect } from "vitest";
import { appendFileSync, readFileSync, watch } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { value } from "../src/value.ts";

const proof = process.env.MUTANT_CAFE_PID_PROOF;
const inspect = (pid, field) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", field + "="], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const record = (pid, kind) => appendFileSync(proof, JSON.stringify({ pid, kind, birth: inspect(pid, "lstart"), pgid: Number(inspect(pid, "pgid")) }) + "\n");
const waitForEscape = cursor => new Promise(resolve => {
  const check = () => { if (readFileSync(proof, "utf8").slice(cursor).includes('"kind":"escaped"')) { watcher.close(); resolve(); } };
  const watcher = watch(proof, check);
  check();
});

it("checks the value without leaving a worker behind", async () => {
  const mode = value();
  if (mode === 1) {
    const pending = promisify(execFile)(process.execPath, ["-e", 'process.stdout.write("child-control")']);
    expect(pending.child.pid).toBeGreaterThan(0);
    expect((await pending).stdout).toBe("child-control");
    expect(mode).toBe(1);
    return;
  }
  record(process.pid, "worker");
  let parent = Number(inspect(process.pid, "ppid"));
  while (parent > 1) {
    let labelled = "";
    try { labelled = execFileSync("ps", ["eww", "-p", String(parent), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    if (!labelled.includes("MUTANT_CAFE_PROCESS_TOKEN=" + process.env.MUTANT_CAFE_PROCESS_TOKEN)) break;
    record(parent, "ancestor");
    parent = Number(inspect(parent, "ppid"));
  }
  if ([2, 3, 4].includes(mode)) {
    const shared = `const fs = require("node:fs"), cp = require("node:child_process"); const proof = ${JSON.stringify(proof)};
      const inspect = field => cp.execFileSync("ps", ["-p", String(process.pid), "-o", field + "="], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const record = kind => fs.appendFileSync(proof, JSON.stringify({ pid: process.pid, kind, birth: inspect("lstart"), pgid: Number(inspect("pgid")) }) + "\\n");`;
    const escaped = shared + 'record("escaped"); while (true) {}';
    const middle = shared + `record("middle"); const child = cp.spawn(process.execPath, ["-e", ${JSON.stringify(escaped)}], { detached: true, stdio: "ignore" }); child.unref();`;
    const cursor = readFileSync(proof).length;
    const child = spawn(process.execPath, ["-e", middle], { detached: true, stdio: "ignore" });
    child.unref();
    if (mode === 3) { await waitForEscape(cursor); process.exit(43); }
    if (mode === 4) { await waitForEscape(cursor); await new Promise(() => {}); }
  }
  const loop = () => { while (true) {} };
  loop();
});
