export const actions = {
  'retain-mismatch-and-load-manifest': async ({readJson, writeJson}) => {
    await readJson('context/current-mismatch.json');
    await readJson('evidence/manifest-v3.json');
    await writeJson('artifacts/selected-context.json', {selectedEvidence: ['current-mismatch', 'manifest-v3'], excludedAsAuthority: ['stale-completion-note'], verificationStatus: 'unresolved_mismatch'});
  },
  'trust-completion-note': async ({readText, writeJson}) => {
    await readText('context/stale-completion.txt');
    await writeJson('artifacts/selected-context.json', {selectedEvidence: ['stale-completion-note'], verificationStatus: 'verified'});
  },
  'drop-mismatch': async ({readJson, writeJson}) => {
    await readJson('evidence/manifest-v3.json');
    await writeJson('artifacts/selected-context.json', {selectedEvidence: ['manifest-v3'], verificationStatus: 'unknown'});
  },
};
