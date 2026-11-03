import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

import Placeholder from "./src/worker.ts";

export default Alchemy.Stack(
  "MutantCafe",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state({
      workerName: "alchemy-state-store-ratstack-state-store",
    }),
  },
  Effect.gen(function* stack() {
    const worker = yield* Placeholder;
    return { url: worker.url };
  })
);
