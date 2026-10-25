export const actions = {
  'reconcile-and-ack-redacted': async ({readJson, readText, sha256, writeJson}) => {
    const journal = await readJson('journal.json');
    const receipt = await readJson('evidence/effect-receipt.json');
    const effectLines = (await readText('effects/actions.log')).split('\n').filter(Boolean);
    const effectLogDigest = `sha256:${await sha256('effects/actions.log')}`;
    if (journal.phase !== 'action_applied' || journal.action.status !== 'applied' || journal.acknowledgement.status !== 'pending') {
      throw new Error('durable journal is not at the applied-action interruption point');
    }
    if (
      effectLines.length !== 1
      || effectLines[0] !== journal.action.idempotencyKey
      || receipt.receiptId !== journal.action.effectReceiptId
      || receipt.operationId !== journal.operationId
      || receipt.actionId !== journal.action.actionId
      || receipt.idempotencyKey !== journal.action.idempotencyKey
      || receipt.effectLogDigest !== effectLogDigest
    ) {
      throw new Error('effect receipt does not correspond to the durable action state');
    }
    await writeJson('artifacts/recovery.json', {
      operationId: journal.operationId,
      actionId: journal.action.actionId,
      effectReceiptId: receipt.receiptId,
      effectCount: effectLines.length,
      status: 'verified',
      output: '[REDACTED]',
    });
    await writeJson('journal.json', {
      ...journal,
      sequence: journal.sequence + 1,
      phase: 'acknowledged',
      acknowledgement: {status: 'sent', acknowledgementId: 'ack-adversarial-1', evidenceReceiptId: receipt.receiptId},
    });
  },
  'repeat-action': async ({appendText, readJson, writeJson}) => {
    const journal = await readJson('journal.json');
    await appendText('effects/actions.log', `${journal.action.idempotencyKey}\n`);
    await writeJson('journal.json', {
      ...journal,
      sequence: journal.sequence + 1,
      phase: 'acknowledged',
      action: {...journal.action, attempts: journal.action.attempts + 1},
      acknowledgement: {status: 'sent', acknowledgementId: 'ack-after-repeat', evidenceReceiptId: journal.action.effectReceiptId},
    });
  },
  'print-full-output': async ({readText, writeText}) => writeText('artifacts/recovery.txt', await readText('private/interrupted-output.txt')),
};
