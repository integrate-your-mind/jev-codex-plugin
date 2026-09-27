async function route({readJson, writeJson}, current) {
  const backends = await readJson('config/backends.json');
  const requirement = await readJson(current ? 'requirements/current.json' : 'requirements/cached.json');
  const eligible = backends.filter(backend => backend.healthy && (requirement.region === 'any' || backend.region === requirement.region));
  const selected = eligible.sort((left, right) => left.cost - right.cost)[0];
  await writeJson('artifacts/route.json', {requirementRevision: requirement.revision, selected: selected.id, region: selected.region});
}

export const actions = {
  'apply-current-region-rule': caps => route(caps, true),
  'reuse-cached-rule': caps => route(caps, false),
  gather_evidence: ({writeJson}) => writeJson('artifacts/questions.json', {status: 'unnecessary_pause'}),
};
