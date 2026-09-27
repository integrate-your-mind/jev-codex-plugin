// Resolve runtime dependencies for an isolated repair checkout that deliberately
// has no node_modules. Relative imports remain rooted in the repair source;
// only package imports fall back to the pinned baseline dependency tree.
import {pathToFileURL} from 'node:url';

const repairRoot = process.env.JEV_REPAIR_SOURCE_ROOT ?? '';
const baselineRoot = process.env.JEV_BASELINE_SOURCE_ROOT ?? '';
const repairPrefix = repairRoot ? pathToFileURL(`${repairRoot}/`).href : '';
const baselineAnchor = baselineRoot ? pathToFileURL(`${baselineRoot}/src/decision-hook.ts`).href : '';

export async function resolve(specifier, context, nextResolve) {
  const isPackage = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:') && !specifier.startsWith('data:');
  if (isPackage && repairPrefix && baselineAnchor && context.parentURL?.startsWith(repairPrefix)) {
    try { return await nextResolve(specifier, {...context, parentURL: baselineAnchor}); } catch { /* ordinary resolution below */ }
  }
  return nextResolve(specifier, context);
}
