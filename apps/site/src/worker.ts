import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { placeholderHtml } from "./page.ts";

export default Cloudflare.Worker(
  "MutantCafePlaceholder",
  {
    compatibility: { date: "2026-05-28" },
    domain: { name: "mutant.cafe", redirects: ["www.mutant.cafe"] },
    main: import.meta.url,
  },
  Effect.succeed({
    fetch: Effect.succeed(
      HttpServerResponse.html(placeholderHtml, {
        headers: {
          "cache-control": "public, max-age=300",
          "x-robots-tag": "noindex",
        },
      })
    ),
  })
);
