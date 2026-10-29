export type CapabilityEvidence = {
  status: 'verified' | 'unverified' | 'unsupported';
  evidence: string[];
};

export type DesktopQualification = {
  schemaVersion: 'desktop-qualification-v1';
  observedAt: string;
  host: {
    kind: 'codex-desktop';
    version: string;
    build: string;
    runtimeIdentity: CapabilityEvidence;
  };
  nativeRouting: {
    supportedOwningTransport: CapabilityEvidence;
    orderedPreDispatch: CapabilityEvidence;
    effectiveActuation: CapabilityEvidence;
  };
  baselineIsolation: Record<'tools' | 'hooks' | 'instructions' | 'candidatePacket' | 'transport', CapabilityEvidence>;
};

export function qualifyDesktop(receipt: DesktopQualification) {
  const missing = (prefix: string, checks: Record<string, CapabilityEvidence>) => Object.entries(checks)
    .filter(([, check]) => check.status !== 'verified' || check.evidence.length === 0)
    .map(([name]) => `${prefix}.${name}`);
  const identity = receipt.host.runtimeIdentity.status === 'verified' && receipt.host.runtimeIdentity.evidence.length > 0;
  const baselineMissing = missing('baselineIsolation', receipt.baselineIsolation);
  const routingMissing = missing('nativeRouting', receipt.nativeRouting);
  return {
    fixedProfileQualified: identity && baselineMissing.length === 0,
    nativeRoutingDelivered: identity && routingMissing.length === 0,
    fixedProfileDependencies: [...(identity ? [] : ['host.runtimeIdentity']), ...baselineMissing],
    nativeRoutingDependencies: [...(identity ? [] : ['host.runtimeIdentity']), ...routingMissing],
  };
}
