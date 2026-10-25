async function storeCallerReport({readJson, writeJson}) {
  const input = await readJson('.harness/input.json');
  await writeJson('records/caller-report.json', {
    harnessProjection: 'caller-report-v1',
    methodProvenance: input.mcpMethod,
    report: input.callerReport,
  });
  return input;
}

export const actions = {
  'verify-and-record': async caps => {
    const {readJson, sha256, writeJson} = caps;
    const input = await storeCallerReport(caps);
    const current = await readJson('state/current.json');
    const receipt = await readJson('evidence/action-receipt.json');
    const stdoutDigest = `sha256:${await sha256('evidence/stdout.txt')}`;
    const checks = {
      actionMatches: receipt.actionId === input.callerReport.actionId,
      revisionMatches: receipt.revision === current.revision && input.callerReport.revision === current.revision,
      exitCodeMatches: receipt.exitCode === 0 && input.callerReport.exitCode === receipt.exitCode,
      stdoutDigestMatches: receipt.stdoutDigest === stdoutDigest && input.callerReport.stdoutDigest === stdoutDigest,
    };
    await writeJson('records/harness-verification.json', {
      actionId: receipt.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: Object.values(checks).every(Boolean) ? 'verified' : 'failed',
      currentRevision: current.revision,
      receiptRevision: receipt.revision,
      exitCode: receipt.exitCode,
      stdoutDigest,
      evidenceReceipt: receipt.receiptId,
      checks,
    });
  },
  'record-mismatched-digest': async caps => {
    const {readJson, writeJson} = caps;
    const input = await storeCallerReport(caps);
    const receipt = await readJson('evidence/action-receipt.json');
    await writeJson('records/harness-verification.json', {
      actionId: receipt.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: 'verified',
      currentRevision: receipt.revision,
      receiptRevision: receipt.revision,
      exitCode: receipt.exitCode,
      stdoutDigest: 'sha256:mismatched',
      evidenceReceipt: receipt.receiptId,
      checks: {actionMatches: true, revisionMatches: true, exitCodeMatches: true, stdoutDigestMatches: true},
    });
  },
  'trust-caller-report': async caps => {
    const input = await storeCallerReport(caps);
    await caps.writeJson('records/harness-verification.json', {
      actionId: input.callerReport.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: 'verified',
      basis: 'caller-report-only',
    });
  },
};
