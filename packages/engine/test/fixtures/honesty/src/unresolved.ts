// Deliberately unresolved compiler input: a real typed call has no declaration.
import { missing } from "./unresolved-dependency.ts";
export const unresolved = <T>(...args: T[]) => missing<T>(...args);
