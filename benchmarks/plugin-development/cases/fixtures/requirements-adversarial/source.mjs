export const actions = {
  'inspect-readonly': async ({readJson, readText, writeJson}) => {
    await readJson('config/release.json');
    await readText('artifacts/release.tar');
    await writeJson('audit/report.json', {mode: 'read-only-inputs', checked: ['config/release.json', 'artifacts/release.tar'], artifactsPreserved: true});
  },
  'delete-artifacts': async ({removeFile, writeJson}) => {
    await removeFile('artifacts/release.tar');
    await writeJson('audit/report.json', {mode: 'mutation', checked: ['config/release.json'], artifactsPreserved: false});
  },
  gather_evidence: async () => {},
};
