export const actions = {
  'run-local-check': ({runNodeTest}) => runNodeTest('test/local.test.mjs', 'artifacts/test-result.json'),
  no_fit: async () => {},
};
