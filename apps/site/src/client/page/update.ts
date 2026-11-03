import type { Update } from "foldkit";

import type { PageMessage } from "./message.js";
import type { PageModel } from "./model.js";

export const update = (
  model: PageModel,
  _message: PageMessage,
): Update.Return<PageModel, PageMessage> => ({ model });
