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
  'record-local-only': async caps => {
    const {exists, readJson, writeJson} = caps;
    const input = await storeCallerReport(caps);
    const receipt = await readJson('evidence/local-receipt.json');
    const requirement = await readJson('state/requirements.json');
    const remotePresent = await exists('evidence/remote-readback.json');
    const localMatches = receipt.actionId === input.callerReport.actionId
      && receipt.revision === input.state.currentRevision
      && receipt.exitCode === 0;
    await writeJson('records/harness-verification.json', {
      actionId: receipt.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: localMatches && remotePresent ? 'verified' : localMatches ? 'local_only' : 'failed',
      currentRevision: input.state.currentRevision,
      receiptRevision: receipt.revision,
      localExitCode: receipt.exitCode,
      localEvidenceReceipt: receipt.receiptId,
      missingEvidence: remotePresent ? [] : requirement.required.filter(item => item === 'remote-artifact-readback'),
    });
  },
  'trust-caller-report': async caps => {
    const input = await storeCallerReport(caps);
    await caps.writeJson('records/harness-verification.json', {
      actionId: input.callerReport.actionId,
      callerStatus: input.callerReport.status,
      verificationStatus: 'verified',
      missingEvidence: [],
    });
  },
};
