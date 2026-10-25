import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, resolve} from 'node:path';
import {buildGraph, cardOf, computeSourceIdentity} from './graph.js';
import {lexicalCandidates, pinnedJevEvaluator, Ranker, type EvaluateDecisions} from './rank.js';
import {PAGE_SIZE, SEARCH_POOL_SIZE, type Arm, type ExpandResult, type GraphEdge, type GraphNode, type GraphSnapshot, type PublicResult, type RankAudit, type ReadResult, type SearchResult, type TraceEvent} from './types.js';

declare const __PROJECT_GRAPH_ENGINE_VERSION__: string;
const ENGINE_VERSION = typeof __PROJECT_GRAPH_ENGINE_VERSION__ === 'string' ? __PROJECT_GRAPH_ENGINE_VERSION__ : 'source-development';

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseArm(value: string | undefined): Arm {
  if (value === 'graph' || value === 'cheap' || value === 'jev') return value;
  throw new Error('PROJECT_GRAPH_ARM must be graph, cheap, or jev');
}

function cursorEncode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function cursorDecode(value: string): {version: string; source: string; queryHash: string; orderHash: string; offset: number} {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.version !== 'string' || typeof parsed.source !== 'string' || typeof parsed.queryHash !== 'string' || typeof parsed.orderHash !== 'string' ||
      typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error();
    return parsed as ReturnType<typeof cursorDecode>;
  } catch {
    throw new Error('invalid cursor');
  }
}

class TraceWriter {
  readonly #path: string;
  constructor(stateDirectory: string) { this.#path = resolve(stateDirectory, 'trace.jsonl'); }
  async append(event: TraceEvent): Promise<void> {
    await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
    const handle = await open(this.#path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(event)}\n`); }
    finally { await handle.close(); }
  }
}

export type RuntimeOptions = {
  root: string;
  stateDirectory: string;
  arm: Arm;
  objective: string;
  evaluate?: EvaluateDecisions;
};

export class ProjectGraphRuntime {
  readonly #root: string;
  readonly #objective: string;
  readonly #ranker: Ranker;
  readonly #trace: TraceWriter;
  #snapshot?: GraphSnapshot;
  #visited = new Set<string>();
  #expansionOrders = new Map<string, {orderedNodeIds: string[]; requiredNodeIds: string[]; rankAudit: RankAudit}>();

  constructor(options: RuntimeOptions) {
    this.#root = options.root;
    this.#objective = options.objective;
    this.#ranker = new Ranker(options.arm, options.evaluate);
    this.#trace = new TraceWriter(options.stateDirectory);
  }

  static async fromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<ProjectGraphRuntime> {
    const rootValue = env.PROJECT_GRAPH_ROOT;
    const stateValue = env.PROJECT_GRAPH_STATE;
    if (!rootValue) throw new Error('PROJECT_GRAPH_ROOT is required');
    if (!stateValue) throw new Error('PROJECT_GRAPH_STATE is required');
    const root = await realpath(rootValue);
    const requestedState = resolve(stateValue);
    await mkdir(requestedState, {recursive: true, mode: 0o700});
    const stateInfo = await lstat(requestedState);
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error('PROJECT_GRAPH_STATE must be a real directory');
    const stateDirectory = await realpath(requestedState);
    if (stateDirectory === root || stateDirectory.startsWith(`${root}/`)) throw new Error('PROJECT_GRAPH_STATE must be outside PROJECT_GRAPH_ROOT');
    const arm = parseArm(env.PROJECT_GRAPH_ARM);
    let evaluate: EvaluateDecisions | undefined;
    if (arm === 'jev') {
      const jevStateValue = env.JEV_STATE_DIRECTORY;
      const credentialValue = env.JEV_API_KEY_FILE;
      if (!jevStateValue || !isAbsolute(jevStateValue)) throw new Error('JEV_STATE_DIRECTORY must be an absolute private directory for the jev arm');
      if (!credentialValue || !isAbsolute(credentialValue)) throw new Error('JEV_API_KEY_FILE must be an absolute private file for the jev arm');
      const jevRequested = resolve(jevStateValue);
      await mkdir(jevRequested, {recursive: true, mode: 0o700});
      const jevInfo = await lstat(jevRequested);
      if (!jevInfo.isDirectory() || jevInfo.isSymbolicLink()) throw new Error('JEV_STATE_DIRECTORY must be a real directory');
      const jevState = await realpath(jevRequested);
      if (jevState === root || jevState.startsWith(`${root}/`)) throw new Error('JEV_STATE_DIRECTORY must be outside PROJECT_GRAPH_ROOT');
      if (jevState === stateDirectory) throw new Error('JEV_STATE_DIRECTORY must be distinct from PROJECT_GRAPH_STATE');
      const credentialPath = await realpath(credentialValue);
      const credentialInfo = await lstat(credentialValue);
      if (!credentialInfo.isFile() || credentialInfo.isSymbolicLink()) throw new Error('JEV_API_KEY_FILE must be a real file');
      if (credentialPath === root || credentialPath.startsWith(`${root}/`)) throw new Error('JEV_API_KEY_FILE must be outside PROJECT_GRAPH_ROOT');
      evaluate = pinnedJevEvaluator({...env, JEV_STATE_DIRECTORY: jevState});
    }
    return new ProjectGraphRuntime({root, stateDirectory, arm, objective: env.PROJECT_GRAPH_OBJECTIVE ?? '', ...(evaluate ? {evaluate} : {})});
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<PublicResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('arguments must be an object');
    const object = input as Record<string, unknown>;
    if (object.operation === 'search') {
      this.#onlyKeys(object, ['operation', 'query']);
      if (typeof object.query !== 'string' || !object.query.trim() || object.query.length > 4000) throw new Error('search query must be a non-empty string up to 4000 characters');
      return this.search(object.query, signal);
    }
    if (object.operation === 'expand') {
      this.#onlyKeys(object, ['operation', 'nodeId', 'query', 'cursor']);
      if (typeof object.nodeId !== 'string') throw new Error('expand nodeId is required');
      if (object.nodeId.length > 200) throw new Error('expand nodeId is too long');
      if (object.query !== undefined && typeof object.query !== 'string') throw new Error('expand query must be a string');
      if (object.cursor !== undefined && typeof object.cursor !== 'string') throw new Error('expand cursor must be a string');
      if (typeof object.cursor === 'string' && object.cursor.length > 8192) throw new Error('expand cursor is too long');
      return this.expand(object.nodeId, object.query ?? '', object.cursor, signal);
    }
    if (object.operation === 'read') {
      this.#onlyKeys(object, ['operation', 'nodeId']);
      if (typeof object.nodeId !== 'string') throw new Error('read nodeId is required');
      if (object.nodeId.length > 200) throw new Error('read nodeId is too long');
      return this.read(object.nodeId);
    }
    throw new Error('operation must be search, expand, or read');
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    const started = process.hrtime.bigint();
    const graph = await this.#fresh();
    const candidates = lexicalCandidates(query, [...graph.nodes.values()], SEARCH_POOL_SIZE);
    const rank = await this.#ranker.rank(candidates, this.#rankContext('search', query, graph), signal);
    const nodes = rank.nodes.slice(0, PAGE_SIZE);
    nodes.forEach(node => this.#visited.add(node.nodeId));
    const packetHash = sha({graphVersion: graph.graphVersion, operation: 'search', query, nodeIds: nodes.map(node => node.nodeId)});
    await this.#trace.append(this.#event('rank', graph, packetHash, rank.audit.orderedNodeIds, started, rank.audit));
    const result: SearchResult = {operation: 'search', graphVersion: graph.graphVersion, packetHash, cards: nodes.map(cardOf)};
    await this.#trace.append(this.#event('search', graph, packetHash, nodes.map(node => node.nodeId), started, {queryHash: sha(query)}));
    return result;
  }

  async expand(nodeId: string, query = '', cursor?: string, signal?: AbortSignal): Promise<ExpandResult> {
    const started = process.hrtime.bigint();
    const graph = await this.#fresh();
    this.#requireNode(graph, nodeId);
    const requiredIds = new Set<string>();
    const optionalIds = new Set<string>();
    const edges = [...(graph.outbound.get(nodeId) ?? []), ...(graph.inbound.get(nodeId) ?? [])];
    for (const edge of edges) {
      const other = edge.from === nodeId ? edge.to : edge.from;
      if (edge.kind === 'imports' || edge.kind === 'contains') requiredIds.add(other);
      else optionalIds.add(other);
    }
    for (const id of requiredIds) optionalIds.delete(id);
    const expansionKey = `${graph.graphVersion}\0${nodeId}\0${query}`;
    let frozen = this.#expansionOrders.get(expansionKey);
    let rankedNow = false;
    if (!frozen) {
      const required = [...requiredIds].map(id => graph.nodes.get(id)!).sort((a, b) => this.#edgePriority(edges, nodeId, a.nodeId) - this.#edgePriority(edges, nodeId, b.nodeId) || a.nodeId.localeCompare(b.nodeId));
      const optional = [...optionalIds].map(id => graph.nodes.get(id)!);
      const rank = await this.#ranker.rank(optional, this.#rankContext('expand', query, graph, nodeId), signal);
      frozen = {orderedNodeIds: [...required, ...rank.nodes].map(node => node.nodeId), requiredNodeIds: required.map(node => node.nodeId), rankAudit: rank.audit};
      this.#expansionOrders.set(expansionKey, frozen);
      rankedNow = true;
    }
    const ordered = frozen.orderedNodeIds.map(id => graph.nodes.get(id)!);
    const orderHash = sha(ordered.map(node => node.nodeId));
    const queryHash = sha(query);
    let offset = 0;
    if (cursor) {
      const decoded = cursorDecode(cursor);
      if (decoded.version !== graph.graphVersion || decoded.source !== nodeId || decoded.queryHash !== queryHash || decoded.orderHash !== orderHash) throw new Error('stale or mismatched cursor');
      offset = decoded.offset;
    }
    const page = ordered.slice(offset, offset + PAGE_SIZE);
    page.forEach(node => this.#visited.add(node.nodeId));
    this.#visited.add(nodeId);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < ordered.length ? cursorEncode({version: graph.graphVersion, source: nodeId, queryHash, orderHash, offset: nextOffset}) : undefined;
    const packetHash = sha({graphVersion: graph.graphVersion, operation: 'expand', sourceNodeId: nodeId, query, offset, nodeIds: page.map(node => node.nodeId)});
    if (rankedNow) await this.#trace.append(this.#event('rank', graph, packetHash, frozen.rankAudit.orderedNodeIds, started, frozen.rankAudit));
    const result: ExpandResult = {operation: 'expand', graphVersion: graph.graphVersion, packetHash, sourceNodeId: nodeId, cards: page.map(cardOf), ...(nextCursor ? {nextCursor} : {})};
    await this.#trace.append(this.#event('expand', graph, packetHash, page.map(node => node.nodeId), started, {
      sourceNodeId: nodeId,
      queryHash,
      orderHash,
      offset,
      candidateNodeIds: [...frozen.requiredNodeIds, ...frozen.rankAudit.candidateNodeIds],
      requiredNodeIds: frozen.requiredNodeIds,
      orderedNodeIds: frozen.orderedNodeIds,
      pageNodeIds: page.map(node => node.nodeId),
      nextCursorPresent: Boolean(nextCursor),
    }));
    return result;
  }

  async read(nodeId: string): Promise<ReadResult> {
    const started = process.hrtime.bigint();
    const graph = await this.#fresh();
    const node = this.#requireNode(graph, nodeId);
    this.#visited.add(nodeId);
    const packetHash = sha({graphVersion: graph.graphVersion, operation: 'read', nodeId, contentHash: node.contentHash});
    const result: ReadResult = {operation: 'read', graphVersion: graph.graphVersion, packetHash, card: cardOf(node)};
    await this.#trace.append(this.#event('read', graph, packetHash, [nodeId], started));
    return result;
  }

  async recordToolOutput(result: PublicResult): Promise<void> {
    const nodeIds = result.operation === 'read' ? [result.card.nodeId] : result.cards.map(card => card.nodeId);
    const graph = this.#snapshot;
    if (!graph || graph.graphVersion !== result.graphVersion) return;
    await this.#trace.append(this.#event('tool_output', graph, result.packetHash, nodeIds, process.hrtime.bigint(), {operation: result.operation}));
  }

  async #fresh(): Promise<GraphSnapshot> {
    const started = process.hrtime.bigint();
    const identity = await computeSourceIdentity(this.#root);
    if (!this.#snapshot || this.#snapshot.graphVersion !== identity.version) {
      let snapshot: GraphSnapshot | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        snapshot = await buildGraph(identity.root);
        const verified = await computeSourceIdentity(identity.root);
        if (verified.version === snapshot.graphVersion) break;
        snapshot = undefined;
      }
      if (!snapshot) throw new Error('workspace changed continuously while building the graph');
      this.#snapshot = snapshot;
      this.#visited.clear();
      this.#expansionOrders.clear();
      const packetHash = sha({graphVersion: this.#snapshot.graphVersion, nodeIds: [...this.#snapshot.nodes.keys()], edges: this.#snapshot.edges});
      await this.#trace.append(this.#event('graph_built', this.#snapshot, packetHash, [...this.#snapshot.nodes.keys()], started, {
        sourceFiles: this.#snapshot.sourceFiles,
        edgeCount: this.#snapshot.edges.length,
        dependencies: this.#snapshot.dependencies,
      }));
    }
    return this.#snapshot;
  }

  #requireNode(graph: GraphSnapshot, nodeId: string): GraphNode {
    const node = graph.nodes.get(nodeId);
    if (!node) throw new Error('stale or unknown nodeId');
    return node;
  }

  #onlyKeys(object: Record<string, unknown>, allowed: string[]): void {
    const extras = Object.keys(object).filter(key => !allowed.includes(key));
    if (extras.length) throw new Error(`unexpected argument ${extras.sort()[0]}`);
  }

  #rankContext(operation: 'search' | 'expand', query: string, graph: GraphSnapshot, sourceNodeId?: string) {
    const packetSeed = sha({graphVersion: graph.graphVersion, operation, query, sourceNodeId: sourceNodeId ?? null, visited: [...this.#visited].sort()});
    return {operation, objective: this.#objective, query, ...(sourceNodeId ? {sourceNodeId} : {}), visitedNodeIds: [...this.#visited].sort(), graphVersion: graph.graphVersion, packetSeed};
  }

  #edgePriority(edges: GraphEdge[], source: string, target: string): number {
    const kinds = edges.filter(edge => (edge.from === source && edge.to === target) || (edge.from === target && edge.to === source)).map(edge => edge.kind);
    return kinds.includes('imports') ? 0 : kinds.includes('contains') ? 1 : kinds.includes('calls') ? 2 : 3;
  }

  #event(type: TraceEvent['type'], graph: GraphSnapshot, packetHash: string, nodeIds: string[], started: bigint, extra: Record<string, unknown> = {}): TraceEvent {
    const rankAudit = extra as {providerReceiptIds?: string[]};
    return {
      type,
      engineVersion: ENGINE_VERSION,
      atMonotonicNs: String(process.hrtime.bigint()),
      durationNs: String(process.hrtime.bigint() - started),
      graphVersion: graph.graphVersion,
      packetHash,
      nodeIds,
      providerReceiptIds: rankAudit.providerReceiptIds ?? [],
      ...extra,
    };
  }
}
