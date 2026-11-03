# Releasing mutant-cafe

A version tag publishes. GitHub Actions builds the package, runs the release gate on the exact tarball, and publishes that tarball to npm with provenance over OIDC. There is no npm token and no manual approval step.

## How a release flows

1. Update `packages/mutant-cafe/package.json` and the CLI version in `packages/cli/src/Command.ts` to the next version, and run `pnpm install` to update the lockfile. Commit them alongside the release changes.
2. Run the release gate locally on the release commit, with Node 24 and pnpm 11.3.0:

   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter mutant-cafe build
   node scripts/pack-smoke.mjs
   ```

   The gate writes `dist/mutant-cafe-<version>.tgz`, prints its SHA256, installs that exact tarball in a temporary Effect/Vitest project, and requires exit 2 with the Frozen swallow in withdraw reported as missed. It never publishes.
3. Once that commit is on `main`, push a matching tag, for example `v0.1.3`.
4. **Actions → Release** checks that the tag matches the package version, installs the frozen lockfile, builds, runs the same tarball gate, and publishes that tarball with `npm publish --provenance --access public`. A failed gate publishes nothing. If the version is already on npm, the workflow skips publishing.
5. Check the version, the `latest` dist-tag and provenance on npmjs.com before announcing it.

## Trusted publisher setup

On npmjs.com, open the `mutant-cafe` package, choose **Settings → Trusted Publisher → GitHub Actions**, and set **Organization or user** `joelhooks`, **Repository** `mutant-cafe`, **Workflow filename** `release.yml` (filename only), **Environment name** blank (the workflow declares none), with permission to publish.

The workflow uses npm 11.16.0 and Node 24 on a GitHub-hosted runner, requests `id-token: write` for OIDC and uses no npm token. Provenance requires the source repository to be public.

If the trusted publisher is ever narrowed to **npm stage publish** only, change the publish step to `npm stage publish` (same tarball path and flags). A maintainer then approves each staged version with 2FA on npmjs.com (**Staged Packages**) or with `npm stage approve <stage-id>`. Pass the tarball as `./dist/…`: without `./`, npm reads `dist/x.tgz` as a GitHub shorthand.

Sources: [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [staged publishing](https://docs.npmjs.com/staged-publishing/).

## When it fails

If OIDC fails, check that the owner, repository and workflow filename match the npm settings exactly. Do not add an `NPM_TOKEN` workaround. Published npm versions cannot be overwritten; fix a bad release with a new version.
