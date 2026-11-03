import { MarkdownDocument } from "@foldkit/markdown";
import * as Schema from "effect/Schema";

export const Flags = Schema.Struct({ document: MarkdownDocument });
export type PageFlags = typeof Flags.Type;

export const Model = Flags;
export type PageModel = typeof Model.Type;
