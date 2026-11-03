import * as Markdown from "@foldkit/markdown";
import type { Document, HtmlBuilder } from "foldkit/html";

import type { PageMessage } from "../client/page/message.js";
import type { PageModel } from "../client/page/model.js";
import { site } from "../site.js";

export const view = (
  model: PageModel,
  h: HtmlBuilder<PageMessage>,
): Document => ({
  title: site.title,
  lang: "en",
  canonical: site.origin,
  body: h.main(
    [],
    Markdown.viewBlocks(model.document, {
      views: {
        Image: (image) =>
          image.url === site.readmeImage
            ? h.img([
                h.Src(site.image),
                h.Alt(image.alt),
                h.Width("1200"),
                h.Height("630"),
              ])
            : Markdown.defaultViews.Image(image),
      },
    }),
  ),
});
