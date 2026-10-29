import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qualifyDesktop, type DesktopQualification} from '../src/hosts/codex/qualification.js';

const verified = () => ({status: 'verified' as const, evidence: ['synthetic-fixture-only']});
const fixture = (): DesktopQualification => ({
  schemaVersion: 'desktop-qualification-v1', observedAt: '2026-10-28T00:00:00Z',
  host: {kind: 'codex-desktop', version: 'synthetic', build: 'synthetic', runtimeIdentity: verified()},
  nativeRouting: {
    supportedOwningTransport: {status: 'unsupported', evidence: ['synthetic-fixture-only']},
    orderedPreDispatch: {status: 'unverified', evidence: []},
    effectiveActuation: {status: 'unverified', evidence: []},
  },
  baselineIsolation: {tools: verified(), hooks: verified(), instructions: verified(), candidatePacket: verified(), transport: verified()},
});

test('fixed-profile qualification does not require native model actuation', () => {
  const result = qualifyDesktop(fixture());
  assert.equal(result.fixedProfileQualified, true);
  assert.equal(result.nativeRoutingDelivered, false);
});

test('disabled calls cannot stand in for instruction isolation or evidence', () => {
  const receipt = fixture();
  receipt.baselineIsolation.instructions = {status: 'unverified', evidence: ['plugin calls disabled']};
  receipt.baselineIsolation.tools = {status: 'verified', evidence: []};
  assert.deepEqual(qualifyDesktop(receipt).fixedProfileDependencies, ['baselineIsolation.tools', 'baselineIsolation.instructions']);
});
