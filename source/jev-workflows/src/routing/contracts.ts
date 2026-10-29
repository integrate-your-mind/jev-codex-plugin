export const ROUTING_SCHEMA_VERSION = 'routing-v1' as const;
export type RoutingScope = Readonly<{hostId: string; accountId: string; workspaceId: string; sessionId: string; agentId: string}>;
export type ModelEffortProfile = Readonly<{providerId: string; modelId: string; effort: string}>;
export type Retention = 'facts' | 'metadata' | 'pinned';
export interface RoutingRecord {
  readonly schemaVersion: typeof ROUTING_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: string;
  readonly scope: RoutingScope;
  readonly createdAt: string;
  readonly retention: Retention;
  readonly expiresAt?: string;
  readonly dependsOn?: readonly string[];
}
export interface HostCapabilities extends RoutingRecord {
  readonly kind: 'host_capabilities';
  readonly sourceRevision: string;
  readonly status: 'known' | 'unknown';
  readonly profileSwitch: 'supported' | 'unsupported' | 'unknown';
  readonly orderedPreDispatch: boolean;
  readonly eligibleProfiles: readonly ModelEffortProfile[];
  readonly inaccessibleCategories: readonly string[];
}
export interface CatalogEntry {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly available: boolean;
  readonly source: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}
export interface CatalogCoverage {
  readonly discovery: 'complete_supported_inventory' | 'partial';
  readonly pages: number;
  readonly inventoryCount: number;
  readonly inaccessibleCategories: readonly string[];
}
export interface CatalogSnapshot extends RoutingRecord {
  readonly kind: 'catalog_snapshot';
  readonly sourceRevision: string;
  readonly entries: readonly CatalogEntry[];
  readonly coverage: CatalogCoverage;
}
export interface TaskRevision extends RoutingRecord {
  readonly kind: 'task_revision';
  readonly revision: number;
  readonly factsRevision: string;
  readonly objective: string;
  readonly subtask: string;
  readonly sourceRevision: string;
  readonly evidenceRevision: string;
  readonly catalogId: string;
  readonly observedFailureIds: readonly string[];
  readonly pendingToolCycle: boolean;
  readonly completedSubtask: boolean;
  readonly unknowns: readonly string[];
  readonly pin?: ModelEffortProfile;
  readonly currentProfile?: ModelEffortProfile;
}
export interface DecisionProposal extends RoutingRecord {
  readonly kind: 'decision_proposal';
  readonly taskRevision: number;
  readonly factsRevision: string;
  readonly catalogId: string;
  readonly capabilityRevision: string;
  readonly recommendedProfile?: ModelEffortProfile;
  readonly targetIds: readonly string[];
  readonly disposition: 'selected' | 'tie' | 'abstained';
  readonly transition?: 'upshift' | 'downshift' | 'lateral';
  readonly providerReceiptId?: string;
  readonly providerReceiptIds?: readonly string[];
}
export interface DeliveryObservation extends RoutingRecord {
  readonly kind: 'delivery_observation';
  readonly proposalId: string;
  readonly deliveryId: string;
  readonly channel: string;
  readonly status: 'delivered' | 'failed' | 'unknown';
  readonly acknowledgedAt?: string;
}
export interface ApplyResult extends RoutingRecord {
  readonly kind: 'apply_result';
  readonly proposalId: string;
  readonly factsRevision: string;
  readonly status: 'applied' | 'preserved' | 'failed' | 'unknown';
  readonly profile?: ModelEffortProfile;
  readonly reason: string;
  readonly hostAcknowledgmentId?: string;
}
export interface ExecutionObservation extends RoutingRecord {
  readonly kind: 'execution_observation';
  readonly proposalId?: string;
  readonly applyResultId?: string;
  readonly requestId: string;
  readonly status: 'observed' | 'unknown';
  readonly actualProfile?: ModelEffortProfile;
  readonly evidenceIds: readonly string[];
}
export interface TaskOutcome extends RoutingRecord {
  readonly kind: 'task_outcome';
  readonly taskRevision: number;
  readonly executionIds: readonly string[];
  readonly status: 'verified_success' | 'verified_failure' | 'timeout' | 'infrastructure_invalid' | 'unknown';
  readonly graderId: string;
  readonly evidenceIds: readonly string[];
}
export type RoutingObservation = HostCapabilities | CatalogSnapshot | TaskRevision | DecisionProposal | DeliveryObservation | ApplyResult | ExecutionObservation | TaskOutcome;

export function sameScope(left: RoutingScope, right: RoutingScope): boolean {
  return left.hostId === right.hostId && left.accountId === right.accountId && left.workspaceId === right.workspaceId && left.sessionId === right.sessionId && left.agentId === right.agentId;
}
export function sameProfile(left: ModelEffortProfile | undefined, right: ModelEffortProfile | undefined): boolean {
  return left === right || !!left && !!right && left.providerId === right.providerId && left.modelId === right.modelId && left.effort === right.effort;
}
