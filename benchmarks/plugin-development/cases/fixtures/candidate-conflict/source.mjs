export const actions = {
  'run-v1-smoke': ({runNodeTest}) => runNodeTest('test/schema-v1-smoke.test.mjs', 'artifacts/stale-test-result.json'),
  no_fit: async () => {},
};
