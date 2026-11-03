# Releasing mutant-cafe

Releases are staged by GitHub Actions and approved by a maintainer. CI never makes a version public on its own.

## How a release flows

1. Update `packages/mutant-cafe/package.json` to the next version and run `pnpm install` to update the lockfile. Commit both alongside the release changes.
2. Run the release gate locally on the release commit, with Node 24 and pnpm 11.3.0:

   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter mutant-cafe build
   node scripts/pack-smoke.mjs
   ```

   The gate writes `dist/mutant-cafe-<version>.tgz`, prints its SHA256, installs that exact tarball in a temporary Effect/Vitest project, and requires exit 2 with the Frozen swallow in withdraw reported as missed. It never publishes.
3. Once that commit is on `main`, push a matching tag, for example `v0.1.1`.
4. **Actions → Release** checks that the tag matches the package version, installs the frozen lockfile, builds, runs the same tarball gate, and stages that tarball with `npm stage publish --provenance --access public`. A staged version is on the registry but not installable.
5. A maintainer reviews the staged version and approves it with 2FA, either on npmjs.com (the package's **Staged Packages** tab) or from a terminal:

   ```sh
   npm stage list mutant-cafe
   npm stage approve <stage-id>
   ```

   `npm stage download <stage-id>` fetches the staged tarball for inspection first; `npm stage reject <stage-id>` throws it away.
6. Check the version, `latest` dist-tag and provenance on npmjs.com before announcing it.

The OIDC token can stage but cannot approve, reject or list staged versions. If the version is already published, the workflow skips staging. Staged and published versions share one version index, so re-running a release whose version is already staged fails; approve or reject the staged one instead.

## Trusted publisher setup

On npmjs.com, open the `mutant-cafe` package, choose **Settings → Trusted Publisher → GitHub Actions**, and set **Organization or user** `joelhooks`, **Repository** `mutant-cafe`, **Workflow filename** `release.yml` (filename only), **Environment name** blank (the workflow declares none), with permission **npm stage publish** only.

The workflow uses npm 11.16.0 and Node 24 on a GitHub-hosted runner, requests `id-token: write` for OIDC and uses no npm token. Provenance requires the source repository to be public.

Sources: [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [staged publishing](https://docs.npmjs.com/staged-publishing/), [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage/).

## When it fails

A failed gate stages nothing. If OIDC fails, check that the owner, repository and workflow filename match the npm settings exactly. Do not add an `NPM_TOKEN` workaround. Published npm versions cannot be overwritten; fix a bad release with a new version.
