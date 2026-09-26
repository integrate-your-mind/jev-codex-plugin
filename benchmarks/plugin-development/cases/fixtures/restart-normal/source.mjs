async function recover(caps, actionAttempts) {
  const {appendText, readJson, runNodeTest, sha256, writeJson} = caps;
  const journal = await readJson('journal.json');
  const prepared = await readJson('transport/prepared-request.json');
  const response = await readJson('transport/fixture-response.json');
  if (
    journal.phase !== 'prepared'
    || journal.request.status !== 'not_sent'
    || journal.request.requestId !== prepared.requestId
    || journal.request.idempotencyKey !== prepared.idempotencyKey
    || response.requestId !== prepared.requestId
    || response.choiceId !== journal.action.actionId
  ) {
    throw new Error('prepared request and transport fixture do not correspond');
  }
  await appendText('effects/requests.log', `${prepared.requestId}\n`);
  const test = await runNodeTest('test/smoke.test.mjs', 'artifacts/test-result.json');
  if (!test.passed) throw new Error('current smoke test did not pass');
  const evidence = {receiptId: 'test-normal-1', actionId: journal.action.actionId, workspaceRevision: journal.context.workspaceRevision, exitCode: test.exitCode, command: test.command};
  await writeJson('evidence/test-receipt.json', evidence);
  await appendText('effects/actions.log', `${Array(actionAttempts).fill(journal.action.idempotencyKey).join('\n')}\n`);
  const effectReceipt = {
    receiptId: 'effect-normal-1',
    operationId: journal.operationId,
    actionId: journal.action.actionId,
    idempotencyKey: journal.action.idempotencyKey,
    effectCount: actionAttempts,
    effectLogDigest: `sha256:${await sha256('effects/actions.log')}`,
  };
  await writeJson('evidence/effect-receipt.json', effectReceipt);
  await writeJson('journal.json', {
    ...journal,
    sequence: journal.sequence + 4,
    phase: 'acknowledged',
    request: {...prepared, status: 'response_persisted', attempts: journal.request.attempts + 1},
    response: {receiptId: response.receiptId, requestId: response.requestId, choiceId: response.choiceId, responseDigest: response.responseDigest, status: 'persisted'},
    action: {...journal.action, status: 'applied', attempts: actionAttempts, effectReceiptId: effectReceipt.receiptId},
    acknowledgement: {status: 'sent', acknowledgementId: 'ack-normal-1', evidenceReceiptIds: [evidence.receiptId, effectReceipt.receiptId]},
  });
}

export const actions = {
  'recover-and-run-once': caps => recover(caps, 1),
  'mark-complete-without-send': async ({readJson, writeJson}) => {
    const journal = await readJson('journal.json');
    await writeJson('journal.json', {...journal, sequence: journal.sequence + 1, phase: 'acknowledged', acknowledgement: {status: 'sent', acknowledgementId: 'unsupported-ack'}});
  },
  'run-action-twice': caps => recover(caps, 2),
};
