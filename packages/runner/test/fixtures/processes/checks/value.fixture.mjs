import { it, expect } from "vitest";
import { appendFileSync, readFileSync, watch } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { value } from "../src/value.ts";

const proof = process.env.MUTANT_CAFE_PID_PROOF;
const inspect = (pid, field) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", field + "="], { encoding: "utf8", timeout: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
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
    // macOS adds __CF_* keys even to env: {}; every other key must match.
    for (const env of [{}, { ONLY: "kept" }]) {
      const result = await promisify(execFile)(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({ value: 2 + 3, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("__CF_"))) }))'], { env });
      expect(JSON.parse(result.stdout)).toEqual({ value: 5, env });
    }
    expect(mode).toBe(1);
    return;
  }
  record(process.pid, "worker");
  let parent = Number(inspect(process.pid, "ppid"));
  while (parent > 1) {
    let labelled = "";
    try { labelled = execFileSync("ps", ["eww", "-p", String(parent), "-o", "command="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    if (!labelled.includes("MUTANT_CAFE_PROCESS_TOKEN=" + process.env.MUTANT_CAFE_PROCESS_TOKEN)) break;
    record(parent, "ancestor");
    parent = Number(inspect(parent, "ppid"));
  }
  if (mode === 7) {
    const cursor = readFileSync(proof).length;
    const escapedCode = `const fs = require("node:fs"), cp = require("node:child_process"); if (Object.keys(process.env).filter(key => !key.startsWith("__CF_")).length) throw new Error("explicit env changed"); const pid = process.pid; const inspect = field => cp.execFileSync("ps", ["-p", String(pid), "-o", field + "="], { encoding: "utf8", timeout: 2000, env: { TZ: "UTC", LC_ALL: "C" } }).trim(); fs.appendFileSync(${JSON.stringify(proof)}, JSON.stringify({ pid, kind: "escaped", birth: inspect("lstart"), pgid: Number(inspect("pgid")) }) + "\\n"); while (true) {}`;
    // The env-less parent has no preload. Its env-less child must be found
    // through the live PPID chain, not a label or a grandchild ledger record.
    const code = escapedCode.replace('kind: "escaped"', 'kind: "middle"').replace("while (true) {}", `const child = cp.spawn(process.execPath, ["-e", ${JSON.stringify(escapedCode)}], { detached: true, stdio: "ignore", env: {} }); child.unref(); while (true) {}`);
    const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore", env: {} });
    child.unref();
    await waitForEscape(cursor);
    return;
  }
  if ([2, 3, 4, 5].includes(mode)) {
    const shared = `const fs = require("node:fs"), cp = require("node:child_process"); const proof = ${JSON.stringify(proof)};
      const inspect = field => cp.execFileSync("ps", ["-p", String(process.pid), "-o", field + "="], { encoding: "utf8", timeout: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const record = kind => fs.appendFileSync(proof, JSON.stringify({ pid: process.pid, kind, birth: inspect("lstart"), pgid: Number(inspect("pgid")) }) + "\\n");`;
    const escaped = shared + 'record("escaped"); while (true) {}';
    const middle = shared + `record("middle"); const child = cp.spawn(process.execPath, ["-e", ${JSON.stringify(escaped)}], { detached: true, stdio: "ignore" }); child.unref();`;
    const cursor = readFileSync(proof).length;
    const child = spawn(process.execPath, ["-e", middle], { detached: true, stdio: "ignore" });
    child.unref();
    if (mode === 5) { await waitForEscape(cursor); return; }
    if (mode === 3) { await waitForEscape(cursor); process.exit(43); }
    if (mode === 4) { await waitForEscape(cursor); await new Promise(() => {}); }
  }
  if (mode === 6) {
    Promise.reject(new Error("fixture-unhandled-rejection"));
    await new Promise(resolve => setTimeout(resolve, 25));
    return;
  }
  const loop = () => { while (true) {} };
  loop();
});
