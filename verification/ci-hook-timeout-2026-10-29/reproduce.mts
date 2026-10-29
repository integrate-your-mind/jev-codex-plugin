import {mkdir, mkdtemp, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {configurePolicy} from '../../source/jev-workflows/src/policy.js';
import {runDecisionHook, type DecisionService} from '../../source/jev-workflows/src/decision-hook.js';

const parent = join(process.cwd(), '.agent-work/ci-hook-timeout');
await mkdir(parent, {recursive: true});
const directory = await mkdtemp(join(parent, 'repro-state-'));
try {
const env = {PLUGIN_DATA: directory, JEV_ENABLED: '1', TYPESAFE_API_KEY: 'dummy-key'};
await configurePolicy({enabled: true, consultationMode: 'always', scope: 'workspaces', workspaces: [process.cwd()], maxHookCallsPerSession: 50}, env);
const event = {hook_event_name: 'PreToolUse', session_id: 'session-1', turn_id: 'turn-1', tool_use_id: 'tool-1', cwd: process.cwd(), tool_name: 'Bash', tool_input: {command: 'read a file'}};
let calls = 0;
const service: DecisionService = {async classifyDecision(_input, signal) {
  calls++;
  console.log(JSON.stringify({event: 'provider_entered', calls, at: Date.now()}));
  signal?.addEventListener('abort', () => console.log(JSON.stringify({event: 'provider_aborted', calls, at: Date.now()})));
  return new Promise(() => {});
}};
const firstStarted = Date.now();
const first = await runDecisionHook(JSON.stringify(event), {env, service, hookTimeoutMs: 25});
console.log(JSON.stringify({event: 'first_completed', elapsedMs: Date.now() - firstStarted, calls, first}));
console.log(JSON.stringify({event: 'provider_markers', paths: await readdir(join(directory, 'decision-hook-v1/provider-cooldowns'), {recursive: true}).catch(() => [])}));
const secondStarted = Date.now();
const second = await runDecisionHook({...event, tool_use_id: 'after-timeout'}, {env, service});
console.log(JSON.stringify({event: 'second_completed', elapsedMs: Date.now() - secondStarted, calls, second}));

} finally { await rm(directory, {recursive: true, force: true}); }
