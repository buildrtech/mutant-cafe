/** Keep BOMs, shebangs and directive prologues ahead of temporary probe code. */
export function prologueEnd(source: string): number {
  let position = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.startsWith("#!", position)) {
    const newline = source.indexOf("\n", position);
    position = newline < 0 ? source.length : newline + 1;
  }
  const trivia = (from: number): number => {
    let at = from;
    while (at < source.length) {
      if (/\s/.test(source[at]!)) { at++; continue; }
      if (source.startsWith("//", at)) {
        const end = source.indexOf("\n", at);
        at = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("/*", at)) {
        const end = source.indexOf("*/", at + 2);
        at = end < 0 ? source.length : end + 2;
        continue;
      }
      break;
    }
    return at;
  };
  while (position < source.length) {
    const start = trivia(position);
    const quote = source[start];
    if (quote !== '"' && quote !== "'") break;
    let end = start + 1;
    while (end < source.length && source[end] !== quote) end += source[end] === "\\" ? 2 : 1;
    if (end >= source.length) break;
    end++;
    const next = trivia(end);
    if (source[next] === ";") { position = next + 1; continue; }
    const continuation = /^(?:[([.`+*/%<>=!?:&,|^~\-]|in\b|instanceof\b)/.test(source.slice(next));
    if (next === source.length || (!continuation && /[\r\n]/.test(source.slice(end, next)))) { position = next; continue; }
    break;
  }
  return position;
}

export function poisonInsertion(source: string, signal: string, token: string): { readonly offset: number; readonly text: string } {
  return { offset: prologueEnd(source), text: `\ntry { globalThis.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(signal)}, ${JSON.stringify(token)}); }
catch { console.error(${JSON.stringify(token)}); }
try { globalThis[globalThis.Symbol.for(${JSON.stringify(token)})] = true; } catch {}
throw new Error(${JSON.stringify(token)});\n` };
}
