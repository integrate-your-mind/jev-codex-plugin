import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, realpath} from 'node:fs/promises';
import {extname, isAbsolute, relative, resolve, sep} from 'node:path';
import ts from 'typescript';
import {GRAPH_SCHEMA_VERSION, type DependencyRecord, type EdgeKind, type GraphEdge, type GraphNode, type GraphSnapshot, type NodeCard} from './types.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function sourcePaths(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) result.push(path);
    }
  }
  await visit(root);
  return result;
}

function declarationName(node: ts.Node): ts.Node | undefined {
  if ('name' in node) {
    const name = (node as ts.NamedDeclaration).name;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) return name;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name;
  return undefined;
}

function isSymbolDeclaration(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node) ||
    ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);
}

function symbolKind(node: ts.Node): string {
  return ts.SyntaxKind[node.kind] ?? 'Unknown';
}

function lineAndColumn(source: ts.SourceFile, start: number): {line: number; column: number} {
  const value = source.getLineAndCharacterOfPosition(start);
  return {line: value.line + 1, column: value.character + 1};
}

function excerpt(text: string, start: number, end: number, limit = 1200): string {
  const selected = text.slice(start, Math.min(text.length, Math.max(end, start + 1)));
  if (selected.length <= limit) return selected;
  return `${selected.slice(0, limit)}\n…`;
}

function signature(node: ts.Node, source: ts.SourceFile): string {
  const text = node.getText(source).replace(/\s+/g, ' ').trim();
  const body = text.search(/[={]/);
  return (body >= 0 ? text.slice(0, body).trim() : text).slice(0, 320);
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
    try { symbol = checker.getAliasedSymbol(symbol); } catch { return undefined; }
  }
  return symbol;
}

function canonicalDeclaration(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
  if (!symbol) return undefined;
  return symbol.valueDeclaration ?? symbol.declarations?.find(d => isSymbolDeclaration(d)) ?? symbol.declarations?.[0];
}

function containingOwner(node: ts.Node, nodeByDeclaration: Map<ts.Node, string>, fileKey: string): string {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    const key = nodeByDeclaration.get(cursor);
    if (key) return key;
  }
  return fileKey;
}

function addEdge(edges: GraphEdge[], seen: Set<string>, from: string, to: string, kind: EdgeKind, source: ts.SourceFile, node: ts.Node): void {
  if (from === to && kind !== 'contains') return;
  const key = `${from}\0${to}\0${kind}\0${source.fileName}\0${node.getStart(source)}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({from, to, kind, provenance: {path: source.fileName, start: node.getStart(source), end: node.getEnd()}});
}

export async function computeSourceIdentity(rootInput: string): Promise<{root: string; paths: string[]; version: string; texts: Map<string, string>}> {
  const root = await realpath(rootInput);
  const stat = await lstat(root);
  if (!stat.isDirectory()) throw new Error('PROJECT_GRAPH_ROOT must be a directory');
  const paths = await sourcePaths(root);
  const texts = new Map<string, string>();
  const parts = [GRAPH_SCHEMA_VERSION];
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    texts.set(path, text);
    parts.push(normalizedPath(root, path), hash(text));
  }
  return {root, paths, version: hash(parts.join('\0')), texts};
}

export async function buildGraph(rootInput: string): Promise<GraphSnapshot> {
  const identity = await computeSourceIdentity(rootInput);
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    noEmit: true,
  };
  const program = ts.createProgram(identity.paths, compilerOptions);
  const checker = program.getTypeChecker();
  const rawNodes = new Map<string, Omit<GraphNode, 'nodeId'>>();
  const nodeByDeclaration = new Map<ts.Node, string>();
  const fileKeys = new Map<string, string>();

  for (const path of identity.paths) {
    const source = program.getSourceFile(path);
    if (!source) continue;
    const rel = normalizedPath(identity.root, path);
    const fileKey = `file:${rel}`;
    fileKeys.set(resolve(path), fileKey);
    const lc = lineAndColumn(source, 0);
    rawNodes.set(fileKey, {
      key: fileKey, kind: 'file', path: rel, name: rel, signature: `file ${rel}`,
      excerpt: excerpt(source.text, 0, Math.min(source.text.length, 1200)),
      span: {start: 0, end: source.text.length, ...lc}, contentHash: hash(source.text),
    });
    const visit = (node: ts.Node): void => {
      if (isSymbolDeclaration(node)) {
        const nameNode = declarationName(node);
        const name = nameNode?.getText(source) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : undefined);
        if (name) {
          const start = node.getStart(source);
          const end = node.getEnd();
          const key = `symbol:${rel}:${start}:${end}:${name}`;
          const lc2 = lineAndColumn(source, start);
          rawNodes.set(key, {
            key, kind: 'symbol', path: rel, name, symbolKind: symbolKind(node), signature: signature(node, source),
            excerpt: excerpt(source.text, start, end), span: {start, end, ...lc2}, contentHash: hash(source.text.slice(start, end)),
          });
          nodeByDeclaration.set(node, key);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const versionPrefix = identity.version.slice(0, 16);
  const nodes = new Map<string, GraphNode>();
  const idByKey = new Map<string, string>();
  for (const [key, node] of [...rawNodes].sort(([a], [b]) => a.localeCompare(b))) {
    const nodeId = `pg:${versionPrefix}:${node.kind === 'file' ? 'f' : 's'}:${hash(key).slice(0, 20)}`;
    nodes.set(nodeId, {...node, nodeId});
    idByKey.set(key, nodeId);
  }

  const edges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();
  const dependencies: DependencyRecord[] = [];
  for (const path of identity.paths) {
    const source = program.getSourceFile(path);
    if (!source) continue;
    const fileKey = fileKeys.get(resolve(path));
    const fileId = fileKey ? idByKey.get(fileKey) : undefined;
    if (!fileId) continue;
    for (const [declaration, key] of nodeByDeclaration) {
      if (declaration.getSourceFile() === source) addEdge(edges, edgeSeen, fileId, idByKey.get(key)!, 'contains', source, declaration);
    }
    const visit = (node: ts.Node): void => {
      let specifier: ts.StringLiteralLike | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifier = node.moduleSpecifier;
      else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) specifier = node.arguments[0] as ts.StringLiteralLike;
      if (specifier) {
        const resolved = ts.resolveModuleName(specifier.text, path, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
        const normalizedResolved = resolved ? resolve(resolved.replace(/\.d\.ts$/, '.ts')) : undefined;
        const targetKey = normalizedResolved ? fileKeys.get(normalizedResolved) ?? fileKeys.get(resolve(resolved!)) : undefined;
        const targetId = targetKey ? idByKey.get(targetKey) : undefined;
        if (targetId) addEdge(edges, edgeSeen, fileId, targetId, 'imports', source, specifier);
        else dependencies.push({path: normalizedPath(identity.root, path), specifier: specifier.text, status: resolved && !inside(identity.root, resolve(resolved)) ? 'external' : 'unresolved', start: specifier.getStart(source), end: specifier.getEnd()});
      }
      if (ts.isIdentifier(node) && node.parent) {
        const declaration = canonicalDeclaration(resolvedSymbol(checker, node));
        const targetKey = declaration ? nodeByDeclaration.get(declaration) : undefined;
        const targetId = targetKey ? idByKey.get(targetKey) : undefined;
        if (targetId && declaration !== node.parent && declaration !== node) {
          const ownerKey = containingOwner(node.parent, nodeByDeclaration, fileKey!);
          const ownerId = idByKey.get(ownerKey);
          if (ownerId) addEdge(edges, edgeSeen, ownerId, targetId, 'references', source, node);
        }
      }
      if (ts.isCallExpression(node)) {
        const lookup = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const declaration = canonicalDeclaration(resolvedSymbol(checker, lookup));
        const targetKey = declaration ? nodeByDeclaration.get(declaration) : undefined;
        const targetId = targetKey ? idByKey.get(targetKey) : undefined;
        const ownerId = idByKey.get(containingOwner(node.parent, nodeByDeclaration, fileKey!));
        if (ownerId && targetId) addEdge(edges, edgeSeen, ownerId, targetId, 'calls', source, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  for (const edge of edges) edge.provenance.path = normalizedPath(identity.root, edge.provenance.path);
  edges.sort((a, b) => `${a.from}\0${a.kind}\0${a.to}\0${a.provenance.start}`.localeCompare(`${b.from}\0${b.kind}\0${b.to}\0${b.provenance.start}`));
  dependencies.sort((a, b) => `${a.path}\0${a.start}`.localeCompare(`${b.path}\0${b.start}`));
  const outbound = new Map<string, GraphEdge[]>();
  const inbound = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const out = outbound.get(edge.from) ?? [];
    out.push(edge);
    outbound.set(edge.from, out);
    const incoming = inbound.get(edge.to) ?? [];
    incoming.push(edge);
    inbound.set(edge.to, incoming);
  }
  return {graphVersion: identity.version, root: identity.root, nodes, edges, outbound, inbound, dependencies, sourceFiles: identity.paths.map(path => normalizedPath(identity.root, path))};
}

export function cardOf(node: GraphNode): NodeCard {
  const {key: _key, ...card} = node;
  return card;
}
