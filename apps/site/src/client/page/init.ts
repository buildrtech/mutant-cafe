import type { Update } from "foldkit";

import type { PageMessage } from "./message.js";
import type { PageFlags, PageModel } from "./model.js";

export const init = (flags: PageFlags): Update.Return<PageModel, PageMessage> => ({
  model: flags,
});
