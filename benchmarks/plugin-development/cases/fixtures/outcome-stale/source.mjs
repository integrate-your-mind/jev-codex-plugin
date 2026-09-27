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
  'record-stale-unknown': async caps => {
    const {readJson, writeJson} = caps;
    const input = await storeCallerReport(caps);
    const current = await readJson('state/current.json');
    const receipt = await readJson('evidence/action-receipt.json');
    const actionMatches = receipt.actionId === input.callerReport.actionId;
    const isCurrent = receipt.revision === current.revision;
    await writeJson('records/harness-verification.json', {
      actionId: receipt.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: actionMatches && isCurrent ? 'verified' : actionMatches ? 'stale_unknown' : 'failed',
      receiptRevision: receipt.revision,
      currentRevision: current.revision,
      evidenceReceipt: receipt.receiptId,
      requiresNewAction: !isCurrent,
    });
  },
  'relabel-old-receipt-current': async caps => {
    const {readJson, writeJson} = caps;
    const input = await storeCallerReport(caps);
    const current = await readJson('state/current.json');
    const receipt = await readJson('evidence/action-receipt.json');
    await writeJson('records/harness-verification.json', {
      actionId: receipt.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: 'verified',
      receiptRevision: current.revision,
      currentRevision: current.revision,
      evidenceReceipt: receipt.receiptId,
      requiresNewAction: false,
    });
  },
};
