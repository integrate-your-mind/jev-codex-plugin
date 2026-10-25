import assert from 'node:assert/strict';
import {mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {buildGraph} from '../src/graph.js';
import {ProjectGraphRuntime} from '../src/runtime.js';
import {fixture} from './helpers.js';

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

describe('TypeScript project graph', () => {
  it('derives import, containment, reference, and call edges from compiler-resolved source', async () => {
    const setup = await fixture(); owned.push(setup.parent);
    const graph = await buildGraph(setup.root);
    const byName = (name: string) => [...graph.nodes.values()].find(node => node.name === name);
    const main = [...graph.nodes.values()].find(node => node.kind === 'file' && node.path === 'main.ts')!;
    const greetingFile = [...graph.nodes.values()].find(node => node.kind === 'file' && node.path === 'greeting.ts')!;
    const run = byName('run')!;
    const greeting = byName('greeting')!;
    const format = byName('formatName')!;
    assert.ok(main && greetingFile && run && greeting && format);
    assert.equal(graph.edges.some(edge => edge.kind === 'imports' && edge.from === main.nodeId && edge.to === greetingFile.nodeId), true);
    assert.equal(graph.edges.some(edge => edge.kind === 'contains' && edge.from === greetingFile.nodeId && edge.to === greeting.nodeId), true);
    assert.equal(graph.edges.some(edge => edge.kind === 'references' && edge.from === run.nodeId && edge.to === greeting.nodeId), true);
    assert.equal(graph.edges.some(edge => edge.kind === 'calls' && edge.from === run.nodeId && edge.to === greeting.nodeId), true);
    assert.equal(graph.edges.some(edge => edge.kind === 'calls' && edge.from === greeting.nodeId && edge.to === format.nodeId), true);
    assert.deepEqual(graph.dependencies, []);
  });

  it('invalidates old node references after an edit and returns current source cards', async () => {
    const setup = await fixture(); owned.push(setup.parent);
    const runtime = new ProjectGraphRuntime({root: setup.root, stateDirectory: setup.state, arm: 'cheap', objective: 'repair greeting'});
    const found = await runtime.search('format name');
    const node = found.cards.find(card => card.name === 'formatName')!;
    assert.ok(node);
    await writeFile(join(setup.root, 'greeting.ts'), 'export function normalizeName(value: string): string { return value.trim().toLowerCase(); }\n');
    await assert.rejects(runtime.read(node.nodeId), /stale or unknown nodeId/);
    const current = await runtime.search('normalize name lowercase');
    assert.notEqual(current.graphVersion, found.graphVersion);
    assert.equal(current.cards.some(card => card.name === 'normalizeName' && card.excerpt.includes('toLowerCase')), true);
  });

  it('keeps every required containment neighbor reachable through expansion pages', async () => {
    const setup = await fixture(); owned.push(setup.parent);
    await writeFile(join(setup.root, 'many.ts'), Array.from({length: 12}, (_, index) => `export function item${index}(): number { return ${index}; }`).join('\n'));
    const runtime = new ProjectGraphRuntime({root: setup.root, stateDirectory: setup.state, arm: 'graph', objective: 'inspect all exports'});
    const search = await runtime.search('many item');
    const file = search.cards.find(card => card.path === 'many.ts' && card.kind === 'file')!;
    assert.ok(file);
    const first = await runtime.expand(file.nodeId, 'item');
    assert.equal(first.cards.length, 8);
    assert.ok(first.nextCursor);
    const second = await runtime.expand(file.nodeId, 'item', first.nextCursor);
    const names = [...first.cards, ...second.cards].map(card => card.name).sort();
    assert.deepEqual(names, Array.from({length: 12}, (_, index) => `item${index}`).sort());
  });

  it('freezes a Jev frontier once so later cursor pages neither rerank nor call the provider again', async () => {
    const setup = await fixture(); owned.push(setup.parent);
    const functions = Array.from({length: 12}, (_, index) => `export function target${index}(): number { return ${index}; }`);
    const calls = Array.from({length: 12}, (_, index) => `target${index}()`).join(' + ');
    await writeFile(join(setup.root, 'frontier.ts'), `${functions.join('\n')}\nexport function hub(): number { return ${calls}; }\n`);
    let evaluations = 0;
    const runtime = new ProjectGraphRuntime({
      root: setup.root,
      stateDirectory: setup.state,
      arm: 'jev',
      objective: 'inspect hub dependencies',
      evaluate: async input => {
        evaluations += 1;
        const questions = Object.keys((input as {questions: Record<string, unknown>}).questions);
        return {status: 'assessed', receiptId: 'one-ranking', answers: Object.fromEntries(questions.map((id, index) => [id, {type: 'score', score: index, disposition: 'ranking'}]))};
      },
    });
    const graph = await buildGraph(setup.root);
    const hub = [...graph.nodes.values()].find(card => card.name === 'hub')!;
    assert.ok(hub);
    const first = await runtime.expand(hub.nodeId, 'target');
    assert.ok(first.nextCursor);
    assert.equal(evaluations, 1);
    const second = await runtime.expand(hub.nodeId, 'target', first.nextCursor);
    assert.equal(evaluations, 1);
    const delivered = [...first.cards, ...second.cards];
    assert.equal(new Set(delivered.map(card => card.nodeId)).size, 13);
    assert.equal(delivered.filter(card => card.name.startsWith('target')).length, 12);
  });

  it('does not index symlinked source or turn an import outside the workspace into a semantic edge', async () => {
    const setup = await fixture(); owned.push(setup.parent);
    const outside = join(setup.parent, 'outside.ts');
    await writeFile(outside, 'export const outsideSecret = "not graph source";\n');
    await symlink(outside, join(setup.root, 'linked.ts'));
    await writeFile(join(setup.root, 'escape.ts'), "import { outsideSecret } from '../outside.js';\nexport const value = outsideSecret;\n");
    const graph = await buildGraph(setup.root);
    assert.equal(graph.sourceFiles.includes('linked.ts'), false);
    assert.equal([...graph.nodes.values()].some(node => node.name === 'outsideSecret' && node.path === 'linked.ts'), false);
    assert.equal(graph.dependencies.some(item => item.path === 'escape.ts' && item.specifier === '../outside.js' && item.status === 'external'), true);
    assert.equal(graph.edges.some(edge => graph.nodes.get(edge.from)?.path === 'escape.ts' && graph.nodes.get(edge.to)?.path === '../outside.ts'), false);
  });

  it('rejects a symlinked private graph state directory', async () => {
    const setup = await fixture(); owned.push(setup.parent);
    const actualState = join(setup.parent, 'actual-state');
    const stateLink = join(setup.parent, 'state-link');
    await mkdir(actualState);
    await symlink(actualState, stateLink);
    await assert.rejects(ProjectGraphRuntime.fromEnvironment({
      PROJECT_GRAPH_ROOT: setup.root,
      PROJECT_GRAPH_STATE: stateLink,
      PROJECT_GRAPH_ARM: 'graph',
    }), /PROJECT_GRAPH_STATE must be a real directory/);
  });
});
