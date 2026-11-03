import { build } from "esbuild-wasm";
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(packageDir, "../..");
const manifest = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));

await build({
  absWorkingDir: root,
  entryPoints: ["packages/cli/src/bin.ts"],
  outfile: resolve(packageDir, "dist/bin.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  external: Object.keys(manifest.dependencies),
  alias: Object.fromEntries(["core", "engine", "runner", "cli"].map((name) =>
    [`@mutant-cafe/${name}`, resolve(root, `packages/${name}/src/index.ts`)])),
});
await chmod(resolve(packageDir, "dist/bin.js"), 0o755);
await copyFile(resolve(root, "LICENSE"), resolve(packageDir, "LICENSE"));
const readme = await readFile(resolve(root, "README.md"), "utf8");
await writeFile(resolve(packageDir, "README.md"), readme +
  "\n## Package build\n\nesbuild-wasm 0.28.2 bundles workspace code into Node 24 ESM with source maps and external runtime dependencies, without native install scripts.\n");
