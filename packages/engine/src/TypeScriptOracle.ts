// Compiler-host boundary: TS requires synchronous native paths; matchesGlob has no Effect Path equivalent.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, resolve, relative, matchesGlob } from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import * as ts from "typescript/unstable/ast";
import { API, DiagnosticCategory, NodeBuilderFlags, ObjectFlags, SignatureKind, SymbolFlags, TypeFlags, type Checker, type Diagnostic, Signature, type InterfaceType, type NodeHandle, type ObjectType, type Project, type Snapshot, Symbol as TsSymbol, type Type, type TypeReference, type UnionOrIntersectionType, type LiteralType, type StringLiteralType, type NumberLiteralType } from "typescript/unstable/sync";
import { ProgramLoadError, type Mutant, type NotMutated, type RunConfig, type Viability } from "@mutant-cafe/core";
import type { MutableFunction, ReturnShape, TaggedValue, TypeOracle, Value } from "./TypeOracle.ts";

type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
type Family = "Effect" | "Option" | "Stream" | "Layer";

// TypeScript 7 runs the compiler in a native process. Its API mirrors types,
// symbols, and declarations as client objects, so identity is by id or position.
const isUnion = (type: Type): type is UnionOrIntersectionType => (type.flags & TypeFlags.Union) !== 0;
const isIntersection = (type: Type): type is UnionOrIntersectionType => (type.flags & TypeFlags.Intersection) !== 0;
const isLiteral = (type: Type): type is LiteralType => (type.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral | TypeFlags.BigIntLiteral)) !== 0;
const isStringLiteral = (type: Type): type is StringLiteralType => (type.flags & TypeFlags.StringLiteral) !== 0;
const isNumberLiteral = (type: Type): type is NumberLiteralType => (type.flags & TypeFlags.NumberLiteral) !== 0;
const sameType = (a: Type | undefined, b: Type | undefined): boolean => a !== undefined && b !== undefined && a.id === b.id;
const sameSymbol = (a: TsSymbol | undefined, b: TsSymbol | undefined): boolean => a !== undefined && b !== undefined && a.id === b.id;
const sameDeclaration = (a: NodeHandle | undefined, b: NodeHandle | undefined): boolean => a !== undefined && b !== undefined && a.path === b.path && a.index === b.index;

function declares(handle: NodeHandle | undefined, node: ts.Node): boolean {
  if (!handle || handle.kind !== node.kind || handle.path !== node.getSourceFile().path) return false;
  const resolved = handle.resolve();
  return resolved !== undefined && resolved.pos === node.pos && resolved.end === node.end;
}

function typeAt(checker: Checker, node: ts.Node): Type {
  const type = checker.getTypeAtLocation(node);
  if (!type) throw new Error(`compiler returned no type for ${ts.SyntaxKind[node.kind]}`);
  return type;
}

function returnType(checker: Checker, signature: Signature): Type {
  const type = checker.getReturnTypeOfSignature(signature);
  if (!type) throw new Error("compiler returned no return type for a signature");
  return type;
}

const typeOnly = (clause: ts.ImportClause | undefined): boolean => clause?.phaseModifier === ts.SyntaxKind.TypeKeyword;

function findAncestor<T extends ts.Node>(node: ts.Node | undefined, test: ((node: ts.Node) => node is T) | ((node: ts.Node) => boolean)): T | undefined {
  while (node) {
    if (test(node)) return node as T;
    node = node.kind === ts.SyntaxKind.SourceFile ? undefined : node.parent;
  }
  return undefined;
}

// TypeScript 7's API has no getSymbolsInScope. The names a mutation can spell
// are the ones the file already uses, so resolve each identifier it contains.
// Only names the file imports or declares can alias a type or reach a constructor;
// global types always resolve by name, so they never need an alias.
const declaredNames = new Set([ts.SyntaxKind.ImportSpecifier, ts.SyntaxKind.ImportClause, ts.SyntaxKind.NamespaceImport, ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.ModuleDeclaration, ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.Parameter, ts.SyntaxKind.TypeParameter]);

const isScope = (node: ts.Node): boolean => isFunction(node) || ts.isClassDeclaration(node) || ts.isModuleBlock(node) || ts.isSourceFile(node);

// Each name crosses a process boundary, so a name is resolved once, at the function,
// class, or module that declares it; block-level shadowing does not matter here.
const declaredByScope = new WeakMap<ts.SourceFile, Map<ts.Node, ReadonlyArray<string>>>();
const scopes = new WeakMap<Checker, Map<string, TsSymbol[]>>();
function symbolsInScope(checker: Checker, location: ts.Node, meaning: SymbolFlags): TsSymbol[] {
  const source = location.getSourceFile();
  let declared = declaredByScope.get(source);
  if (!declared) {
    const names = new Map<ts.Node, string[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && declaredNames.has(node.parent.kind) && (node.parent as { readonly name?: ts.Node }).name === node) {
        // A parameter belongs to its function; a declaration's name to the scope around it.
        const scope = findAncestor(node.parent.parent, isScope)!;
        names.set(scope, [...names.get(scope) ?? [], node.text]);
      }
      node.forEachChild(visit);
    };
    visit(source);
    declaredByScope.set(source, declared = names);
  }
  const container = findAncestor(location, isScope)!;
  const key = `${source.path}:${container.pos}:${container.kind}:${meaning}`;
  let cache = scopes.get(checker);
  if (!cache) scopes.set(checker, cache = new Map());
  const cached = cache.get(key);
  if (cached) return cached;
  const symbols = new Map<number, TsSymbol>();
  const shadowed = new Set<string>();
  for (let scope: ts.Node | undefined = container; scope; scope = scope.parent && findAncestor(scope.parent, isScope)) {
    for (const name of declared.get(scope) ?? []) {
      if (shadowed.has(name)) continue;
      shadowed.add(name);
      const symbol = checker.resolveName(name, meaning, scope, false);
      if (symbol && symbol.name === name) symbols.set(symbol.id, symbol);
    }
  }
  const result = [...symbols.values()];
  cache.set(key, result);
  return result;
}

// Every checker query crosses a process boundary, and discovery asks the same ones of
// one snapshot many times, so answers are memoized per checker by their arguments.
const cachedQueries = ["resolveName", "getPropertiesOfType", "getPropertyOfType", "typeToString", "getTypeAtLocation", "getTypeOfSymbolAtLocation",
  "getSignaturesOfType", "isTupleType", "isArrayType", "isArrayLikeType", "getBaseTypes", "getTypeArguments", "getReturnTypeOfSignature", "getIndexInfosOfType"] as const;
const objectKeys = new WeakMap<object, number>();
let nextObjectKey = 0;
const argumentKey = (value: unknown): string => {
  if (typeof value !== "object" || value === null) return `${typeof value}:${String(value)}`;
  if (value instanceof Signature) return `g${value.id}`;
  if (value instanceof TsSymbol) return `s${value.id}`;
  if ("objectFlags" in value && "id" in value) return `t${String(value.id)}`;
  let key = objectKeys.get(value);
  if (key === undefined) objectKeys.set(value, key = nextObjectKey++);
  return `n${key}`;
};
const cachedCheckers = new WeakMap<Checker, Checker>();
function cachedChecker(checker: Checker): Checker {
  let cached = cachedCheckers.get(checker);
  if (cached) return cached;
  const overrides: Record<string, unknown> = {};
  for (const name of cachedQueries) {
    const answers = new Map<string, unknown>();
    const query = (checker[name] as (...args: unknown[]) => unknown).bind(checker);
    overrides[name] = (...args: unknown[]) => {
      const key = args.map(argumentKey).join("|");
      if (!answers.has(key)) answers.set(key, query(...args));
      return answers.get(key);
    };
  }
  cached = Object.assign(Object.create(checker) as Checker, overrides);
  cachedCheckers.set(checker, cached);
  return cached;
}

const memo = <T>(cache: WeakMap<Checker, Map<number, T>>, checker: Checker, id: number, compute: () => T): T => {
  let entries = cache.get(checker);
  if (!entries) cache.set(checker, entries = new Map());
  if (!entries.has(id)) entries.set(id, compute());
  return entries.get(id)!;
};
const aliasTargets = new WeakMap<Checker, Map<number, TsSymbol>>();
const declaredTypes = new WeakMap<Checker, Map<number, number | undefined>>();
const aliasTarget = (checker: Checker, symbol: TsSymbol): TsSymbol =>
  symbol.flags & SymbolFlags.Alias ? memo(aliasTargets, checker, symbol.id, () => checker.getAliasedSymbol(symbol)) : symbol;
const declaredTypeId = (checker: Checker, symbol: TsSymbol): number | undefined =>
  memo(declaredTypes, checker, symbol.id, () => checker.getDeclaredTypeOfSymbol(symbol)?.id);

function diagnosticsText(items: ReadonlyArray<Diagnostic>, project?: Project): string[] {
  return items.map((d) => {
    if (!d.fileName) return `TS${d.code}: ${d.text}`;
    const position = lineAndCharacter(d.fileName, d.pos, project);
    return position ? `${d.fileName}:${position.line + 1}:${position.character + 1} TS${d.code}: ${d.text}` : `${d.fileName} TS${d.code}: ${d.text}`;
  });
}

// Config diagnostics point into the tsconfig, which is not a program source file.
function lineAndCharacter(fileName: string, position: number, project?: Project): ts.LineAndCharacter | undefined {
  const source = project?.program.getSourceFile(fileName);
  if (source) return source.getLineAndCharacterOfPosition(position);
  try {
    const before = readFileSync(fileName, "utf8").slice(0, position).split(/\r?\n/);
    return { line: before.length - 1, character: before.at(-1)!.length };
  } catch {
    return undefined;
  }
}

const errors = (items: ReadonlyArray<Diagnostic>): Diagnostic[] => items.filter((d) => d.category === DiagnosticCategory.Error);

class ProgramSession {
  readonly api: API;
  readonly configPath: string;
  readonly snapshot: Snapshot;
  readonly project: Project;
  readonly overlay = new Map<string, string>();
  /** The file a viability check left mutated in the compiler's latest snapshot. */
  private dirty: string | undefined;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.api = new API({ cwd: dirname(configPath), fs: { readFile: (file) => this.overlay.get(resolve(file)) } });
    // TypeScript 7 loads no project for a config it cannot read; report it the way tsc does.
    const unreadable = (): ProgramLoadError => {
      this.api.close();
      return new ProgramLoadError({ tsconfig: configPath, diagnostics: [`TS5083: Cannot read file '${configPath}'.`] });
    };
    try {
      this.snapshot = this.api.updateSnapshot({ openProjects: [configPath] });
    } catch {
      throw unreadable();
    }
    const project = this.snapshot.getProject(configPath);
    if (!project) throw unreadable();
    this.project = project;
    const config = errors(project.program.getConfigFileParsingDiagnostics());
    if (config.length) throw new ProgramLoadError({ tsconfig: configPath, diagnostics: diagnosticsText(config, project) });
    const failures = errors([...project.program.getProgramDiagnostics(), ...project.program.getSyntacticDiagnostics()]);
    if (failures.length) throw new ProgramLoadError({ tsconfig: configPath, diagnostics: diagnosticsText(failures, project) });
  }

  check(mutant: Mutant): Viability {
    const file = resolve(mutant.file);
    const source = this.project.program.getSourceFile(file);
    if (!source) return { viable: false, diagnostics: [], analysisFailed: { file: mutant.file, functionName: mutant.functionName, span: mutant.span, reason: "analysis failed: source file was not loaded" } };
    const { startOffset, endOffset, text } = mutant.replacement;
    if (startOffset < 0 || endOffset < startOffset || endOffset > source.text.length) {
      return { viable: false, diagnostics: ["Replacement offsets are outside the original file"] };
    }
    const analysisFailed = (reason: string): Viability => ({ viable: false, diagnostics: [],
      analysisFailed: { file: mutant.file, functionName: mutant.functionName, span: mutant.span, reason } });
    this.overlay.set(file, source.text.slice(0, startOffset) + text + source.text.slice(endOffset));
    // A file the previous check mutated reads from disk again.
    const changed = this.dirty && this.dirty !== file ? [file, this.dirty] : [file];
    try {
      const snapshot = this.api.updateSnapshot({ fileChanges: { changed } });
      this.dirty = file;
      try {
        // The API client can hand back a cached AST of the original file for a
        // snapshot that changed it, so read the mutated file from the server.
        this.api.clearSourceFileCache();
        const mutated = snapshot.getProject(this.configPath);
        const changedSource = mutated?.program.getSourceFile(file);
        if (!mutated || !changedSource) throw new Error(`Mutated source not found: ${file}`);
        const issue = typedCallIssue(changedSource, mutated.checker, true);
        if (issue) return analysisFailed(issue);
        const diagnostics = errors([...mutated.program.getSyntacticDiagnostics(file), ...mutated.program.getSemanticDiagnostics(file)]);
        return { viable: diagnostics.length === 0, diagnostics: diagnosticsText(diagnostics, mutated) };
      } finally {
        snapshot.dispose();
      }
    } catch (error) {
      return analysisFailed(`analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.overlay.delete(file);
    }
  }
}

/** TypeScript 7 runs as a native analysis process beside the workspace compiler. */
export function makeTypeScriptOracle(): TypeOracle {
  const sessions = new Map<string, ProgramSession>();
  const owners = new Map<string, ProgramSession>();
  return {
    discover(config) {
      const notMutated: NotMutated[] = [];
      const functions: MutableFunction[] = [];
      const configPath = resolve(config.root, config.tsconfig);
      let session = sessions.get(configPath);
      if (!session) {
        session = new ProgramSession(configPath);
        sessions.set(configPath, session);
      }
      const checker = cachedChecker(session.project.checker);
      const matched = new Set<string>();
      for (const fileName of session.project.program.getSourceFileNames()) {
        const file = resolve(fileName);
        const local = relative(config.root, file).replaceAll("\\", "/");
        // Test support lives beside the project, so judge it relative to the tsconfig.
        const project = relative(dirname(configPath), file).replaceAll("\\", "/");
        // Judge the name before fetching the file, since each source crosses a process boundary.
        if (/\.d\.[cm]?ts$/.test(local) || local.startsWith("../") || /(?:^|\/)(?:node_modules|__tests__|__mocks__|tests?)\//.test(project) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(local)) continue;
        const source = session.project.program.getSourceFile(fileName);
        if (!source || source.isDeclarationFile) continue;
        for (const glob of config.include) if (matchesGlob(local, glob)) matched.add(glob);
        if (config.include.length && !config.include.some((glob) => matchesGlob(local, glob))) continue;
        if (config.exclude.some((glob) => matchesGlob(local, glob))) continue;
        owners.set(file, session);
        const api = imports(source);
        const excluded = new Set<ts.Node>();
        const visit = (node: ts.Node): void => {
          try {
            if (isFunction(node) && node.body && !mutable(node, checker)) {
              if (!findAncestor(node.parent, parent => excluded.has(parent))) notMutated.push({ file, functionName: `${functionName(node, checker)}.<callback>`, span: nodeSpan(node), reason: "callback position (not mutated yet)" });
            }
            if (isFunction(node) && node.body && mutable(node, checker)) {
              const name = functionName(node, checker);
              const reason = skipped(node) ? "excluded by @mutants-skip"
                : config.exportedOnly && !publicOwner(node, checker) ? "excluded by --exported-only"
                : config.functionFilter.length && !config.functionFilter.some(filter => matchesGlob(name, filter)) ? "excluded by function filter"
                : undefined;
              if (reason) { excluded.add(node); notMutated.push({ file, functionName: name, span: nodeSpan(node.body), reason }); }
              if (!reason && (!config.functionFilter.length || config.functionFilter.some((filter) => matchesGlob(name, filter)))) {
                const signature = checker.getSignatureFromDeclaration(node);
                if (signature) {
                  const wrapped = wrappedEffect(node, checker);
                  const type = wrapped ?? returnType(checker, signature);
                  const generator = wrapped && ts.isFunctionExpression(node) ? node : generatorBody(node, checker);
                  const body = generator?.body ?? node.body;
                  const start = body.getStart(source);
                  const end = body.getEnd();
                  const a = source.getLineAndCharacterOfPosition(start);
                  const b = source.getLineAndCharacterOfPosition(end);
                  const beforePipeables = wrapped && ts.isFunctionExpression(node) ? generatorContract(node, checker) : undefined;
                  const shape = beforePipeables?.shape ?? shapeOf(type, checker, node, body);
                  const originals = equivalentSuccessValues(body, api);
                  if ((!beforePipeables && (type.flags & TypeFlags.TypeParameter) && !("values" in shape && shape.values.length)) || (beforePipeables ? !nameableContract(beforePipeables, checker, node) : hasUnnameableType(type, checker, node))) {
                    notMutated.push({ file, functionName: name, span: nodeSpan(node), reason: "generic: naked or context-only type-parameter return" });
                  } else found.push({
                    file, name, functionLike: true, functionSpan: nodeSpan(body), generationIssue: () => typedCallIssue(body, checker), notices: shapeNotices(shape, type, checker, node), returnType: beforePipeables?.text ?? returnTypeText(type, checker, node),
                    displayReturnType: node.type?.getText(source) ?? checker.typeToString(type, node),
                    skipReason: beforePipeables ? `no synthesizable generator success value: ${beforePipeables.text}` : synthesisReason(type, checker, node),
                    equivalentValues: shape.kind === "Effect" ? shape.values.filter((value) => isEquivalentSuccess(value.text, originals)).map((value) => value.text) : [],
                    span: { start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 } },
                    startOffset: start, endOffset: end, original: body.getText(source),
                    identityFile: local, logicalSpan: { offset: start - node.getStart(source), length: end - start },
                    sourcePrefix: source.text.slice(0, start), importInsertionOffset: importInsertionOffset(source), extraImports: mutationImports(source),
                    literal: literalOfBody(body, checker),
                    block: ts.isBlock(body), generator: generator !== undefined,
                    shape, api,
                  });
                } else notMutated.push({ file, functionName: name, span: nodeSpan(node), reason: "missing callable signature" });
              }
            }
            // A Layer value is a buildable program even when it is not a function.
            if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer) {
              const type = typeAt(checker, node.initializer);
              if (family(type, checker)?.kind === "Layer") {
                const name = valuePath(node);
                const reason = skippedNode(node) ? "excluded by @mutants-skip"
                  : config.exportedOnly && !publicOwner(node, checker) ? "excluded by --exported-only"
                  : config.functionFilter.length && !config.functionFilter.some(filter => matchesGlob(name, filter)) ? "excluded by function filter" : undefined;
                if (reason) { excluded.add(node.initializer); notMutated.push({ file, functionName: name, span: nodeSpan(node.initializer), reason }); }
                if (!reason) {
                  const body = node.initializer;
                  const a = source.getLineAndCharacterOfPosition(body.getStart(source));
                  const b = source.getLineAndCharacterOfPosition(body.getEnd());
                  found.push({ file, name, functionLike: false, generationIssue: () => typedCallIssue(body, checker), notices: shapeNotices(shapeOf(type, checker, node, body), type, checker, node), returnType: returnTypeText(type, checker, node), displayReturnType: checker.typeToString(type, node),
                    equivalentValues: [], span: { start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 } },
                    startOffset: body.getStart(source), endOffset: body.getEnd(), original: body.getText(source), literal: undefined,
                    identityFile: local, logicalSpan: { offset: body.getStart(source) - node.getStart(source), length: body.getWidth(source) },
                    sourcePrefix: source.text.slice(0, body.getStart(source)), importInsertionOffset: importInsertionOffset(source), extraImports: mutationImports(source),
                    block: false, generator: false, shape: shapeOf(type, checker, node, body), api });
                }
              }
            }
          } catch (error) {
            // Source analysis is best-effort. A single checker hole must not masquerade as a config failure.
            const target = isFunction(node) ? node.body
              : (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) ? node.initializer : undefined;
            if (target) notMutated.push({ file, functionName: valuePath(node), span: nodeSpan(target),
              reason: `analysis failed: ${error instanceof Error ? error.message : String(error)}` });
          }
          node.forEachChild(visit);
        };
        const found: MutableFunction[] = [];
        visit(source);
        const occurrences = new Map<string, number>();
        for (const fn of found) {
          const ordinal = occurrences.get(fn.name) ?? 0;
          occurrences.set(fn.name, ordinal + 1);
          functions.push({ ...fn, identityOrdinal: ordinal });
        }
      }
      const unmatched = config.include.filter((glob) => !matched.has(glob));
      if (unmatched.length) throw new ProgramLoadError({ tsconfig: configPath, reason: "selection", diagnostics: unmatched.map((glob) => {
        const target = relative(config.root, resolve(config.root, glob));
        const outside = target === ".." || target.startsWith("../");
        return `No source file matched ${JSON.stringify(glob)}${outside ? " (path is outside the package root)" : ""}`;
      }) });
      return { functions, notMutated: [...new Map(notMutated.map(item => [JSON.stringify(item), item])).values()] };
    },
    checkViable(mutant) {
      const session = owners.get(resolve(mutant.file));
      if (!session) return { viable: false, diagnostics: [], analysisFailed: { file: mutant.file, functionName: mutant.functionName, span: mutant.span, reason: "analysis failed: generate mutants before checking viability" } };
      return session.check(mutant);
    },
  };
}

function typedCallIssue(body: ts.Node, checker: Checker, includeNested = false): string | undefined {
  let issue: string | undefined;
  const visit = (node: ts.Node): void => {
    if (isFunction(node) && !includeNested) return; // Nested implementations have their own discovery boundary.
    if (ts.isCallExpression(node) && node.typeArguments?.length) {
      const signature = checker.getResolvedSignature(node);
      // Unresolved imports and any-typed receivers may produce a synthetic signature with no declaration.
      // A missing declaration is data, not an exception manufactured to exercise a catch.
      if (!signature || (!signature.declaration && typeAt(checker, node.expression).flags & TypeFlags.Any)) {
        issue = `analysis failed: compiler supplied no declaration for typed call ${node.expression.getText()}; check its import or receiver type`;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(body);
  return issue;
}

function nodeSpan(node: ts.Node): Mutant["span"] {
  const source = node.getSourceFile();
  const a = source.getLineAndCharacterOfPosition(node.getStart(source));
  const b = source.getLineAndCharacterOfPosition(node.getEnd());
  return { start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 } };
}

function isFunction(node: ts.Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
}


function functionValue(node: FunctionNode, checker: Checker): ts.Node {
  const wrapper = wrappedEffect(node, checker);
  // A generator passed to Effect.gen is an implementation, not a curried value.
  return wrapper && checker.getSignaturesOfType(typeAt(checker, node.parent), SignatureKind.Call).length ? node.parent : node;
}

function returnedBy(node: FunctionNode, checker: Checker): FunctionNode | undefined {
  let value = functionValue(node, checker);
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  const parent = value.parent;
  if (ts.isArrowFunction(parent) && parent.body === value) return parent;
  if (ts.isReturnStatement(parent) && parent.expression === value && ts.isBlock(parent.parent) && isFunction(parent.parent.parent)) return parent.parent.parent;
  return undefined;
}

function mutable(node: FunctionNode, checker: Checker): boolean {
  if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) return true;
  let current: ts.Node = wrappedEffect(node, checker) ? node.parent : node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return returnedBy(node, checker) !== undefined || ((ts.isVariableDeclaration(current.parent) || ts.isPropertyAssignment(current.parent) || ts.isPropertyDeclaration(current.parent)) && current.parent.initializer === current);
}

function layerBody(boundary: FunctionNode, checker: Checker): boolean {
  let enclosing: ts.Node = boundary.parent;
  while (!ts.isSourceFile(enclosing) && !isFunction(enclosing)) {
    if (ts.isCallExpression(enclosing) && family(typeAt(checker, enclosing), checker)?.kind === "Layer") return true;
    enclosing = enclosing.parent;
  }
  return false;
}

function returnsLayer(node: FunctionNode, checker: Checker): boolean {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return false;
  const type = returnType(checker, signature);
  return (isUnion(type) ? type.getTypes() : [type]).every(member => family(member, checker)?.kind === "Layer");
}

function serviceProperty(node: ts.Node, boundary: FunctionNode, checker: Checker): boolean {
  if (!(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) || !ts.isObjectLiteralExpression(node.parent)) return false;
  const object = node.parent;
  const call = object.parent;
  return ts.isCallExpression(call) && call.arguments[0] === object
    && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "of"
    && ts.isReturnStatement(call.parent) && call.parent.parent === boundary.body && layerBody(boundary, checker);
}

function serviceMethod(node: FunctionNode, boundary: FunctionNode, checker: Checker): boolean {
  if (!layerBody(boundary, checker) || !boundary.body) return false;
  const declaration = findAncestor(node, ts.isVariableDeclaration);
  let returned = false;
  const visit = (child: ts.Node): void => {
    if (isFunction(child)) return;
    if (ts.isReturnStatement(child) && child.expression && ts.isCallExpression(child.expression)) {
      const call = child.expression;
      const object = call.arguments[0];
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "of" && object && ts.isObjectLiteralExpression(object)) {
        returned ||= object.properties.some(prop => {
          if (ts.isPropertyAssignment(prop) && (prop.initializer === functionValue(node, checker)
            || (declaration && ts.isIdentifier(prop.initializer) && declares(checker.getSymbolAtLocation(prop.initializer)?.valueDeclaration, declaration)))) return true;
          if (ts.isShorthandPropertyAssignment(prop)) return declaration !== undefined && declares(checker.getShorthandAssignmentValueSymbol(prop)?.valueDeclaration, declaration);
          return false;
        });
      }
    }
    child.forEachChild(visit);
  };
  visit(boundary.body);
  return returned;
}

function exportedBinding(binding: ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration, checker: Checker): boolean {
  let declaration: ts.Declaration = binding;
  let symbol = binding.name ? checker.getSymbolAtLocation(binding.name) : undefined;
  let container = findAncestor(binding, node => ts.isSourceFile(node) || ts.isModuleBlock(node));
  while (container) {
    const module = ts.isSourceFile(container) ? checker.getSymbolAtLocation(container)
      : ts.isModuleBlock(container) && ts.isModuleDeclaration(container.parent) ? checker.getSymbolAtLocation(container.parent.name) : undefined;
    if (!module || !checker.getExportsOfModule(module).some(item => {
      const target = item.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
      return sameSymbol(target, symbol) || declares(target.valueDeclaration, declaration);
    })) return false;
    if (ts.isSourceFile(container)) return true;
    if (!ts.isModuleBlock(container) || !ts.isModuleDeclaration(container.parent)) return false;
    declaration = container.parent;
    symbol = module;
    container = findAncestor(container.parent, node => ts.isSourceFile(node) || ts.isModuleBlock(node));
  }
  return false;
}

function publicOwner(node: ts.Node, checker: Checker, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  let current = node;
  let binding: ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration | undefined;
  let value = isFunction(node) ? node : undefined;
  let throughService = false;
  while (!ts.isSourceFile(current)) {
    if (current !== node && isFunction(current)) {
      const method = value ? serviceMethod(value, current, checker) : serviceProperty(node, current, checker);
      if (!(value && returnedBy(value, checker) === current) && !method && !(throughService && returnsLayer(current, checker))) return false;
      throughService ||= method;
      value = current;
    }
    if (ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) binding = current;
    current = current.parent;
  }
  if (!binding) return false;
  if (exportedBinding(binding, checker)) return true;
  // Follow value bindings (including shorthand aliases), not calls from an
  // exported implementation. Calling a helper does not make it a public path.
  let exposed = false;
  const declaration = binding;
  const visit = (child: ts.Node): void => {
    if (exposed) return;
    const referenced = ts.isShorthandPropertyAssignment(child) ? checker.getShorthandAssignmentValueSymbol(child)
      : ts.isPropertyAssignment(child) && ts.isIdentifier(child.initializer) ? checker.getSymbolAtLocation(child.initializer)
      : ts.isExportAssignment(child) && ts.isIdentifier(child.expression) ? checker.getSymbolAtLocation(child.expression) : undefined;
    if (declares(referenced?.valueDeclaration, declaration)) {
      exposed = ts.isExportAssignment(child) || publicOwner(child, checker, seen);
    }
    child.forEachChild(visit);
  };
  visit(current);
  return exposed;
}

function skipped(node: FunctionNode): boolean { return skippedNode(node); }
function skippedNode(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (!ts.isSourceFile(current)) {
    if (ts.getJSDocTags(current).some((tag) => tag.tagName.text === "mutants-skip")) return true;
    current = current.parent;
  }
  return false;
}

function valuePath(node: ts.Node): string {
  const parts: string[] = [];
  let current = node;
  while (!ts.isSourceFile(current)) {
    if ((ts.isVariableDeclaration(current) || ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) || ts.isModuleDeclaration(current)) && current.name) parts.unshift(current.name.getText());
    current = current.parent;
  }
  return parts.join(".") || "default";
}

function functionName(node: FunctionNode, checker: Checker): string {
  let path = valuePath(node);
  let parent = returnedBy(node, checker);
  while (parent) { path += ".<inner>"; parent = returnedBy(parent, checker); }
  return path;
}

function wrappedEffect(node: FunctionNode, checker: Checker): Type | undefined {
  if (!ts.isFunctionExpression(node) || !node.asteriskToken || !ts.isCallExpression(node.parent)) return undefined;
  const result = typeAt(checker, node.parent);
  if (family(result, checker)?.kind === "Effect") return result;
  const signature = checker.getSignaturesOfType(result, SignatureKind.Call)[0];
  if (!signature) return undefined;
  const returned = returnType(checker, signature);
  return family(returned, checker)?.kind === "Effect" ? returned : undefined;
}

function nameableContract(contract: { readonly types: ReadonlyArray<Type> }, checker: Checker, node: ts.Node): boolean {
  return contract.types.every(type => !hasUnnameableType(type, checker, node));
}

function hasUnnameableType(type: Type, checker: Checker, location: ts.Node): boolean {
  // An explicit return annotation already supplies an in-scope spelling (including type-only aliases).
  if (isFunction(location) && location.type && !location.asteriskToken) return false;
  return typeReferenceNames(returnTypeText(type, checker, location)).some((name) => !checker.resolveName(name, SymbolFlags.Type, location, false));
}

interface Token { readonly kind: ts.SyntaxKind; readonly text: string; readonly value: string }

/** TypeScript 7 ships a scanner but no parser, so printed types and synthesized values are read from tokens. */
function tokensOf(text: string): Token[] {
  const scanner = ts.createScanner(true, ts.LanguageVariant.Standard, text);
  const tokens: Token[] = [];
  // Brace depth at each open template span, so `}` resumes the template text.
  const templates: number[] = [];
  let depth = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && templates.at(-1) === depth) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === ts.SyntaxKind.OpenBraceToken) depth++;
    else if (kind === ts.SyntaxKind.CloseBraceToken) depth--;
    if (kind === ts.SyntaxKind.TemplateHead) templates.push(depth);
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  }
  return tokens;
}

const memberStarts = new Set([ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.OpenParenToken,
  ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.DotDotDotToken]);

/** The unqualified names a printed type refers to, which a parse would show as identifier type references. */
function typeReferenceNames(text: string): string[] {
  const tokens = tokensOf(text);
  // A top-level type predicate is not a type; a parse reads its parameter as the reference.
  if (tokens[0] && tokens[1]?.kind === ts.SyntaxKind.IsKeyword && /^[A-Za-z_$][\w$]*$/.test(tokens[0].text)) return [tokens[0].text];
  if (tokens[0]?.kind === ts.SyntaxKind.AssertsKeyword) return ["asserts"];
  const brackets: ts.SyntaxKind[] = [];
  return tokens.flatMap((token, index) => {
    if (token.kind === ts.SyntaxKind.OpenBraceToken || token.kind === ts.SyntaxKind.OpenBracketToken || token.kind === ts.SyntaxKind.OpenParenToken) brackets.push(token.kind);
    else if (token.kind === ts.SyntaxKind.CloseBraceToken || token.kind === ts.SyntaxKind.CloseBracketToken || token.kind === ts.SyntaxKind.CloseParenToken) brackets.pop();
    if (token.kind !== ts.SyntaxKind.Identifier) return [];
    const previous = tokens[index - 1]?.kind;
    const next = tokens[index + 1]?.kind;
    // Destructured parameters: object type members always carry a colon, so a bare name in braces is a binding.
    if (brackets.at(-1) === ts.SyntaxKind.OpenBraceToken && (previous === ts.SyntaxKind.OpenBraceToken || previous === ts.SyntaxKind.CommaToken)
      && (next === ts.SyntaxKind.CommaToken || next === ts.SyntaxKind.CloseBraceToken)) return [];
    // Qualified names, import("…").Name, and typeof queries are not plain references.
    if (previous === ts.SyntaxKind.DotToken || next === ts.SyntaxKind.DotToken || previous === ts.SyntaxKind.TypeOfKeyword) return [];
    // Type predicates, mapped type keys, and infer declarations name values or new parameters.
    if (next === ts.SyntaxKind.IsKeyword || previous === ts.SyntaxKind.AssertsKeyword || next === ts.SyntaxKind.InKeyword || previous === ts.SyntaxKind.InferKeyword) return [];
    // Property, parameter, index, and tuple member names precede a colon.
    const labelled = next === ts.SyntaxKind.ColonToken || (next === ts.SyntaxKind.QuestionToken && tokens[index + 2]?.kind === ts.SyntaxKind.ColonToken);
    if (labelled && (previous === undefined || memberStarts.has(previous))) return [];
    // Method signatures in object types.
    if (next === ts.SyntaxKind.OpenParenToken && (previous === ts.SyntaxKind.OpenBraceToken || previous === ts.SyntaxKind.SemicolonToken || previous === ts.SyntaxKind.CommaToken
      || previous === ts.SyntaxKind.GetKeyword || previous === ts.SyntaxKind.SetKeyword)) return [];
    return [token.text];
  });
}

function generatorContract(node: ts.FunctionExpression, checker: Checker): { shape: ReturnShape; text: string; types: ReadonlyArray<Type> } | undefined {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature || !node.body) return undefined;
  const iterator = returnType(checker, signature);
  const args = checker.getTypeArguments(iterator as TypeReference);
  const [yielded, success] = args;
  if (!yielded || !success) return undefined;
  const effects = (isUnion(yielded) ? yielded.getTypes() : [yielded]).flatMap(t => {
    const f = family(t, checker);
    return f?.kind === "Effect" ? [f] : [];
  });
  const print = (t: Type) => returnTypeText(t, checker, node);
  const union = (index: number) => [...new Set(effects.flatMap(f => f.args[index] ? [print(f.args[index]!)] : []))].join(" | ") || "never";
  return {
    types: [success, ...effects.flatMap(effect => effect.args.slice(1))],
    text: `import("effect/Effect").Effect<${print(success)}, ${union(1)}, ${union(2)}>`,

    shape: { kind: "Effect", values: boundedValues(success, checker, node).values, omittedValues: boundedValues(success, checker, node).omitted, synthesisIssues: boundedValues(success, checker, node).issues, enumerateRecoveries: smallFinite(success), errors: [...new Map(effects.flatMap(f => f.args[1] ? taggedValues(f.args[1], checker, node) : []).map(e => [e.tag, e])).values()] },
  };
}

function literalOfBody(body: ts.ConciseBody, checker: Checker): string | undefined {
  const first = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  const expression = ts.isBlock(body) ? first && ts.isReturnStatement(first) ? first.expression : undefined : body;
  // An array or object literal never has a literal type, and typing an arrow's `[]`
  // body panics the TypeScript 7.0 API server.
  if (!expression || ts.isArrayLiteralExpression(expression) || ts.isObjectLiteralExpression(expression)) return undefined;
  const type = typeAt(checker, expression);
  return isStringLiteral(type) ? JSON.stringify(type.value) : isNumberLiteral(type) ? String(type.value)
    : type.flags & TypeFlags.BooleanLiteral ? checker.typeToString(type) : undefined;
}

function generatorBody(node: FunctionNode, checker: Checker): ts.FunctionExpression | undefined {
  if (!node.body) return undefined;
  const expression = ts.isBlock(node.body)
    ? node.body.statements.length === 1 && ts.isReturnStatement(node.body.statements[0]!) ? node.body.statements[0]!.expression : undefined
    : node.body;
  // The return type identifies Effect; only select a direct generator callback of the wrapper.
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature || family(returnType(checker, signature), checker)?.kind !== "Effect") return undefined;
  if (expression && ts.isCallExpression(expression)) {
    return expression.arguments.find((arg): arg is ts.FunctionExpression => ts.isFunctionExpression(arg) && arg.asteriskToken !== undefined);
  }
  return undefined;
}

function imports(source: ts.SourceFile): MutableFunction["api"] {
  const namespaces = new Map<string, string>();
  const named = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || typeOnly(statement.importClause)) continue;
    const path = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (path.startsWith("effect/")) namespaces.set(path.slice(7), bindings.name.text);
      if (path === "effect") for (const module of ["Effect", "Option", "Stream", "Layer"]) namespaces.set(module, `${bindings.name.text}.${module}`);
    }
    if (ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (binding.isTypeOnly) continue;
      const imported = (binding.propertyName ?? binding.name).text;
      if (path === "effect") namespaces.set(imported, binding.name.text);
      else if (path.startsWith("effect/")) named.set(`${path.slice(7)}.${imported}`, binding.name.text);
    }
  }
  return (module, member) => {
    const namespace = namespaces.get(module);
    return namespace ? `${namespace}.${member}` : named.get(`${module}.${member}`) ?? `${mutationNamespace(source, module)}.${member}`;
  };
}

function importInsertionOffset(source: ts.SourceFile): number {
  let offset = source.text.startsWith("#!") ? (source.text.indexOf("\n") + 1 || source.text.length) : 0;
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    offset = statement.getEnd();
  }
  return offset;
}

function mutationNamespace(source: ts.SourceFile, module: string): string {
  let name = `__mutantCafe${module}`;
  while (source.text.includes(name)) name += "_";
  return name;
}

function mutationImports(source: ts.SourceFile): NonNullable<MutableFunction["extraImports"]> {
  return ["Effect", "Option", "Stream", "Layer"].map(module => {
    const namespace = mutationNamespace(source, module);
    return { namespace, statement: `import * as ${namespace} from "effect/${module}";` };
  });
}

function family(type: Type, checker: Checker): { kind: Family; args: ReadonlyArray<Type> } | undefined {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  const name = symbol?.name;
  // Declaration provenance prevents a user-defined Effect-shaped name from being mistaken for Effect.
  const fromEffect = symbol?.declarations?.some((d) => /(?:^|\/)effect\/(?:.*\/)?(?:Effect|Option|Stream|Layer)\.(?:d\.)?ts$/.test(d.path));
  if (fromEffect && (name === "Effect" || name === "Option" || name === "Stream" || name === "Layer")) {
    const aliasArguments = type.getAliasTypeArguments();
    const args = aliasArguments.length ? aliasArguments : ((type.flags & TypeFlags.Object) && (type as ObjectType).objectFlags & ObjectFlags.Reference ? checker.getTypeArguments(type as TypeReference) : []);
    return { kind: name, args };
  }
  // Type aliases may hide a referenced interface; union aliases retain their own type arguments.
  const direct = type.getSymbol();
  if (direct && direct !== symbol) {
    const name = direct.name;
    if ((name === "Effect" || name === "Stream" || name === "Layer") && direct.declarations?.some((d) => d.path.includes("/effect/"))) {
      return { kind: name, args: checker.getTypeArguments(type as TypeReference) };
    }
  }
  if (isUnion(type)) {
    const members = type.getTypes();
    const option = members.every((member) => {
      const symbol = member.getSymbol();
      return (symbol?.name === "Some" || symbol?.name === "None") && symbol.declarations?.some((d) => /\/effect\/.*Option\.(?:d\.)?ts$/.test(d.path));
    });
    if (option && members[0]) {
      const first = members.find((m) => m.getSymbol()?.name === "Some") ?? members[0];
      return { kind: "Option", args: checker.getTypeArguments(first as TypeReference) };
    }
  }
  if (type.flags & TypeFlags.Object && (type as ObjectType).objectFlags & (ObjectFlags.Class | ObjectFlags.Interface)) {
    for (const base of checker.getBaseTypes(type as InterfaceType) ?? []) {
      const detected = family(base, checker);
      if (detected) return detected;
    }
  }
  return undefined;
}

function shapeOf(type: Type, checker: Checker, node: ts.Node, body: ts.ConciseBody): ReturnShape {
  if (isUnion(type) && type.getTypes().every((member) => family(member, checker)?.kind === "Effect")) {
    const shapes = type.getTypes().map((member) => shapeOf(member, checker, node, body));
    const successes = type.getTypes().flatMap(member => family(member, checker)?.args[0] ?? []);
    const bounded = boundCandidates(successes.flatMap(success => valuesOf(success, checker, node)), successes, node);
    const errors = shapes.flatMap((shape) => shape.kind === "Effect" ? shape.errors : []);
    return { kind: "Effect",
      values: bounded.values, omittedValues: bounded.omitted, synthesisIssues: shapes.flatMap(shape => shape.synthesisIssues ?? []), enumerateRecoveries: bounded.values.length <= 4 && successes.every(smallFinite),
      errors: [...new Map(errors.map((error) => [error.tag, error])).values()].sort((a, b) => a.tag.localeCompare(b.tag, "en")),
    };
  }
  const detected = family(type, checker);
  if (detected) {
    const [a, e] = detected.args;
    if (detected.kind === "Layer") return { kind: "Layer", errors: e ? taggedValues(e, checker, node) : [] };
    const bounded = a ? boundedValues(a, checker, node) : { values: [], omitted: 0, issues: [] };
    const values = bounded.values;
    if (detected.kind === "Option") return { kind: "Option", values, omittedValues: bounded.omitted, synthesisIssues: bounded.issues };
    const errors = e ? taggedValues(e, checker, node) : [];
    return { kind: detected.kind, values, errors, omittedValues: bounded.omitted, synthesisIssues: bounded.issues, enumerateRecoveries: a !== undefined && smallFinite(a) };
  }
  if (type.flags & TypeFlags.Void) return { kind: "Void", values: [] };
  const members = isUnion(type) ? type.getTypes() : [type];
  const boolean = members.every((t) => (t.flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral)) !== 0);
  const literal = members.every((t) => isLiteral(t));
  const bounded = boundedValues(type, checker, node);
  const values = bounded.values;
  if (isFunction(node)) for (const parameter of node.parameters) {
    if (ts.isIdentifier(parameter.name) && checker.isTypeAssignableTo(typeAt(checker, parameter), type)) {
      values.push({ text: parameter.name.text, synthetic: false });
    }
  }
  return { kind: boolean ? "Boolean" : literal ? "Literal" : "Value", values, omittedValues: bounded.omitted, synthesisIssues: bounded.issues };
}

function taggedValues(type: Type, checker: Checker, location: ts.Node): TaggedValue[] {
  return (isUnion(type) ? type.getTypes() : [type]).flatMap((member) => {
    const tag = checker.getPropertyOfType(member, "_tag");
    if (!tag) return [];
    const tagType = checker.getTypeOfSymbolAtLocation(tag, location);
    if (!isStringLiteral(tagType)) return [];
    const value = constructError(member, checker, location, tagType.value);
    return [{ ...value, tag: tagType.value }];
  });
}

function constructError(type: Type, checker: Checker, location: ts.Node, tag: string): Value & { readonly reason?: string } {
  const synthetic = (reason?: string): Value & { readonly reason?: string } => ({
    text: `({ _tag: ${JSON.stringify(tag)} } as unknown as ${returnTypeText(type, checker, location)})`, synthetic: true,
    ...(reason ? { reason } : {}),
  });
  const symbol = type.getSymbol();
  if (symbol) {
    const visible = symbolsInScope(checker, location, SymbolFlags.Value | SymbolFlags.Alias).find((candidate) => {
      if (candidate.declarations?.some((handle) => {
        const declaration = handle.resolve();
        return declaration !== undefined && ((ts.isImportClause(declaration) && typeOnly(declaration))
          || (ts.isImportSpecifier(declaration) && (declaration.isTypeOnly || typeOnly(declaration.parent.parent as ts.ImportClause))));
      })) return false;
      const target = aliasTarget(checker, candidate);
      // Exported Data.TaggedError classes may expose distinct value/type
      // symbols for the same class declaration.
      return sameSymbol(target, symbol) || (symbol.declarations?.some((declaration) => target.declarations?.some((other) => sameDeclaration(other, declaration))) ?? false);
    });
    if (visible) {
      const constructor = checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(visible, location), SignatureKind.Construct)[0];
      if (constructor) {
        const arguments_: string[] = [];
        for (const param of constructor.getParameters()) {
          const fields = checker.getTypeOfSymbolAtLocation(param, location);
          if (fields.flags & (TypeFlags.Void | TypeFlags.Undefined)) continue;
          const issues = new Set<string>();
          const value = valuesOf(fields, checker, location, new Set(), 0, issues)[0];
          if (!value || value.synthetic) {
            const reason = synthesisReason(fields, checker, location);
            const field = /\(field ([^)]+)\)/.exec(reason)?.[1];
            const detail = field ? `field ${field}` : `argument ${param.name} is not synthesizable`;
            return synthetic(detail + (issues.size ? ` (${[...issues].join("; ")})` : ""));
          }
          const declaration = param.valueDeclaration?.resolve();
          const rest = declaration && ts.isParameterDeclaration(declaration) && declaration.dotDotDotToken;
          arguments_.push(`${rest ? "..." : ""}${value.text}`);
        }
        return { text: `new ${visible.name}(${arguments_.join(", ")})`, synthetic: false };
      }
    }
    if (symbol.declarations?.some((declaration) => declaration.kind === ts.SyntaxKind.ClassDeclaration)) {
      return synthetic(visible ? "constructor arguments are not synthesizable" : "class is not available as a value; import its constructor");
    }
  }
  return synthetic();
}

// Without UseAliasDefinedOutsideCurrentScope the checker emits import("./module").Name
// for names not visible here, including transitive error and Brand references.
function returnTypeText(type: Type, checker: Checker, node: ts.Node): string {
  if (isFunction(node) && node.type && !node.asteriskToken && sameType(checker.getTypeFromTypeNode(node.type), type)) return node.type.getText();
  const print = (t: Type): string => {
    if (isUnion(t)) return t.getTypes().map(print).join(" | ");
    const symbol = t.getSymbol();
    if (symbol && !checker.resolveName(symbol.name, SymbolFlags.Type, node, false)) {
      const alias = symbolsInScope(checker, node, SymbolFlags.Type | SymbolFlags.Alias).find(candidate => {
        const target = aliasTarget(checker, candidate);
        return !!target.declarations?.length && declaredTypeId(checker, target) === t.id;
      });
      if (alias) return alias.name;
    }
    return checker.typeToString(t, node, NodeBuilderFlags.NoTruncation);
  };
  if (isUnion(type)) {
    const members = type.getTypes().map((member) => family(member, checker));
    if (members.every((member) => member?.kind === "Effect")) {
      const args = [0, 1, 2].map((index) => [...new Set(members.flatMap((member) => member?.args[index] ? [print(member.args[index]!)] : []))].sort().join(" | ") || "never");
      return `import("effect/Effect").Effect<${args.join(", ")}>`;
    }
  }
  const detected = family(type, checker);
  if (detected) return `import("effect/${detected.kind}").${detected.kind}<${detected.args.map(print).join(", ")}>`;
  return print(type);
}

// Compare only literal data, never evaluate user code. Canonical keys make
// differently quoted object literals equivalent without treating calls as equal.
function literalData(node: ts.Node): unknown {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literalData(node.expression);
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return [node.kind, node.text];
  if (ts.isIdentifier(node) && node.text === "undefined") return ["undefined"];
  if (ts.isPrefixUnaryExpression(node)) return [node.operator, literalData(node.operand)];
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(literalData);
    return items.every(item => item !== undefined) ? ["array", items] : undefined;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return [node.kind];
  if (ts.isObjectLiteralExpression(node)) {
    const fields: Array<readonly [string, unknown]> = [];
    for (const field of node.properties) {
      if (!ts.isPropertyAssignment(field) || !field.name || ts.isComputedPropertyName(field.name)) return undefined;
      const value = literalData(field.initializer);
      if (value === undefined) return undefined;
      fields.push([field.name.getText().replace(/^["']|["']$/g, ""), value]);
    }
    return fields.sort(([a], [b]) => a.localeCompare(b, "en"));
  }
  return undefined;
}

function equivalentSuccessValues(body: ts.ConciseBody, api: MutableFunction["api"]): ReadonlyArray<string> {
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText() === api("Effect", "succeed") && node.arguments[0]) {
      const value = literalData(node.arguments[0]);
      if (value !== undefined) values.push(JSON.stringify(value));
    }
    node.forEachChild(visit);
  };
  visit(body);
  return values;
}

function isEquivalentSuccess(text: string, values: ReadonlyArray<string>): boolean {
  const value = literalData(parseValue(text));
  return value !== undefined && values.includes(JSON.stringify(value));
}

/** The literal structure of a synthesized value, as the nodes literalData reads. Anything else is an unknown node. */
function parseValue(text: string): ts.Node {
  const tokens = tokensOf(`(${text})`);
  let index = 0;
  const peek = (): ts.SyntaxKind | undefined => tokens[index]?.kind;
  const node = (fields: Record<string, unknown>): ts.Node => fields as unknown as ts.Node;
  const unknown = (): ts.Node => node({ kind: ts.SyntaxKind.Unknown });
  const terminators = new Set([ts.SyntaxKind.CommaToken, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseBraceToken]);
  const opens = new Set([ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.TemplateHead]);
  const closes = new Set([ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.TemplateTail]);
  const skipToTerminator = (): void => {
    let depth = 0;
    while (index < tokens.length && (depth > 0 || !terminators.has(peek()!))) {
      if (opens.has(peek()!)) depth++;
      else if (closes.has(peek()!)) depth--;
      index++;
    }
  };
  const expression = (): ts.Node => {
    let value = unary();
    while (peek() === ts.SyntaxKind.AsKeyword || peek() === ts.SyntaxKind.SatisfiesKeyword) {
      index++;
      skipToTerminator();
      value = node({ kind: ts.SyntaxKind.AsExpression, expression: value });
    }
    if (index < tokens.length && !terminators.has(peek()!)) {
      skipToTerminator();
      return unknown();
    }
    return value;
  };
  const unary = (): ts.Node => {
    const operator = peek();
    if (operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.TildeToken || operator === ts.SyntaxKind.ExclamationToken) {
      index++;
      return node({ kind: ts.SyntaxKind.PrefixUnaryExpression, operator, operand: unary() });
    }
    return primary();
  };
  const list = (close: ts.SyntaxKind, item: () => ts.Node): ts.Node[] => {
    const items: ts.Node[] = [];
    index++;
    while (index < tokens.length && peek() !== close) {
      items.push(item());
      if (peek() === ts.SyntaxKind.CommaToken) index++;
      else if (peek() !== close) { skipToTerminator(); if (peek() === ts.SyntaxKind.CommaToken) index++; }
    }
    index++;
    return items;
  };
  const property = (): ts.Node => {
    const name = tokens[index];
    if (name?.kind === ts.SyntaxKind.OpenBracketToken) {
      skipToTerminator();
      return unknown();
    }
    if (!name || !(name.kind === ts.SyntaxKind.Identifier || name.kind === ts.SyntaxKind.StringLiteral || name.kind === ts.SyntaxKind.NumericLiteral)
      || tokens[index + 1]?.kind !== ts.SyntaxKind.ColonToken) {
      skipToTerminator();
      return unknown();
    }
    index += 2;
    return node({ kind: ts.SyntaxKind.PropertyAssignment, name: node({ kind: name.kind, text: name.value, getText: () => name.text }), initializer: expression() });
  };
  const primary = (): ts.Node => {
    const token = tokens[index];
    switch (token?.kind) {
      case ts.SyntaxKind.OpenParenToken: {
        index++;
        const inner = expression();
        if (peek() !== ts.SyntaxKind.CloseParenToken) return unknown();
        index++;
        return node({ kind: ts.SyntaxKind.ParenthesizedExpression, expression: inner });
      }
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NumericLiteral:
        index++;
        return node({ kind: token.kind, text: token.value });
      case ts.SyntaxKind.Identifier:
      case ts.SyntaxKind.UndefinedKeyword:
        index++;
        return node({ kind: ts.SyntaxKind.Identifier, text: token.text });
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
      case ts.SyntaxKind.NullKeyword:
        index++;
        return node({ kind: token.kind });
      case ts.SyntaxKind.OpenBracketToken:
        return node({ kind: ts.SyntaxKind.ArrayLiteralExpression, elements: list(ts.SyntaxKind.CloseBracketToken, expression) });
      case ts.SyntaxKind.OpenBraceToken:
        return node({ kind: ts.SyntaxKind.ObjectLiteralExpression, properties: list(ts.SyntaxKind.CloseBraceToken, property) });
      default:
        skipToTerminator();
        return unknown();
    }
  };
  return expression();
}

function synthesisReason(type: Type, checker: Checker, node: ts.Node): string {
  if (type.flags & (TypeFlags.TypeParameter | TypeFlags.IndexedAccess)) return "generic return cannot be synthesized";
  const valueType = family(type, checker)?.args[0] ?? type;
  // Protocol properties are implementation details, not fields a caller can supply.
  const field = checker.getPropertiesOfType(valueType).find(field => /^[$\w]+$/.test(field.name)
    && !(field.flags & SymbolFlags.Optional) && !valuesOf(checker.getTypeOfSymbolAtLocation(field, node), checker, node).length);
  const symbol = valueType.getAliasSymbol() ?? valueType.getSymbol();
  const name = symbol && !symbol.name.startsWith("__") ? symbol.name
    : isUnion(valueType) ? "union" : valueType.flags & TypeFlags.Object || isIntersection(valueType) ? "object" : checker.typeToString(valueType, node);
  return field ? `return not synthesizable (field ${field.name})` : `return not synthesizable (type ${name})`;
}

function valueKey(text: string): string {
  const data = literalData(parseValue(text));
  return data === undefined ? text : JSON.stringify(data);
}

/** Finite literal sets are exhaustive up to eight; open/recursive shapes use six representatives.
 * Undefined is retained separately, so optional returns keep their absence path. */
function boundedValues(type: Type, checker: Checker, node: ts.Node): { values: Value[]; omitted: number; issues: string[] } {
  const issues = new Set<string>();
  return { ...boundCandidates(valuesOf(type, checker, node, new Set(), 0, issues), [type], node), issues: [...issues] };
}

function smallFinite(type: Type): boolean {
  const members = isUnion(type) ? type.getTypes() : [type];
  return members.length <= 4 && members.every(member => isLiteral(member)
    || !!(member.flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral | TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void)));
}

function boundCandidates(candidates: ReadonlyArray<Value>, types: ReadonlyArray<Type>, node: ts.Node): { values: Value[]; omitted: number } {
  const unique = [...new Map(candidates.map(value => [valueKey(value.text), value])).values()];
  const members = types.flatMap(type => isUnion(type) ? type.getTypes() : [type]);
  const finite = members.length <= 8 && members.every(member => isLiteral(member)
    || !!(member.flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral | TypeFlags.Null | TypeFlags.Undefined)));
  if (finite || unique.length <= 6) return { values: unique, omitted: 0 };
  const absence = unique.find(value => value.text === "undefined");
  const defined = unique.filter(value => value !== absence);
  const preferred = ["null", '\"\"', "0", "false", "[]", "({  })"].flatMap(text => {
    const candidate = defined.find(value => valueKey(value.text) === valueKey(text));
    return candidate ? [candidate] : [];
  });
  const original = returnedDiscriminants(node);
  const priority = defined.filter(candidate => objectDiscriminants(parseValue(candidate.text)).some(key => original.has(key)));
  const selected = [...new Set([...priority, ...preferred, ...defined])].slice(0, 6);
  if (absence) selected.push(absence);
  return { values: selected, omitted: unique.length - selected.length };
}

function objectDiscriminants(node: ts.Node): string[] {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  if (!ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap(field => {
    if (!ts.isPropertyAssignment(field) || ts.isComputedPropertyName(field.name)) return [];
    let value = field.initializer;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
    return ts.isStringLiteral(value) || ts.isNumericLiteral(value)
      ? [JSON.stringify([field.name.getText().replace(/^["']|["']$/g, ""), value.text])] : [];
  });
}

function returnedDiscriminants(node: ts.Node): Set<string> {
  if (!isFunction(node) || !node.body) return new Set();
  const result = new Set(objectDiscriminants(node.body));
  const visit = (child: ts.Node): void => {
    if (isFunction(child)) return;
    if (ts.isReturnStatement(child) && child.expression) for (const key of objectDiscriminants(child.expression)) result.add(key);
    child.forEachChild(visit);
  };
  visit(node.body);
  return result;
}

function shapeNotices(shape: ReturnShape, type: Type, checker: Checker, node: ts.Node): string[] {
  const notices: string[] = [...(shape.synthesisIssues ?? [])];
  const valueType = family(type, checker)?.args[0] ?? type;
  if ("values" in shape && shape.values.some(value => new TextEncoder().encode(value.text).byteLength > 2048)) notices.push("synthesized value exceeds 2048 bytes");
  const omitted = shape.omittedValues ?? 0;
  if (omitted) notices.push(`${omitted} more values not generated (representative cap)`);
  if ("errors" in shape) for (const error of shape.errors) {
    if (error.reason !== undefined) notices.push(`cannot construct ${error.tag}: ${error.reason}`);
    if (new TextEncoder().encode(error.text).byteLength > 2048) notices.push(`cannot construct ${error.tag}: synthesized value exceeds 2048 bytes`);
  }
  if ("values" in shape && !shape.values.length && !(valueType.flags & TypeFlags.Never) && shape.kind !== "Void") {
    notices.push(synthesisReason(type, checker, node));
  }
  return notices;
}

/** Bounded synthesis: cycles or unavailable required fields produce no fabricated value. */
function valuesOf(type: Type, checker: Checker, location: ts.Node, ancestors: ReadonlySet<number> = new Set(), depth = 0, issues = new Set<string>()): Value[] {
  if (depth > 4) { issues.add("synthesis depth limit (4) reached"); return []; }
  if (ancestors.has(type.id) || type.flags & TypeFlags.Never) return [];
  const values = synthesizeValues(type, checker, location, ancestors, depth, issues);
  const bounded = values.filter(value => new TextEncoder().encode(value.text).byteLength <= 2048);
  if (bounded.length !== values.length) issues.add("synthesized value exceeds 2048 bytes");
  return bounded;
}

function synthesizeValues(type: Type, checker: Checker, location: ts.Node, ancestors: ReadonlySet<number>, depth: number, issues: Set<string>): Value[] {
  const descend = (inner: Type): Value[] => valuesOf(inner, checker, location, new Set([...ancestors, type.id]), depth + 1, issues);
  const value = (text: string): Value => ({ text, synthetic: false });
  const detected = family(type, checker);
  if (detected && (detected.kind === "Option" || detected.kind === "Effect")) {
    const api = imports(location.getSourceFile());
    const inner = detected.args[0];
    const values = inner ? descend(inner) : [];
    const wrap = api(detected.kind, detected.kind === "Option" ? "some" : "succeed");
    const none = detected.kind === "Option" ? api("Option", "none") : undefined;
    return [
      ...(none ? [value(`${none}()`)] : []),
      ...(wrap ? values.map((v) => ({ text: `${wrap}(${v.text})`, synthetic: v.synthetic })) : []),
    ];
  }
  if (isIntersection(type)) {
    // Primitive brands need a cast. Structural intersections synthesize their required fields below.
    const primitive = type.getTypes().find(member => member.flags & (TypeFlags.String | TypeFlags.Number));
    const brand = type.getTypes().some(member => checker.getPropertiesOfType(member).some(prop => prop.name.includes("Brand")));
    if (primitive && brand) return descend(primitive).map(v => ({ ...v, text: `(${v.text} as ${returnTypeText(type, checker, location)})` }));
  }
  const symbol = type.getSymbol();
  if ((symbol?.name === "ReadonlySet" || symbol?.name === "Set" || symbol?.name === "ReadonlyMap" || symbol?.name === "Map")
    && symbol.declarations?.some(d => /\/lib\.es.*\.d\.ts$/.test(d.path))) {
    return [value(symbol.name.endsWith("Set") ? "new Set()" : "new Map()")];
  }
  if (isUnion(type)) {
    const members = [...type.getTypes()];
    // The checker can intern scalar unions in different orders across selections.
    // Tagged structural variants retain their declaration order for cap selection.
    if (members.every(member => isLiteral(member) || !!(member.flags & (TypeFlags.BooleanLiteral | TypeFlags.Null | TypeFlags.Undefined)))) {
      members.sort((a, b) => isNumberLiteral(a) && isNumberLiteral(b) ? a.value - b.value : checker.typeToString(a).localeCompare(checker.typeToString(b), "en"));
    }
    return members.flatMap(member => descend(member));
  }
  if (isStringLiteral(type)) return [value(JSON.stringify(type.value))];
  if (isNumberLiteral(type)) return [value(String(type.value))];
  if (type.flags & TypeFlags.BooleanLiteral) return [value(checker.typeToString(type))];
  if (type.flags & TypeFlags.Boolean) return [value("true"), value("false")];
  if (type.flags & TypeFlags.String) return [value('""'), value('"xyzzy"')];
  if (type.flags & TypeFlags.Number) return [value("0"), value("1"), value("-1")];
  if (type.flags & TypeFlags.BigInt) return [value("0n"), value("1n")];
  if (type.flags & TypeFlags.Null) return [value("null")];
  if (type.flags & (TypeFlags.Unknown | TypeFlags.Any)) return [value("undefined")];
  if (type.flags & (TypeFlags.Undefined | TypeFlags.Void)) return [value("undefined")];
  if (checker.isTupleType(type)) {
    const elements = checker.getTypeArguments(type as TypeReference).map((t) => descend(t)[0]);
    return elements.every((v) => v !== undefined) ? [value(`[${elements.map((v) => v.text).join(", ")}]`)] : [];
  }
  if (checker.isArrayType(type) || checker.isArrayLikeType(type)) {
    const element = checker.getIndexInfosOfType(type).find((info) => info.keyType.flags & TypeFlags.Number)?.valueType;
    const elements = element ? descend(element) : [];
    return [value("[]"), ...elements.map((v) => ({ text: `[${v.text}]`, synthetic: v.synthetic }))];
  }
  if ((type.flags & TypeFlags.Object || isIntersection(type)) && !checker.getSignaturesOfType(type, SignatureKind.Call).length && !checker.getSignaturesOfType(type, SignatureKind.Construct).length) {
    const fields: Array<{ name: string; values: Value[] }> = [];
    for (const prop of checker.getPropertiesOfType(type)) {
      if (prop.flags & SymbolFlags.Optional) continue;
      if (!/^[$\w]+$/.test(prop.name)) return [];
      const values = descend(checker.getTypeOfSymbolAtLocation(prop, location));
      if (!values.length) return [];
      fields.push({ name: prop.name, values });
    }
    const literalFields = fields.filter(field => {
      const prop = checker.getPropertyOfType(type, field.name);
      if (!prop) return false;
      const t = checker.getTypeOfSymbolAtLocation(prop, location);
      return (isUnion(t) ? t.getTypes() : [t]).every(member => isLiteral(member) || !!(member.flags & TypeFlags.BooleanLiteral));
    });
    const render = (changed?: typeof fields[number], replacement?: Value): Value | undefined => {
      const parts: string[] = [];
      let bytes = 6; // ({ ... }) delimiters
      for (const field of fields) {
        const v = (field === changed ? replacement! : field.values[0]!).text;
        const part = `${JSON.stringify(field.name)}: ${literalFields.includes(field) ? `(${v} as const)` : v}`;
        bytes += new TextEncoder().encode(part).byteLength + (parts.length ? 2 : 0);
        if (bytes > 2048) { issues.add("synthesized value exceeds 2048 bytes"); return undefined; }
        parts.push(part);
      }
      return value(`({ ${parts.join(", ")} })`);
    };
    const first = render();
    if (!first) return []; // Do not expand a wide object into thousands of oversized variants.
    const anonymous = !type.getAliasSymbol() && (!type.getSymbol() || ["__type", "__object"].includes(type.getSymbol()!.name));
    return [first, ...(anonymous ? literalFields.flatMap(field => field.values.slice(1).map(v => render(field, v))).filter(value => value !== undefined) : [])];
  }
  return [];
}
