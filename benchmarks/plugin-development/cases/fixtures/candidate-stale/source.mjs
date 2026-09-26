export const actions = {
  'run-old-test': ({runNodeTest}) => runNodeTest('test/old-api.test.mjs', 'artifacts/old-test-result.json'),
  'run-new-test': ({runNodeTest}) => runNodeTest('test/new-api.test.mjs', 'artifacts/test-result.json'),
  no_fit: async () => {},
};
