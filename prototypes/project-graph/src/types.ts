export const GRAPH_SCHEMA_VERSION = 'project-graph-1';
export const PAGE_SIZE = 8;
export const SEARCH_POOL_SIZE = 48;

export type Arm = 'graph' | 'cheap' | 'jev';
export type NodeKind = 'file' | 'symbol';
export type EdgeKind = 'contains' | 'imports' | 'references' | 'calls';

export type SourceSpan = {start: number; end: number; line: number; column: number};

export type GraphNode = {
  key: string;
  nodeId: string;
  kind: NodeKind;
  path: string;
  name: string;
  symbolKind?: string;
  signature: string;
  excerpt: string;
  span: SourceSpan;
  contentHash: string;
};

export type GraphEdge = {
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: {path: string; start: number; end: number};
};

export type DependencyRecord = {
  path: string;
  specifier: string;
  status: 'external' | 'unresolved';
  start: number;
  end: number;
};

export type GraphSnapshot = {
  graphVersion: string;
  root: string;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  outbound: Map<string, GraphEdge[]>;
  inbound: Map<string, GraphEdge[]>;
  dependencies: DependencyRecord[];
  sourceFiles: string[];
};

export type NodeCard = {
  nodeId: string;
  kind: NodeKind;
  path: string;
  name: string;
  symbolKind?: string;
  signature: string;
  excerpt: string;
  contentHash: string;
  span: SourceSpan;
};

export type SearchResult = {
  operation: 'search';
  graphVersion: string;
  packetHash: string;
  cards: NodeCard[];
};

export type ExpandResult = {
  operation: 'expand';
  graphVersion: string;
  packetHash: string;
  sourceNodeId: string;
  cards: NodeCard[];
  nextCursor?: string;
};

export type ReadResult = {
  operation: 'read';
  graphVersion: string;
  packetHash: string;
  card: NodeCard;
};

export type PublicResult = SearchResult | ExpandResult | ReadResult;

export type RankContext = {
  operation: 'search' | 'expand';
  objective: string;
  query: string;
  sourceNodeId?: string;
  visitedNodeIds: string[];
  graphVersion: string;
  packetSeed: string;
};

export type JevAssessment = {
  status: string;
  reasonCode?: string;
  receiptId?: string;
  latencyMs?: number;
  model?: string;
  usage?: {input_tokens: number | null; output_tokens: number | null};
  transport?: {
    requestStartedAt?: string;
    fetchInvoked?: boolean;
    responseReceivedAt?: string | null;
    responseStatus?: number | null;
    validatedResponse?: boolean;
    providerRequestId?: string | null;
    providerRequestIdHeader?: string | null;
  };
  answers?: Record<string, {type: string; score?: number; disposition?: string}>;
};

export type RankAudit = {
  requestedArm: Arm;
  appliedArm: 'graph' | 'cheap' | 'jev';
  fallbackReason?: string;
  candidateNodeIds: string[];
  orderedNodeIds: string[];
  providerReceiptIds: string[];
  providerModel?: string;
  providerUsage: Array<{input_tokens: number | null; output_tokens: number | null}>;
  providerLatencyMs: number[];
  providerTransports: Array<{
    requestStartedAt?: string;
    fetchInvoked?: boolean;
    responseReceivedAt?: string | null;
    responseStatus?: number | null;
    validatedResponse?: boolean;
    providerRequestId?: string | null;
    providerRequestIdHeader?: string | null;
  }>;
  providerRankings: Array<{
    receiptId?: string;
    answers: Record<string, {providerChoice: string; probabilities: Record<string, number>}>;
  }>;
  durationNs: string;
};

export type TraceEvent = {
  type: 'graph_built' | 'search' | 'rank' | 'expand' | 'read' | 'tool_output';
  atMonotonicNs: string;
  durationNs: string;
  graphVersion: string;
  packetHash: string;
  nodeIds: string[];
  providerReceiptIds: string[];
  [key: string]: unknown;
};
