import {CausalBridge, CONFIG_FILE, MAX_RECORD_BYTES, agentKey, parseConfig, parseRecord, recordPath, type Inference} from './bridge.js';
import type {Register} from 'claude-code';

type Origin = {plugin: string; tier: string};
type Stat = {kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean; realPath?: string};
export type API = {plugin: {root: string}; fs: {read(path: string): Promise<string>; stat(path: string, options: {resolve: true}): Promise<Stat>}; session: {id(): Promise<string>; cwd(): Promise<string>}};
type Next<E, R> = ((event: E) => Promise<R>) & {signal: AbortSignal; origin: Origin};
type Chunk = {kind: string; id?: string; [key: string]: unknown};
export type Step = Inference & {messageCount: number};
export type StreamNext = ((event: Step) => AsyncGenerator<Chunk, unknown, unknown>) & {signal: AbortSignal; origin: Origin};
type Tool = {tool: string; tool_use_id: string; agentId?: string; [key: string]: unknown};

const ordinary = (origin: Origin): boolean => origin.plugin === 'engine' && origin.tier === 'core';
const sameFile = (s: Stat, path: string): boolean => s.kind === 'file' && !s.isLink && s.realPath === path && s.size > 0 && s.size <= MAX_RECORD_BYTES;

export function register(on: Parameters<Register>[0], _options: Parameters<Register>[1]): void {
  const bridge = new CausalBridge();

  on('prompt.submit', async ($, e, next) => {
    bridge.invalidate();
    return await next(e);
  });

  on('tool.call', async ($, e, next) => {
    try { return await next(e); }
    finally {
      if (ordinary(next.origin)) {
        if (next.signal.aborted) bridge.invalidate();
        else bridge.completeTool(e.agentId, e.tool_use_id);
      }
    }
  });

  on('turn.step', async function* ($, e, next) {
    const checkCancellation = (): void => { if (next.signal.aborted) { bridge.invalidate(); throw new Error('cancelled'); } };
    checkCancellation();
    if (!ordinary(next.origin)) {
      bridge.invalidate();
      return yield* next(e);
    }
    const revision = bridge.revision();
    let selected = e;
    const preceding = ordinary(next.origin) ? bridge.preceding(e) : undefined;
    if (preceding) {
      try {
        const sessionId = await $.session.id();
        checkCancellation();
        const workspace = await $.session.cwd();
        checkCancellation();
        const configPath = `${$.plugin.root}/${CONFIG_FILE}`;
        const configStat = await $.fs.stat(configPath, {resolve: true});
        checkCancellation();
        if (sameFile(configStat, configPath)) {
          const configText = await $.fs.read(configPath);
          checkCancellation();
          const config = parseConfig(JSON.parse(configText));
          if (config?.enabled) {
            const rootStat = await $.fs.stat(config.stateDirectory, {resolve: true});
            checkCancellation();
            const path = recordPath(config, sessionId, agentKey(e.agentId), preceding.ids);
            if (rootStat.kind === 'dir' && !rootStat.isLink && rootStat.realPath === config.stateDirectory) {
              const before = await $.fs.stat(path, {resolve: true});
              checkCancellation();
              if (sameFile(before, path)) {
                const content = await $.fs.read(path);
                checkCancellation();
                const after = await $.fs.stat(path, {resolve: true});
                checkCancellation();
                const currentConfigText = await $.fs.read(configPath);
                checkCancellation();
                const currentConfigStat = await $.fs.stat(configPath, {resolve: true});
                checkCancellation();
                const record = content.length <= MAX_RECORD_BYTES ? parseRecord(JSON.parse(content)) : undefined;
                if (record && sameFile(after, path) && before.mtimeMs === after.mtimeMs && before.size === after.size &&
                    currentConfigText === configText && sameFile(currentConfigStat, configPath) && configStat.mtimeMs === currentConfigStat.mtimeMs && configStat.size === currentConfigStat.size) {
                  selected = bridge.select(e, record, config, {sessionId, workspace}, Date.now()) as Step;
                }
              }
            }
          }
        }
      } catch { selected = e; }
    }
    checkCancellation();
    bridge.begin(e, Date.now(), revision);
    const stream = next(selected);
    let complete = false;
    let expectedToolCount = -1;
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) {
          complete = true;
          if (typeof item.value === 'object' && item.value !== null && 'toolUses' in item.value && Array.isArray(item.value.toolUses)) expectedToolCount = item.value.toolUses.length;
          return item.value;
        }
        if (item.value.kind === 'tool' && typeof item.value.id === 'string') bridge.streamTool(e, item.value.id);
        yield item.value;
      }
    } finally {
      bridge.finish(e, complete && !next.signal.aborted, expectedToolCount);
      if (!complete) await stream.return(undefined as never);
    }
  });
}
