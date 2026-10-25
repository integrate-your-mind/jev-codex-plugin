export const actions = {
  'preserve-transport-unknown': async ({readJson, writeJson}) => {
    const journal = await readJson('journal.json');
    const provider = await readJson('state/provider.json');
    if (journal.phase !== 'send_uncertain' || journal.request.status !== 'send_attempted' || journal.response !== null) {
      throw new Error('durable journal is not at the send-uncertain interruption point');
    }
    if (provider.lookupAvailable || provider.transportStatus !== 'unknown') {
      throw new Error('fixture requires an unresolved transport lookup');
    }
    await writeJson('artifacts/recovery.json', {
      operationId: journal.operationId,
      requestId: journal.request.requestId,
      transportStatus: provider.transportStatus,
      responsePersisted: false,
      actionTaken: false,
    });
    await writeJson('journal.json', {
      ...journal,
      sequence: journal.sequence + 1,
      phase: 'transport_unknown',
      request: {...journal.request, status: 'unknown'},
    });
  },
  'replay-request': async ({appendText, readJson, writeJson}) => {
    const journal = await readJson('journal.json');
    await appendText('effects/provider-requests.log', `${journal.request.idempotencyKey}\n`);
    await writeJson('journal.json', {
      ...journal,
      sequence: journal.sequence + 1,
      phase: 'request_replayed',
      request: {...journal.request, status: 'response_persisted', attempts: journal.request.attempts + 1},
    });
  },
  'claim-success': async ({readJson, writeJson}) => {
    const journal = await readJson('journal.json');
    await writeJson('journal.json', {
      ...journal,
      sequence: journal.sequence + 1,
      phase: 'acknowledged',
      acknowledgement: {status: 'sent', acknowledgementId: 'unsupported-ack'},
    });
  },
};
