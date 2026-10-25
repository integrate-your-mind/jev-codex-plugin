import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

export async function fixture(): Promise<{root: string; state: string; parent: string}> {
  const parent = await mkdtemp(join(tmpdir(), 'project-graph-'));
  const root = join(parent, 'workspace');
  const state = join(parent, 'private-state');
  await mkdir(root);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext'}, include: ['*.ts']}));
  await writeFile(join(root, 'greeting.ts'), [
    'export function greeting(name: string): string {',
    '  return formatName(name);',
    '}',
    'export function formatName(name: string): string {',
    '  return name.trim();',
    '}',
  ].join('\n'));
  await writeFile(join(root, 'main.ts'), [
    "import { greeting } from './greeting.js';",
    'export function run(): string {',
    "  return greeting(' Ada ');",
    '}',
  ].join('\n'));
  return {root, state, parent};
}
