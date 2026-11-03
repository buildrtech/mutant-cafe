# Releasing mutant-cafe

## First release: 0.1.0

Use Node 24 and pnpm 11.3.0.

```sh
pnpm install --frozen-lockfile
pnpm --filter mutant-cafe build
node scripts/pack-smoke.mjs
```

The gate writes `dist/mutant-cafe-0.1.0.tgz`, prints its SHA256, installs that exact tarball in a temporary Effect/Vitest project, and requires exit 2 with the Frozen swallow in withdraw reported as missed. It never publishes.

After checking the gate and checksum, a maintainer logs into npm and hand-publishes the tested artifact:

```sh
npm publish dist/mutant-cafe-0.1.0.tgz --access public
```

Do not push a `v0.1.0` tag to publish it again.

## One-time trusted publisher setup

After the first publish:

1. Open the `mutant-cafe` package on npmjs.com, choose **Settings**, find **Trusted Publisher**, and select **GitHub Actions**.
2. Set **Organization or user** to `joelhooks`, **Repository** to `mutant-cafe`, and **Workflow filename** to `release.yml` (filename only). Leave **Environment name** blank because the workflow does not declare an environment. Save.

The repository must contain `.github/workflows/release.yml`. Trusted publishing requires npm CLI 11.5.1 or later and Node 22.14.0 or later; this workflow uses npm 11.16.0 and Node 24 on a GitHub-hosted runner. It requests `id-token: write` for OIDC and uses no npm token. Provenance requires the source repository to be public.

Source: [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## 0.1.1 and later

1. Update `packages/mutant-cafe/package.json` to the next version and run `pnpm install` to update the lockfile. Commit both alongside the release changes.
2. Run the build and pack smoke above on the release commit. Check the printed SHA256 and passing smoke result.
3. Once that commit is on the release branch, create and push a matching tag, for example `v0.1.1`.
4. Watch **Actions → Release**. It verifies tag/version agreement, installs the frozen lockfile, builds, runs the tarball smoke, and publishes that same tarball with `--provenance --access public`.
5. Check the version and provenance on npmjs.com before announcing it.

A failed gate does not publish. If OIDC fails, check that the owner, repository, and workflow filename match the npm settings exactly. Do not add an `NPM_TOKEN` workaround. Published npm versions cannot be overwritten; fix a bad release with a new version.
