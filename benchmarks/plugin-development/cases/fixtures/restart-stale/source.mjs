export const actions = {
  'invalidate-and-build-current': async ({appendText, readJson, runNodeTest, sha256, writeJson}) => {
    const journal = await readJson('journal.json');
    const current = await readJson('state/current.json');
    if (journal.phase !== 'decision_persisted' || journal.response?.status !== 'persisted' || journal.action.status !== 'not_started') {
      throw new Error('durable journal is not at the persisted-decision interruption point');
    }
    if (
      journal.context.workspaceRevision === current.workspaceRevision
      || journal.context.requirementsRevision === current.requirementsRevision
      || journal.context.catalogRevision === current.catalogRevision
    ) {
      throw new Error('fixture requires workspace, requirements, and catalog to have changed');
    }
    const build = await runNodeTest('test/current-build.test.mjs', 'artifacts/current-build.json');
    if (!build.passed) throw new Error('current build verification failed');
    const successorOperationId = `${journal.operationId}-current`;
    const successorActionId = `build:${current.workspaceRevision}:${current.requirementsRevision}:${current.catalogRevision}`;
    const successorIdempotencyKey = `action:${current.workspaceRevision}:${current.requirementsRevision}:${current.catalogRevision}`;
    const effect = {
      operationId: successorOperationId,
      actionId: successorActionId,
      idempotencyKey: successorIdempotencyKey,
      workspaceRevision: current.workspaceRevision,
      requirementsRevision: current.requirementsRevision,
      catalogRevision: current.catalogRevision,
    };
    await appendText('effects/current-actions.log', `${JSON.stringify(effect)}\n`);
    const effectReceipt = {
      receiptId: `effect-${current.workspaceRevision}-${current.requirementsRevision}-${current.catalogRevision}`,
      ...effect,
      effectLogDigest: `sha256:${await sha256('effects/current-actions.log')}`,
      verificationReceipt: 'artifacts/current-build.json',
    };
    await writeJson('evidence/successor-effect-receipt.json', effectReceipt);
    await writeJson('artifacts/recovery.json', {
      priorOperationId: journal.operationId,
      disposition: 'stale',
      currentWorkspaceRevision: current.workspaceRevision,
      currentRequirementsRevision: current.requirementsRevision,
      currentCatalogRevision: current.catalogRevision,
      successorOperationId,
      successorActionId,
      successorEffectReceiptId: effectReceipt.receiptId,
    });
    await writeJson('journal.json', {
      ...journal,
      sequence: journal.sequence + 1,
      phase: 'decision_stale',
      response: {...journal.response, status: 'stale'},
      staleReason: 'workspace_requirements_and_catalog_changed',
      successorOperationId,
      successor: {
        operationId: successorOperationId,
        actionId: successorActionId,
        idempotencyKey: successorIdempotencyKey,
        effectReceiptId: effectReceipt.receiptId,
        status: 'applied',
      },
    });
  },
  'apply-persisted-stale-action': async ({appendText, readJson, writeJson}) => {
    const journal = await readJson('journal.json');
    await appendText('effects/stale-actions.log', 'apply-rev-17\n');
    await writeJson('artifacts/applied.json', {workspaceRevision: 'rev-18', appliedDecisionRevision: 'rev-17'});
    await writeJson('journal.json', {
      ...journal,
      sequence: journal.sequence + 1,
      phase: 'action_applied',
      action: {...journal.action, status: 'applied', attempts: journal.action.attempts + 1},
    });
  },
  'reuse-cached-success': async ({readJson, writeJson}) => {
    const journal = await readJson('journal.json');
    await writeJson('journal.json', {
      ...journal,
      sequence: journal.sequence + 1,
      phase: 'acknowledged',
      acknowledgement: {status: 'sent', acknowledgementId: 'stale-ack'},
    });
  },
};
