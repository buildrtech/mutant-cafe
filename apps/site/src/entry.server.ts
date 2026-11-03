import * as Markdown from "@foldkit/markdown";
import * as Effect from "effect/Effect";
import * as Server from "foldkit/experimental/server";

import readme from "../../../README.md";
import { init } from "./client/page/init.js";
import { Flags } from "./client/page/model.js";
import { view } from "./features/page.js";
import { site } from "./site.js";

export const prerenderPaths = ["/"];

const flags = { document: Markdown.decodeDocument(readme) };

export const renderDocument: Server.DocumentRenderer = (application, assets) =>
  Server.renderDocument(application, assets, {
    head: [
      '<meta name="robots" content="noindex">',
      `<meta property="og:image" content="${site.origin}${site.image}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:image" content="${site.origin}${site.image}">`,
    ].join("\n"),
  });

const render = Effect.fn("site.render")(function* (request: Request) {
  if (new URL(request.url).pathname !== "/") {
    return Server.Responded(new Response("Not found", { status: 404 }));
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Server.Responded(
      new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      }),
    );
  }

  return Server.Rendered(
    yield* Server.renderToString({ Flags, init, view }, { flags }),
  );
});

export const renderPage = (request: Request) => Effect.runPromise(render(request));
