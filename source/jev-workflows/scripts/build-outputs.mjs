export const entryPoints = {
  server: 'src/server.ts',
  hook: 'src/hook.ts',
  'decision-hook': 'src/decision-hook-entry.ts',
  'claude-hook': 'src/claude-hook.ts',
  'claude-mod': 'src/hosts/claude/mod.ts',
  cli: 'src/cli.ts',
};

export const standaloneSkills = ['classify-decision', 'diagnose-failure', 'check-completion'];
