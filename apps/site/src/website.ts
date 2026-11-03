import * as Cloudflare from "@alchemy.run/cloudflare";

import { site } from "./site.js";

export class Website extends Cloudflare.Website.Foldkit<Website>()("Website", {
  rootDir: ".",
  memo: {
    workspaces: [
      { cwd: "../..", include: ["README.md", "assets/**"], lockfile: true },
    ],
  },
  compatibility: { date: "2026-05-28" },
  domain: site.domain,
  workersDev: false,
}) {}
