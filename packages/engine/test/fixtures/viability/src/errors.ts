import { Schema } from "effect";
export class BoomError extends Schema.TaggedError<BoomError>()("BoomError", {}) {}
