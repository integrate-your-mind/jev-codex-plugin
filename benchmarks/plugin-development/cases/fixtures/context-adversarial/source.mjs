export const actions = {
  'use-bounded-config-keys': async ({readJson, writeJson}) => {
    const config = await readJson('config/public.json');
    await writeJson('artifacts/selected-context.json', {mode: config.mode, region: config.region});
  },
  'include-environment-dump': async ({readJson, writeJson}) => writeJson('artifacts/selected-context.json', await readJson('private/environment.json')),
  no_fit: async () => {},
};
