#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const errors = [];

async function loadJson(relativePath) {
  const path = join(root, relativePath);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function addAjvErrors(label, valid, validator) {
  if (valid) return;
  for (const error of validator.errors ?? []) {
    errors.push(`${label}${error.instancePath || ""} ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function metadata(manifest) {
  return {
    name: manifest?.name,
    version: manifest?.version,
    description: manifest?.description,
    author: manifest?.author,
    interface: manifest?.extensions?.["com.openai"]?.interface ?? manifest?.interface,
  };
}

function containsSecretKey(value, path = "manifest") {
  if (Array.isArray(value)) {
    return value.some((item, index) => containsSecretKey(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (/api[-_]?key|access[-_]?token|authorization|password|secret/i.test(key)) {
      errors.push(`${path}.${key}: secret-bearing manifest fields are not allowed`);
      return true;
    }
    containsSecretKey(item, `${path}.${key}`);
  }
  return false;
}

const [plugin, mcp, legacy, legacyMcp] = await Promise.all([
  loadJson("plugin.json"),
  loadJson("mcp.json"),
  loadJson(".codex-plugin/plugin.json"),
  loadJson(".mcp.json"),
]);
const [release, packageMetadata] = await Promise.all([loadJson('RELEASE.json'), loadJson('package.json')]);
assert(release?.version === plugin?.version, 'RELEASE.json: version must match plugin.json');
assert(release?.runtimeVersion === packageMetadata?.version, 'RELEASE.json: runtimeVersion must match package.json');
const hooks = await loadJson('hooks/hooks.json');
const documentedEvents = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','PreCompact','PostCompact','Interrupt','SubagentStart','SubagentStop','Stop','SessionEnd'];
assert(equal(Object.keys(hooks?.hooks ?? {}).sort(), documentedEvents.sort()), 'hooks/hooks.json: declare every documented lifecycle event');
for (const [event, groups] of Object.entries(hooks?.hooks ?? {})) {
  assert(Array.isArray(groups) && groups.length === 1, `hooks/hooks.json: ${event} must have one handler group`);
  for (const group of Array.isArray(groups) ? groups : []) {
    assert(Array.isArray(group.hooks) && group.hooks.length === 1, `hooks/hooks.json: ${event} must have one command handler`);
    for (const handler of group.hooks ?? []) {
      assert(handler.type === 'command' && handler.command === 'node "${PLUGIN_ROOT}/dist/decision-hook.mjs"', `hooks/hooks.json: ${event} must use the reviewed advisory adapter`);
      assert(handler.timeout === 5 && handler.additionalContextLimit === 1000, `hooks/hooks.json: ${event} deadline/context contract mismatch`);
    }
  }
}

if (plugin && mcp) {
  const pluginSchema = await loadJson("schemas/plugin.schema.json");
  const mcpSchema = await loadJson("schemas/mcp.schema.json");
  if (pluginSchema && mcpSchema) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validatePlugin = ajv.compile(pluginSchema);
    const validateMcp = ajv.compile(mcpSchema);
    addAjvErrors("plugin.json", validatePlugin(plugin), validatePlugin);
    addAjvErrors("mcp.json", validateMcp(mcp), validateMcp);
  }
}

assert(plugin?.name === "jev-workflows", "plugin.json: name must be jev-workflows");
assert(/^0\.2\.1(?:\+codex\.[a-z0-9-]+)?$/.test(plugin?.version ?? ""), "plugin.json: version must have base 0.2.1 and optional Codex cachebuster");
assert(plugin?.extensions?.["com.openai"]?.hooks === undefined,
  "plugin.json: omit an explicit hooks override so hooks/hooks.json uses conventional discovery");
assert(legacy?.hooks === undefined, ".codex-plugin/plugin.json: direct hooks field is unsupported by the local validator");
assert(equal(metadata(plugin), metadata(legacy)),
  "plugin.json and .codex-plugin/plugin.json: identity and interface metadata must match");
const portableLegacy = structuredClone(legacyMcp?.mcpServers ?? {});
const allowedEnv = ["TYPESAFE_API_KEY","JEV_ENABLED","JEV_HOOKS_ENABLED","JEV_MAX_CALLS_PER_DAY","JEV_MAX_BYTES_PER_DAY","JEV_ALLOWED_WORKSPACES"];
assert(equal(portableLegacy["jev-workflows"]?.env_vars, allowedEnv), "legacy MCP must forward only the named runtime settings");
if (portableLegacy["jev-workflows"]) delete portableLegacy["jev-workflows"].env_vars;
assert(equal(mcp?.mcpServers, portableLegacy),
  "mcp.json and .mcp.json: MCP server entries must match");

const server = mcp?.mcpServers?.["jev-workflows"];
assert(server?.type === "stdio", "mcp.json: jev-workflows must use stdio transport");
assert(server?.command === "node", "mcp.json: command must be the bare node executable token");
assert(equal(server?.args, ["${PLUGIN_ROOT}/dist/server.mjs"]),
  "mcp.json: args must point to ${PLUGIN_ROOT}/dist/server.mjs");
assert(server?.cwd === "${PLUGIN_ROOT}", "mcp.json: cwd must be ${PLUGIN_ROOT}");
assert(!server?.command?.includes("${"), "mcp.json: placeholders are not allowed in command");
assert(!Object.hasOwn(server ?? {}, "env"), "mcp.json: no configured environment or secrets are needed");

containsSecretKey(plugin, "plugin.json");
containsSecretKey(mcp, "mcp.json");
containsSecretKey(legacy, ".codex-plugin/plugin.json");
containsSecretKey(legacyMcp, ".mcp.json");

for (const skill of ["diagnose-failure", "check-completion", "classify-decision"]) {
  try {
    await access(join(root, "skills", skill, "SKILL.md"));
  } catch {
    errors.push(`skills/${skill}/SKILL.md: expected built skill is missing`);
  }
}

if (errors.length > 0) {
  console.error("Manifest validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Manifest validation passed: ${root}`);
}
