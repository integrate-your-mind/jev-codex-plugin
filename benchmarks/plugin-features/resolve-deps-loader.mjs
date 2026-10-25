import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const fallbackRoot = process.env.JEV_BENCHMARK_NODE_MODULES;
const fallbackRequire = createRequire(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!fallbackRoot || specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) throw error;
    try {
      const resolved = fallbackRequire.resolve(specifier, {paths: [fallbackRoot]});
      return {url: pathToFileURL(resolved).href, shortCircuit: true};
    } catch {
      throw error;
    }
  }
}
