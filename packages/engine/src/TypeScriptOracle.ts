// Compiler-host boundary: TS requires synchronous native paths; matchesGlob has no Effect Path equivalent.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, resolve, relative, matchesGlob } from "node:path";
import ts from "typescript";
import { ProgramLoadError, type Mutant, type RunConfig, type Viability } from "@mutant-cafe/core";
import type { MutableFunction, ReturnShape, TaggedValue, TypeOracle, Value } from "./TypeOracle.ts";

type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
type Family = "Effect" | "Option" | "Stream" | "Layer";

const diagnosticsText = (items: ReadonlyArray<ts.Diagnostic>): string[] => items.map((d) => {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file || d.start === undefined) return `TS${d.code}: ${message}`;
  const position = d.file.getLineAndCharacterOfPosition(d.start);
  return `${d.file.fileName}:${position.line + 1}:${position.character + 1} TS${d.code}: ${message}`;
});

class ProgramSession {
  readonly host: ts.CompilerHost;
  readonly originals = new Map<string, ts.SourceFile>();
  program: ts.Program;
  overlay: { file: string; text: string } | undefined;

  readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new ProgramLoadError({ tsconfig: configPath, diagnostics: diagnosticsText([config.error]) });
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, ".."));
    if (parsed.errors.length) throw new ProgramLoadError({ tsconfig: configPath, diagnostics: diagnosticsText(parsed.errors) });
    this.host = ts.createCompilerHost(parsed.options, true);
    const read = this.host.getSourceFile;
    this.host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
      const absolute = resolve(file);
      if (this.overlay?.file === absolute) return ts.createSourceFile(file, this.overlay.text, languageVersion, true);
      const cached = this.originals.get(absolute);
      if (cached) return cached;
      const source = read(file, languageVersion, onError, shouldCreateNewSourceFile);
      if (source) this.originals.set(absolute, source);
      return source;
    };
    this.program = ts.createProgram(parsed.fileNames, parsed.options, this.host);
    const errors = [...this.program.getOptionsDiagnostics(), ...this.program.getSyntacticDiagnostics()];
    if (errors.length) throw new ProgramLoadError({ tsconfig: configPath, diagnostics: diagnosticsText(errors) });
  }

  check(mutant: Mutant): Viability {
    const file = resolve(mutant.file);
    const source = this.originals.get(file);
    if (!source) throw new ProgramLoadError({ tsconfig: this.configPath, diagnostics: [`File not loaded: ${mutant.file}`] });
    const { startOffset, endOffset, text } = mutant.replacement;
    if (startOffset < 0 || endOffset < startOffset || endOffset > source.text.length) {
      return { viable: false, diagnostics: ["Replacement offsets are outside the original file"] };
    }
    this.overlay = { file, text: source.text.slice(0, startOffset) + text + source.text.slice(endOffset) };
    try {
      const mutated = ts.createProgram({ rootNames: this.program.getRootFileNames(), options: this.program.getCompilerOptions(), host: this.host, oldProgram: this.program });
      const changed = mutated.getSourceFile(file);
      if (!changed) throw new Error(`Mutated source not found: ${file}`);
      const diagnostics = [...mutated.getSyntacticDiagnostics(changed), ...mutated.getSemanticDiagnostics(changed)];
      return { viable: diagnostics.length === 0, diagnostics: diagnosticsText(diagnostics) };
    } finally {
      this.overlay = undefined;
    }
  }
}

/** TS 6 is intentionally a runtime analysis dependency, not the workspace compiler. */
export function makeTypeScriptOracle(): TypeOracle {
  const sessions = new Map<string, ProgramSession>();
  const owners = new Map<string, ProgramSession>();
  return {
    *discover(config) {
      const configPath = resolve(config.root, config.tsconfig);
      let session = sessions.get(configPath);
      if (!session) {
        session = new ProgramSession(configPath);
        sessions.set(configPath, session);
      }
      const checker = session.program.getTypeChecker();
      for (const source of session.program.getSourceFiles()) {
        const file = resolve(source.fileName);
        const local = relative(config.root, file).replaceAll("\\", "/");
        // Test support lives beside the project, so judge it relative to the tsconfig.
        const project = relative(dirname(configPath), file).replaceAll("\\", "/");
        if (source.isDeclarationFile || local.startsWith("../") || /(?:^|\/)(?:node_modules|__tests__|__mocks__|tests?)\//.test(project) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(local)) continue;
        if (config.include.length && !config.include.some((glob) => matchesGlob(local, glob))) continue;
        if (config.exclude.some((glob) => matchesGlob(local, glob))) continue;
        owners.set(file, session);
        const api = imports(source);
        const visit = (node: ts.Node): void => {
          if (isFunction(node) && node.body && mutable(node, checker) && !skipped(node)) {
            const name = functionName(node);
            if (!config.functionFilter.length || config.functionFilter.some((filter) => matchesGlob(name, filter))) {
              const signature = checker.getSignatureFromDeclaration(node);
              if (signature) {
                const wrapped = wrappedEffect(node, checker);
                const type = wrapped ?? checker.getReturnTypeOfSignature(signature);
                const generator = wrapped && ts.isFunctionExpression(node) ? node : generatorBody(node, checker);
                const body = generator?.body ?? node.body;
                const start = body.getStart(source);
                const end = body.getEnd();
                const a = source.getLineAndCharacterOfPosition(start);
                const b = source.getLineAndCharacterOfPosition(end);
                found.push({
                  file, name, returnType: checker.typeToString(type, node, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.NoTruncation),
                  span: { start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 } },
                  startOffset: start, endOffset: end, original: body.getText(source),
                  literal: literalOfBody(body, checker),
                  block: ts.isBlock(body), generator: generator !== undefined,
                  shape: shapeOf(type, checker, node, body), api,
                });
              }
            }
            // Nested implementation callbacks are not separate exported functions.
            return;
          }
          ts.forEachChild(node, visit);
        };
        const found: MutableFunction[] = [];
        visit(source);
        yield* found;
      }
    },
    checkViable(mutant) {
      const session = owners.get(resolve(mutant.file));
      if (!session) throw new ProgramLoadError({ tsconfig: "", diagnostics: ["Generate mutants before checking viability"] });
      return session.check(mutant);
    },
  };
}

function isFunction(node: ts.Node): node is FunctionNode {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
}

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function mutable(node: FunctionNode, checker: ts.TypeChecker): boolean {
  if (ts.isMethodDeclaration(node)) return true;
  if (ts.isFunctionDeclaration(node)) return exported(node);
  const wrapper = wrappedEffect(node, checker);
  let current: ts.Node = node;
  if (wrapper) current = node.parent;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  if (!ts.isVariableDeclaration(current.parent) || current.parent.initializer !== current) return false;
  const statement = current.parent.parent.parent;
  return ts.isVariableStatement(statement) && exported(statement);
}

function skipped(node: FunctionNode): boolean {
  let current: ts.Node = node;
  while (!ts.isSourceFile(current)) {
    if (ts.getJSDocTags(current).some((tag) => tag.tagName.text === "mutants-skip")) return true;
    current = current.parent;
  }
  return false;
}

function functionName(node: FunctionNode): string {
  if (node.name) {
    if (ts.isMethodDeclaration(node) && ts.isClassLike(node.parent) && node.parent.name) return `${node.parent.name.text}.${node.name.getText()}`;
    return node.name.getText();
  }
  let current: ts.Node = node;
  while (!ts.isSourceFile(current)) {
    if (ts.isVariableDeclaration(current)) return current.name.getText();
    current = current.parent;
  }
  return "default";
}

function wrappedEffect(node: FunctionNode, checker: ts.TypeChecker): ts.Type | undefined {
  if (!ts.isFunctionExpression(node) || !node.asteriskToken || !ts.isCallExpression(node.parent)) return undefined;
  const result = checker.getTypeAtLocation(node.parent);
  if (family(result, checker)?.kind === "Effect") return result;
  const signature = result.getCallSignatures()[0];
  if (!signature) return undefined;
  const returned = checker.getReturnTypeOfSignature(signature);
  return family(returned, checker)?.kind === "Effect" ? returned : undefined;
}

function literalOfBody(body: ts.ConciseBody, checker: ts.TypeChecker): string | undefined {
  const first = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  const expression = ts.isBlock(body) ? first && ts.isReturnStatement(first) ? first.expression : undefined : body;
  if (!expression) return undefined;
  const type = checker.getTypeAtLocation(expression);
  return type.isStringLiteral() ? JSON.stringify(type.value) : type.isNumberLiteral() ? String(type.value) : undefined;
}

function generatorBody(node: FunctionNode, checker: ts.TypeChecker): ts.FunctionExpression | undefined {
  if (!node.body) return undefined;
  const expression = ts.isBlock(node.body)
    ? node.body.statements.length === 1 && ts.isReturnStatement(node.body.statements[0]!) ? node.body.statements[0]!.expression : undefined
    : node.body;
  // The return type identifies Effect; only select a direct generator callback of the wrapper.
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature || family(checker.getReturnTypeOfSignature(signature), checker)?.kind !== "Effect") return undefined;
  if (expression && ts.isCallExpression(expression)) {
    return expression.arguments.find((arg): arg is ts.FunctionExpression => ts.isFunctionExpression(arg) && arg.asteriskToken !== undefined);
  }
  return undefined;
}

function imports(source: ts.SourceFile): MutableFunction["api"] {
  const namespaces = new Map<string, string>();
  const named = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
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
    return namespace ? `${namespace}.${member}` : named.get(`${module}.${member}`);
  };
}

function family(type: ts.Type, checker: ts.TypeChecker): { kind: Family; args: ReadonlyArray<ts.Type> } | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const name = symbol?.getName();
  // Declaration provenance prevents a user-defined Effect-shaped name from being mistaken for Effect.
  const fromEffect = symbol?.declarations?.some((d) => /(?:^|\/)effect\/(?:.*\/)?(?:Effect|Option|Stream|Layer)\.(?:d\.)?ts$/.test(d.getSourceFile().fileName));
  if (fromEffect && (name === "Effect" || name === "Option" || name === "Stream" || name === "Layer")) {
    const args = type.aliasTypeArguments ?? ((type.flags & ts.TypeFlags.Object) && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type as ts.TypeReference) : []);
    return { kind: name, args };
  }
  // Type aliases may hide a referenced interface; union aliases retain their own type arguments.
  const direct = type.getSymbol();
  if (direct && direct !== symbol) {
    const name = direct.getName();
    if ((name === "Effect" || name === "Stream" || name === "Layer") && direct.declarations?.some((d) => d.getSourceFile().fileName.includes("/effect/"))) {
      return { kind: name, args: checker.getTypeArguments(type as ts.TypeReference) };
    }
  }
  if (type.isUnion()) {
    const members = type.types;
    const option = members.every((member) => {
      const symbol = member.getSymbol();
      return (symbol?.name === "Some" || symbol?.name === "None") && symbol.declarations?.some((d) => /\/effect\/.*Option\.(?:d\.)?ts$/.test(d.getSourceFile().fileName));
    });
    if (option && members[0]) {
      const first = members.find((m) => m.getSymbol()?.name === "Some") ?? members[0];
      return { kind: "Option", args: checker.getTypeArguments(first as ts.TypeReference) };
    }
  }
  if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) {
    for (const base of checker.getBaseTypes(type as ts.InterfaceType) ?? []) {
      const detected = family(base, checker);
      if (detected) return detected;
    }
  }
  return undefined;
}

function shapeOf(type: ts.Type, checker: ts.TypeChecker, node: FunctionNode, body: ts.ConciseBody): ReturnShape {
  const detected = family(type, checker);
  if (detected) {
    const [a, e] = detected.args;
    const values = a ? valuesOf(a, checker, node) : [];
    if (detected.kind === "Option") return { kind: "Option", values };
    const errors = e ? taggedValues(e, checker, node) : [];
    if (detected.kind === "Layer") {
      // A real service key, already present in the original body, is required by Layer.effect.
      let service: string | undefined;
      const find = (child: ts.Node): void => {
        if (!service && ts.isCallExpression(child) && child.arguments[0]) {
          const arg = child.arguments[0];
          const argType = checker.getTypeAtLocation(arg);
          if (argType.getProperty("Identifier") && argType.getProperty("Service")) service = arg.getText();
        }
        ts.forEachChild(child, find);
      };
      find(body);
      return { kind: "Layer", errors, service };
    }
    return { kind: detected.kind, values, errors };
  }
  if (type.flags & ts.TypeFlags.Void) return { kind: "Void", values: [] };
  const members = type.isUnion() ? type.types : [type];
  const boolean = members.every((t) => (t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0);
  const literal = members.every((t) => t.isLiteral());
  return { kind: boolean ? "Boolean" : literal ? "Literal" : "Value", values: valuesOf(type, checker, node) };
}

function taggedValues(type: ts.Type, checker: ts.TypeChecker, location: ts.Node): TaggedValue[] {
  return (type.isUnion() ? type.types : [type]).flatMap((member) => {
    const tag = member.getProperty("_tag");
    if (!tag) return [];
    const tagType = checker.getTypeOfSymbolAtLocation(tag, location);
    if (!tagType.isStringLiteral()) return [];
    const value = constructError(member, checker, location, tagType.value);
    return [{ ...value, tag: tagType.value }];
  });
}

function constructError(type: ts.Type, checker: ts.TypeChecker, location: ts.Node, tag: string): Value {
  const symbol = type.getSymbol();
  if (symbol) {
    const visible = checker.getSymbolsInScope(location, ts.SymbolFlags.Value).find((candidate) => {
      const target = candidate.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(candidate) : candidate;
      return target === symbol;
    });
    if (visible) {
      const constructor = checker.getTypeOfSymbolAtLocation(visible, location).getConstructSignatures()[0];
      if (constructor) {
        const param = constructor.parameters[0];
        if (!param) return { text: `new ${visible.name}()`, synthetic: false };
        const fields = checker.getTypeOfSymbolAtLocation(param, location);
        const value = valuesOf(fields, checker, location)[0];
        if (value && !value.synthetic) return { text: `new ${visible.name}(${value.text})`, synthetic: false };
      }
    }
  }
  return { text: `({ _tag: ${JSON.stringify(tag)} } as unknown as ${checker.typeToString(type, location, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope)})`, synthetic: true };
}

/** Bounded synthesis: cycles or unavailable required fields produce no fabricated value. */
function valuesOf(type: ts.Type, checker: ts.TypeChecker, location: ts.Node, depth = 0): Value[] {
  if (depth > 4 || type.flags & ts.TypeFlags.Never) return [];
  const value = (text: string): Value => ({ text, synthetic: false });
  const detected = family(type, checker);
  if (detected && (detected.kind === "Option" || detected.kind === "Effect")) {
    const api = imports(location.getSourceFile());
    const inner = detected.args[0];
    const values = inner ? valuesOf(inner, checker, location, depth + 1) : [];
    const wrap = api(detected.kind, detected.kind === "Option" ? "some" : "succeed");
    const none = detected.kind === "Option" ? api("Option", "none") : undefined;
    return [
      ...(none ? [value(`${none}()`)] : []),
      ...(wrap ? values.map((v) => ({ text: `${wrap}(${v.text})`, synthetic: v.synthetic })) : []),
    ];
  }
  if (type.isUnion()) return type.types.flatMap((member) => valuesOf(member, checker, location, depth + 1));
  if (type.isStringLiteral()) return [value(JSON.stringify(type.value))];
  if (type.isNumberLiteral()) return [value(String(type.value))];
  if (type.flags & ts.TypeFlags.BooleanLiteral) return [value(checker.typeToString(type))];
  if (type.flags & ts.TypeFlags.Boolean) return [value("true"), value("false")];
  if (type.flags & ts.TypeFlags.String) return [value('""'), value('"xyzzy"')];
  if (type.flags & ts.TypeFlags.Number) return [value("0"), value("1"), value("-1")];
  if (type.flags & ts.TypeFlags.BigInt) return [value("0n"), value("1n")];
  if (type.flags & ts.TypeFlags.Null) return [value("null")];
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return [value("undefined")];
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return [value("undefined")];
  if (checker.isTupleType(type)) {
    const elements = checker.getTypeArguments(type as ts.TypeReference).map((t) => valuesOf(t, checker, location, depth + 1)[0]);
    return elements.every((v) => v !== undefined) ? [value(`[${elements.map((v) => v.text).join(", ")}]`)] : [];
  }
  if (checker.isArrayType(type) || checker.isArrayLikeType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    const elements = element ? valuesOf(element, checker, location, depth + 1) : [];
    return [value("[]"), ...elements.map((v) => ({ text: `[${v.text}]`, synthetic: v.synthetic }))];
  }
  if (type.flags & ts.TypeFlags.Object && !type.getCallSignatures().length && !type.getConstructSignatures().length) {
    const fields: string[] = [];
    for (const prop of type.getProperties()) {
      if (prop.flags & ts.SymbolFlags.Optional) continue;
      if (!/^[$\w]+$/.test(prop.name)) return [];
      const first = valuesOf(checker.getTypeOfSymbolAtLocation(prop, location), checker, location, depth + 1)[0];
      if (!first) return [];
      fields.push(`${JSON.stringify(prop.name)}: ${first.text}`);
    }
    return [value(`{ ${fields.join(", ")} }`)];
  }
  return [];
}
