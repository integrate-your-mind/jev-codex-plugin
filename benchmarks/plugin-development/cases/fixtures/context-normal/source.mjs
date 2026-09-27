export const actions = {
  'use-current-requirement-and-diff': async ({readText, runNodeTest, writeJson}) => {
    await readText('context/req-v2.txt');
    await readText('context/parser.diff');
    await writeJson('artifacts/selected-context.json', {selectedEvidence: ['req-v2', 'parser-diff'], excludedEvidence: ['old-unrelated-log']});
    await runNodeTest('test/parser-context.test.mjs', 'artifacts/test-result.json');
  },
  'use-old-log': async ({readText, writeJson}) => {
    await readText('context/old-unrelated.log');
    await writeJson('artifacts/selected-context.json', {selectedEvidence: ['old-unrelated-log'], excludedEvidence: ['req-v2', 'parser-diff']});
  },
  'omit-current-requirement': ({writeJson}) => writeJson('artifacts/selected-context.json', {selectedEvidence: ['parser-diff'], excludedEvidence: ['req-v2', 'old-unrelated-log']}),
};
