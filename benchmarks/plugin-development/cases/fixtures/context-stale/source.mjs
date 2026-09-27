export const actions = {
  'refresh-current-signature': async ({runNodeTest, writeJson}) => {
    await writeJson('artifacts/selected-context.json', {selectedEvidence: ['api-v2'], signature: 'formatRecord(name, value)'});
    await runNodeTest('test/current-api.test.mjs', 'artifacts/test-result.json');
  },
  'reuse-stale-context': async ({readText, writeJson}) => {
    const signature = (await readText('context/api-v1.txt')).trim();
    await writeJson('artifacts/selected-context.json', {selectedEvidence: ['api-v1'], signature});
  },
  'combine-conflicting-signatures': ({writeJson}) => writeJson('artifacts/selected-context.json', {selectedEvidence: ['api-v1', 'api-v2'], signatures: ['formatRecord(name)', 'formatRecord(name, value)']}),
};
