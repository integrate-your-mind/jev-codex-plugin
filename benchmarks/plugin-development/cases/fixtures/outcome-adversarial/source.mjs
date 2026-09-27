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
  'record-failure': async caps => {
    const {readJson, writeJson} = caps;
    const input = await storeCallerReport(caps);
    const current = await readJson('state/current.json');
    const receipt = await readJson('evidence/action-receipt.json');
    const evidenceMatches = receipt.actionId === input.callerReport.actionId && receipt.revision === current.revision;
    await writeJson('records/harness-verification.json', {
      actionId: receipt.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: evidenceMatches && receipt.exitCode === 0 ? 'verified' : 'failed',
      currentRevision: current.revision,
      receiptRevision: receipt.revision,
      exitCode: receipt.exitCode,
      evidenceReceipt: receipt.receiptId,
    });
  },
  'trust-caller-report': async caps => {
    const input = await storeCallerReport(caps);
    await caps.writeJson('records/harness-verification.json', {
      actionId: input.callerReport.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: 'verified',
      currentRevision: input.state.currentRevision,
      receiptRevision: input.state.currentRevision,
      exitCode: 0,
      evidenceReceipt: null,
    });
  },
};
