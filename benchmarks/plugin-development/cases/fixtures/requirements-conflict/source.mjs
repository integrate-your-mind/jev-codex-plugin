async function implement({readJson, writeJson}, maxAttempts) {
  const requirement = await readJson('requirements/current.json');
  await writeJson('config/retry-policy.json', {statuses: requirement.statuses, maxAttempts});
  await writeJson('artifacts/implementation.json', {requirementRevision: requirement.revision, maxAttempts});
}

export const actions = {
  gather_evidence: async ({readJson, writeJson}) => {
    const requirement = await readJson('requirements/current.json');
    await writeJson('artifacts/missing-requirement.json', {requirementRevision: requirement.revision, field: 'maxAttempts', status: 'unresolved'});
  },
  'implement-default-three': caps => implement(caps, 3),
  'implement-unbounded': caps => implement(caps, null),
};
