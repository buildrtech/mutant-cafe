import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const Issues = Schema.Array(Schema.Struct({ file: Schema.String, reason: Schema.String }));

// Run against the package's installed Vitest, not the tool's version. Vitest
// resolves config and project includes; we do not guess at its glob semantics.
const probe = String.raw`
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = process.cwd();
const issues = [];
const pkg = JSON.parse(await readFile("package.json", "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; }));
const script = pkg.scripts?.test;
const vitestScript = !script || /(?:^|[\s/])vitest(?=\s|$|[;&|])/.test(script);
const delegated = script && /(?:\bturbo\s+(?:run\s+)?test\b|\bpnpm\s+(?:-r|--recursive|--filter\s+\S+)\s+(?:run\s+)?test\b)/.test(script);
if (!vitestScript) {
  issues.push({ file: "*", reason: 'package.json scripts.test = ' + JSON.stringify(script) + (delegated ? '; delegated test runner: Vitest selection is unverified' : '; mutant.cafe only runs Vitest') });
} else {
  let ctx;
  try {
    const { createVitest } = await import("vitest/node");
    ctx = await createVitest("test", { root, watch: false, cache: false, fsModuleCache: false });
    const selected = new Set((await ctx.globTestSpecifications()).map(spec => resolve(spec.moduleId)));
    const sources = new Map();
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", ".brain", ".pi", ".agent_sources", "mutants.out", "dist"].includes(entry.name)) continue;
        const file = resolve(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (/\.[cm]?[jt]sx?$/.test(file)) sources.set(file, await readFile(file, "utf8"));
      }
    }
    await walk(root);
    function dependencies(file, seen = new Set()) {
      if (seen.has(file)) return seen;
      seen.add(file);
      for (const match of (sources.get(file) ?? '').matchAll(/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g)) {
        let target;
        if (match[1].startsWith('.')) target = resolve(dirname(file), match[1]);
        else {
          try {
            const selfImport = pkg.name && (match[1] === pkg.name || match[1].startsWith(pkg.name + '/'));
            target = selfImport ? fileURLToPath(import.meta.resolve(match[1])) : createRequire(file).resolve(match[1]);
            if (selfImport && !/\.[cm]?tsx?$/.test(target)) {
              issues.push({ file: '*', reason: relative(root, file) + ' imports ' + match[1] + '; self entry resolves to built output ' + relative(root, target) + ', not mutated TypeScript source' });
            }
          } catch { continue; }
        }
        const candidate = [target, target.replace(/\.js$/, '.ts'), target + '.ts', target + '.tsx', resolve(target, 'index.ts')].find(p => sources.has(p));
        if (candidate) dependencies(candidate, seen);
      }
      return seen;
    }
    const reached = new Set([...selected].flatMap(file => [...dependencies(file)]));
    for (const [file, text] of sources) {
      const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
        || (/["'](?:node:test|vitest|@effect\/vitest)["']/.test(text) && /\b(?:it|test|describe)\s*(?:\.|\()/.test(text));
      if (reached.has(file) || !testFile) continue;
      for (const target of dependencies(file)) {
        if (target !== file) issues.push({ file: relative(root, target), reason: relative(root, file) + ' imports this target but is absent from Vitest resolved test files' });
      }
    }
  } catch (error) {
    issues.push({ file: '*', reason: 'Cannot verify Vitest resolved selection: ' + String(error) });
  } finally { await ctx?.close(); }
}
console.log('mutant-cafe-preflight:' + JSON.stringify([...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()]));
`;

export const preflight = Effect.fn("TestRunner.preflight")(function* (root: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner.string(ChildProcess.make("node", ["--input-type=module", "--eval", probe], { cwd: root, stdin: "ignore" }));
  const encoded = output.split("\n").find(line => line.startsWith("mutant-cafe-preflight:"))?.slice("mutant-cafe-preflight:".length);
  const issues = encoded === undefined
    ? [{ file: "*", reason: "Vitest selection probe returned no evidence" }]
    : yield* Schema.decodeEffect(Schema.fromJsonString(Issues))(encoded);
  return issues;
});
