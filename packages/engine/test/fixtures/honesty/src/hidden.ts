import { Data, Effect } from "effect";

class Hidden extends Data.TaggedError("Hidden")<{ readonly use: () => void }> {}
export const hidden = (): Effect.Effect<boolean, Hidden> => Effect.fail(new Hidden({ use: () => {} }));
export type HiddenError = Hidden;
