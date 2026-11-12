# Releasing buildrtech/mutant-cafe

This is Buildr's fork of [joelhooks/mutant-cafe](https://github.com/joelhooks/mutant-cafe). It carries a port of the type oracle (`packages/engine/src/TypeScriptOracle.ts`) to TypeScript 7's `typescript/unstable/sync` API, which upstream does not have. Versions are upstream's with a `-buildr.<n>` suffix, such as `0.1.6-buildr.1`.

The fork can't publish `mutant-cafe` to npm. A version tag instead builds the package, runs the release gate on the exact tarball, and attaches that tarball to a GitHub release. Bedrock installs it by the release asset's URL, and its `bun.lock` pins the tarball's integrity.

## How a release flows

1. Update `packages/mutant-cafe/package.json` and the CLI version in `packages/cli/src/Command.ts` to the next version, and run `pnpm install` to update the lockfile. Commit them alongside the release changes.
2. Run the release gate locally on the release commit, with Node 24 and pnpm 11.3.0:

   ```sh
   pnpm install --frozen-lockfile
   pnpm test
   pnpm --filter mutant-cafe build
   node scripts/pack-smoke.mjs
   ```

   The gate writes `dist/mutant-cafe-<version>.tgz`, prints its SHA256, installs that exact tarball in a temporary Effect/Vitest project, and requires exit 2 with the Frozen swallow in withdraw reported as missed.
3. Once that commit is on `main`, push a matching tag, for example `v0.1.6-buildr.1`.
4. **Actions → Release** checks that the tag matches the package version, installs the frozen lockfile, builds, runs the same tarball gate, and creates a GitHub release with the tarball attached. A failed gate releases nothing. A release can't be recreated under the same tag; fix a bad one with a new version.
5. Point Bedrock's root `package.json` at `https://github.com/buildrtech/mutant-cafe/releases/download/v<version>/mutant-cafe-<version>.tgz` and run `bun install`.

## Taking upstream changes

Merge upstream's `main` into the fork's, keeping `effect` and `@effect/platform-node` as caret ranges in `packages/mutant-cafe/package.json` so consumers such as Bedrock share their own Effect 4.x without overrides. Then rerun the engine suite (`pnpm --filter @mutant-cafe/engine test`), which checks the TypeScript 7 oracle. `packages/engine/test/engine.test.ts` builds its fixtures with TypeScript 6 through the `typescript6` alias, because TypeScript 7 has no JavaScript compiler API.
