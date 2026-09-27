async function select({readJson, writeJson}, current) {
  const backends = await readJson('config/backends.json');
  const requirement = await readJson(current ? 'requirements/current.json' : 'requirements/prior.json');
  const eligible = backends.filter(backend => backend.healthy && (requirement.region === 'any' || backend.region === requirement.region) && backend.latencyMs <= requirement.maxLatencyMs);
  const selected = eligible.sort((left, right) => left.latencyMs - right.latencyMs).slice(0, 1).map(backend => backend.id);
  const rejected = backends.filter(backend => !selected.includes(backend.id)).map(backend => backend.id).sort();
  await writeJson('artifacts/selection.json', {requirementRevision: requirement.revision, selected, rejected});
}

export const actions = {
  'apply-latest-requirements': caps => select(caps, true),
  'apply-superseded-requirements': caps => select(caps, false),
  gather_evidence: ({writeJson}) => writeJson('artifacts/questions.json', {status: 'unnecessary_pause'}),
};
