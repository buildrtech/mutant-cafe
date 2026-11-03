#!/usr/bin/env node
// Refuses a push that would publish private context: Brain or Muster state,
// local home paths, tailnet names, secret-shaped strings, and anything in
// the private denylist named by PUBLIC_GUARD_DENYLIST.
// Usage: node scripts/public-guard.mjs [rev]   (default HEAD)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const rev = process.argv[2] ?? "HEAD";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = git("ls-tree", "-r", "--name-only", rev).split("\n").filter(Boolean);
const failures = [];

const forbiddenPaths = [/^\.brain\//, /(^|\/)\.brain\//, /muster/i, /^\.pi\//, /^\.alchemy\//, /(^|\/)\.env/, /^\.agent_sources\//];
for (const file of files) {
  for (const pattern of forbiddenPaths) {
    if (pattern.test(file)) failures.push(`path ${file} matches ${pattern}`);
  }
}

const forbiddenContent = [
  [/\/Users\/[a-z]/, "home path"],
  [/\/home\/[a-z]+\//, "home path"],
  [/tail[0-9a-f]{5}\.ts\.net/, "tailnet name"],
  [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, "tailnet address"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "GitHub token"],
  [/\bsk-[A-Za-z0-9]{20,}/, "API key"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS key"],
];

// Private names (hosts, internal tools) never live in this public file.
// Point PUBLIC_GUARD_DENYLIST at a local file with one regex per line.
const denylist = process.env.PUBLIC_GUARD_DENYLIST;
if (denylist) {
  for (const line of readFileSync(denylist, "utf8").split("\n")) {
    const source = line.trim();
    if (source && !source.startsWith("#")) forbiddenContent.push([new RegExp(source, "i"), "private denylist"]);
  }
}

const self = "scripts/public-guard.mjs";
for (const file of files) {
  if (file === self || file === "pnpm-lock.yaml") continue;
  const text = git("show", `${rev}:${file}`);
  if (text.includes("\u0000")) continue;
  text.split("\n").forEach((line, index) => {
    for (const [pattern, label] of forbiddenContent) {
      if (pattern.test(line)) failures.push(`${file}:${index + 1} ${label}`);
    }
  });
}

const history = git("log", "--format=%an <%ae>%n%s%n%b", rev);
for (const [pattern, label] of forbiddenContent) {
  if (pattern.test(history)) failures.push(`commit messages: ${label}`);
}

if (failures.length > 0) {
  process.stderr.write(`public-guard: REFUSED ${rev} (${failures.length} findings)\n${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`public-guard: CLEAN ${rev} (${files.length} files checked)\n`);
