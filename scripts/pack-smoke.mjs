#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages/mutant-cafe");
const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const dist = join(root, "dist");
const tarball = join(dist, `mutant-cafe-${manifest.version}.tgz`);
const run = (command, args, cwd, expected = 0) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command} terminated by signal`);
  assert.equal(result.status, expected, `${command} ${args.join(" ")} exit status`);
};

await mkdir(dist, { recursive: true });
run("npm", ["pack", "--pack-destination", dist], packageDir);
const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
console.log(`tarball: dist/mutant-cafe-${manifest.version}.tgz`);
console.log(`sha256: ${sha256}`);

if (!process.argv.includes("--pack-only")) {
  const project = await mkdtemp(join(tmpdir(), "mutant-cafe-pack-smoke-"));
  try {
    const fixture = join(root, "fixtures/tagged-errors");
    // Copy only inputs, never previous reports or workspace dependencies.
    for (const directory of ["src", "test"]) {
      await cp(join(fixture, directory), join(project, directory), { recursive: true });
    }
    const base = JSON.parse(await readFile(join(root, "tsconfig.base.json"), "utf8"));
    const { plugins, ...compilerOptions } = base.compilerOptions;
    const fixtureConfig = JSON.parse(await readFile(join(fixture, "tsconfig.json"), "utf8"));
    const { extends: workspaceBase, ...standaloneConfig } = fixtureConfig;
    await writeFile(join(project, "tsconfig.json"), JSON.stringify({
      ...standaloneConfig,
      compilerOptions: { ...compilerOptions, ...fixtureConfig.compilerOptions },
    }, null, 2));
    const fixturePackage = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "mutant-cafe-pack-smoke",
      private: true,
      type: "module",
      devDependencies: {
        ...fixturePackage.dependencies,
        ...fixturePackage.devDependencies,
        "mutant-cafe": `file:${tarball}`,
      },
    }, null, 2));
    run("npm", ["install", "--no-audit", "--no-fund"], project);
    run("npx", ["mutant-cafe", "--jobs", "2"], project, 2);
    const missed = await readFile(join(project, "mutants.out/missed.txt"), "utf8");
    const frozen = missed.split("\n").find((line) => /SwallowTag\(Frozen\) in withdraw\b/.test(line));
    assert.ok(frozen, "missed.txt must name the Frozen swallow in withdraw");
    console.log(`pack-smoke: ${frozen.replaceAll(project, "<project>")}`);
    console.log("pack-smoke: PASS (installed tarball, exit 2, Frozen swallow missed)");
  } catch (error) {
    console.error(`pack-smoke: FAIL; project retained at ${project}`);
    throw error;
  }
  // A failed project is retained for diagnosis; remove only this run's temp tree.
  await rm(project, { recursive: true });
}
