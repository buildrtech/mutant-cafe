interface LineEdit { readonly sign: " " | "+" | "-"; readonly text: string }

// Myers' shortest edit path. Function-body mutations commonly retain almost
// every line inside a new wrapper, so a prefix/suffix-only diff is not enough.
const shortestEdits = (before: ReadonlyArray<string>, after: ReadonlyArray<string>): ReadonlyArray<LineEdit> => {
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  for (let distance = 0; distance <= before.length + after.length; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -Infinity) < (frontier.get(diagonal + 1) ?? -Infinity));
      let x = down ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) { x++; y++; }
      frontier.set(diagonal, x);
      if (x < before.length || y < after.length) continue;
      const result: LineEdit[] = [];
      x = before.length;
      y = after.length;
      for (let depth = trace.length - 1; depth >= 0; depth--) {
        const previous = trace[depth]!;
        const k = x - y;
        const down = k === -depth || (k !== depth && (previous.get(k - 1) ?? -Infinity) < (previous.get(k + 1) ?? -Infinity));
        const previousK = down ? k + 1 : k - 1;
        const previousX = previous.get(previousK) ?? 0;
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) { result.push({ sign: " ", text: before[--x]! }); y--; }
        if (depth === 0) break;
        if (x === previousX) result.push({ sign: "+", text: after[--y]! });
        else result.push({ sign: "-", text: before[--x]! });
      }
      return result.reverse();
    }
  }
  return [];
};

const edits = (before: ReadonlyArray<string>, after: ReadonlyArray<string>): ReadonlyArray<LineEdit> => {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const left = before.slice(prefix, before.length - suffix);
  const right = after.slice(prefix, after.length - suffix);
  const shared = new Set(left);
  const middle: ReadonlyArray<LineEdit> = right.some((text) => shared.has(text))
    ? shortestEdits(left, right)
    : [...left.map((text): LineEdit => ({ sign: "-", text })), ...right.map((text): LineEdit => ({ sign: "+", text }))];
  return [...before.slice(0, prefix).map((text): LineEdit => ({ sign: " ", text })), ...middle,
    ...before.slice(before.length - suffix).map((text): LineEdit => ({ sign: " ", text }))];
};

const lines = (text: string): ReadonlyArray<string> => {
  if (!text) return [];
  const result = text.split("\n");
  if (text.endsWith("\n")) result.pop();
  else result[result.length - 1] += "\n\\ No newline at end of file";
  return result;
};

export const unifiedDiff = (original: string, modified: string, file: string): string => {
  if (original === modified) return "";
  const changes = edits(lines(original), lines(modified));
  const positions: Array<{ readonly old: number; readonly next: number }> = [];
  let old = 1;
  let next = 1;
  for (const edit of changes) {
    positions.push({ old, next });
    if (edit.sign !== "+") old++;
    if (edit.sign !== "-") next++;
  }
  const changed = changes.flatMap((edit, index) => edit.sign === " " ? [] : [index]);
  const quotePath = (path: string) => /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
  const output = [`--- ${quotePath(`a/${file}`)}`, `+++ ${quotePath(`b/${file}`)}`];
  for (let i = 0; i < changed.length; i++) {
    const start = Math.max(0, changed[i]! - 3);
    let last = changed[i]!;
    while (i + 1 < changed.length && changed[i + 1]! - last <= 7) last = changed[++i]!;
    const hunk = changes.slice(start, last + 4);
    const oldCount = hunk.filter((edit) => edit.sign !== "+").length;
    const newCount = hunk.filter((edit) => edit.sign !== "-").length;
    const position = positions[start]!;
    output.push(`@@ -${oldCount ? position.old : position.old - 1},${oldCount} +${newCount ? position.next : position.next - 1},${newCount} @@`, ...hunk.map((edit) => edit.sign + edit.text));
  }
  return [...output, ""].join("\n");
};
