export const actions = {
  'run-focused-test': ({runNodeTest}) => runNodeTest('test/parser.test.mjs', 'artifacts/test-result.json'),
  'read-source': async ({readText, writeText}) => writeText('artifacts/inspection.txt', await readText('lib/parser.mjs')),
  no_fit: async () => {},
};
