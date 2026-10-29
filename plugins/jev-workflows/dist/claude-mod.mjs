// src/hosts/claude/config.mjs
var BRIDGE_VERSION = "jev-claude-routing-v1";
var object = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var text = (v) => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\0\r\n]/.test(v);
var identity = (v) => text(v) && v.length <= 160;
var absolute = (v) => text(v) && v.startsWith("/") && !v.split("/").includes("..") && !v.endsWith("/");
function parseConfig(value) {
  if (!object(value) || value.version !== BRIDGE_VERSION || typeof value.enabled !== "boolean" || !absolute(value.stateDirectory) || !identity(value.hostId) || !identity(value.providerId) || !identity(value.catalogGeneration) || !identity(value.policyGeneration) || !Array.isArray(value.profiles)) return void 0;
  if (Object.keys(value).some((key) => !["version", "enabled", "stateDirectory", "hostId", "providerId", "catalogGeneration", "policyGeneration", "profiles", "transitions"].includes(key))) return void 0;
  for (const p of value.profiles) {
    if (!object(p) || !identity(p.id) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(p.id) || !identity(p.model) || !identity(p.hostId) || !identity(p.providerId) || typeof p.effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(p.effort) || !["verified", "unknown", "unavailable"].includes(p.availability)) return void 0;
    if (Object.keys(p).some((key) => !["id", "model", "effort", "hostId", "providerId", "availability"].includes(key))) return void 0;
  }
  if (new Set(value.profiles.map((p) => p.id)).size !== value.profiles.length) return void 0;
  if (value.transitions !== void 0 && (!Array.isArray(value.transitions) || value.transitions.some((t) => !object(t) || !identity(t.from) || !identity(t.to) || !["upshift", "lateral", "downshift"].includes(t.kind) || !value.profiles.some((p) => p.id === t.from) || !value.profiles.some((p) => p.id === t.to) || Object.keys(t).some((key) => !["from", "to", "kind"].includes(key))))) return void 0;
  return value;
}

// src/hosts/claude/bridge.ts
var BRIDGE_DIRECTORY = "routing-v1/claude";
var CONFIG_FILE = "claude-routing.json";
var MAX_RECORD_BYTES = 32 * 1024;
var text2 = (v) => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\0\r\n]/.test(v);
var object2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var identity2 = (v) => text2(v) && v.length <= 160;
var absolute2 = (v) => text2(v) && v.startsWith("/") && !v.split("/").includes("..") && !v.endsWith("/");
var agentKey = (agentId) => agentId ?? "main";
function toolIds(value) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(identity2)) return void 0;
  const sorted = [...value].sort();
  return new Set(sorted).size === sorted.length ? sorted : void 0;
}
function parseRecord(value) {
  if (!object2(value) || value.version !== BRIDGE_VERSION || value.producer !== "trusted-post-tool-batch" || !identity2(value.sessionId) || !identity2(value.agentId) || !absolute2(value.workspace) || !toolIds(value.toolUseIds) || !identity2(value.hostId) || !identity2(value.providerId) || !identity2(value.catalogGeneration) || !identity2(value.policyGeneration) || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Number(value.createdAt) || !["assessed", "abstained", "unavailable"].includes(String(value.status)) || !(value.selection === null || identity2(value.selection)) || typeof value.objectiveDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.objectiveDigest) || typeof value.evidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.evidenceDigest) || value.retention !== void 0 && value.retention !== "metadata" && value.retention !== "pinned" || value.receiptId !== void 0 && !identity2(value.receiptId)) return void 0;
  return { ...value, toolUseIds: toolIds(value.toolUseIds) };
}
function batchKey(ids) {
  let a = 2166136261;
  let b = 2246822507;
  for (const ch of JSON.stringify([...ids].sort())) {
    a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
    b = Math.imul(b ^ ch.charCodeAt(0), 3266489909);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
function recordPath(config, sessionId, agentId, ids) {
  return `${config.stateDirectory}/${BRIDGE_DIRECTORY}/${encodeURIComponent(sessionId)}/${encodeURIComponent(agentId)}/${batchKey(ids)}.json`;
}
var CausalBridge = class {
  generation = 0;
  batches = /* @__PURE__ */ new Map();
  active = /* @__PURE__ */ new Map();
  blockedTurns = /* @__PURE__ */ new Set();
  invalidate() {
    this.generation++;
    for (const batch of this.batches.values()) this.blockedTurns.add(batch.inference.turnId);
    this.batches.clear();
  }
  revision() {
    return this.generation;
  }
  begin(e, now, generation = this.generation) {
    const key = agentKey(e.agentId);
    const count = this.active.get(key) ?? 0;
    this.active.set(key, count + 1);
    this.batches.set(key, { inference: { ...e }, generation: this.generation, startedAt: now, ids: /* @__PURE__ */ new Set(), completed: /* @__PURE__ */ new Set(), streamComplete: false, invalid: count > 0 || generation !== this.generation || this.blockedTurns.has(e.turnId) });
  }
  streamTool(e, id) {
    const batch = this.batches.get(agentKey(e.agentId));
    if (!batch || batch.inference !== e && (batch.inference.turnId !== e.turnId || batch.inference.index !== e.index)) return;
    if (!identity2(id) || batch.ids.has(id)) batch.invalid = true;
    else batch.ids.add(id);
  }
  completeTool(agentId, id) {
    const batch = this.batches.get(agentKey(agentId));
    if (!batch) return;
    if (!batch.ids.has(id) || batch.completed.has(id)) batch.invalid = true;
    else batch.completed.add(id);
  }
  finish(e, ok, expectedToolCount) {
    const key = agentKey(e.agentId);
    const count = this.active.get(key) ?? 0;
    if (count <= 1) this.active.delete(key);
    else this.active.set(key, count - 1);
    const batch = this.batches.get(key);
    if (!batch || batch.inference.turnId !== e.turnId || batch.inference.index !== e.index) return;
    batch.streamComplete = ok;
    if (!ok || expectedToolCount !== void 0 && batch.ids.size !== expectedToolCount) batch.invalid = true;
  }
  preceding(e) {
    const batch = this.batches.get(agentKey(e.agentId));
    if (!batch || batch.invalid || this.active.has(agentKey(e.agentId)) || !batch.streamComplete || batch.generation !== this.generation || batch.inference.turnId !== e.turnId || batch.inference.index + 1 !== e.index || batch.ids.size === 0 || batch.ids.size !== batch.completed.size) return void 0;
    if (batch.inference.model !== e.model || batch.inference.effort !== e.effort) return void 0;
    return { ids: [...batch.ids].sort(), startedAt: batch.startedAt, generation: batch.generation };
  }
  select(e, record, config, scope, now) {
    const batch = this.preceding(e);
    if (!batch || !config.enabled || record.status !== "assessed" || record.sessionId !== scope.sessionId || record.workspace !== scope.workspace || record.agentId !== agentKey(e.agentId) || JSON.stringify(record.toolUseIds) !== JSON.stringify(batch.ids) || record.createdAt < batch.startedAt || record.createdAt > now || record.expiresAt <= now || record.expiresAt - record.createdAt > 6e4 || record.hostId !== config.hostId || record.providerId !== config.providerId || record.catalogGeneration !== config.catalogGeneration || record.policyGeneration !== config.policyGeneration) return e;
    const profile = config.profiles.find((p) => p.id === record.selection && p.availability === "verified" && p.hostId === config.hostId && p.providerId === config.providerId);
    const current = config.profiles.find((p) => p.availability === "verified" && p.model === e.model && p.effort === e.effort && p.hostId === config.hostId && p.providerId === config.providerId);
    const transition = current && profile && config.transitions?.find((t) => t.from === current.id && t.to === profile.id);
    return profile && transition && transition.kind !== "downshift" ? { ...e, model: profile.model, effort: profile.effort } : e;
  }
};

// src/hosts/claude/mod.ts
var ordinary = (origin) => origin.plugin === "engine" && origin.tier === "core";
var sameFile = (s, path) => s.kind === "file" && !s.isLink && s.realPath === path && s.size > 0 && s.size <= MAX_RECORD_BYTES;
function register(on, _options) {
  const bridge = new CausalBridge();
  on("prompt.submit", async ($, e, next) => {
    bridge.invalidate();
    return await next(e);
  });
  on("tool.call", async ($, e, next) => {
    try {
      return await next(e);
    } finally {
      if (ordinary(next.origin)) {
        if (next.signal.aborted) bridge.invalidate();
        else bridge.completeTool(e.agentId, e.tool_use_id);
      }
    }
  });
  on("turn.step", async function* ($, e, next) {
    const checkCancellation = () => {
      if (next.signal.aborted) {
        bridge.invalidate();
        throw new Error("cancelled");
      }
    };
    checkCancellation();
    if (!ordinary(next.origin)) {
      bridge.invalidate();
      return yield* next(e);
    }
    const revision = bridge.revision();
    let selected = e;
    const preceding = ordinary(next.origin) ? bridge.preceding(e) : void 0;
    if (preceding) {
      try {
        const sessionId = await $.session.id();
        checkCancellation();
        const workspace = await $.session.cwd();
        checkCancellation();
        const configPath = `${$.plugin.root}/${CONFIG_FILE}`;
        const configStat = await $.fs.stat(configPath, { resolve: true });
        checkCancellation();
        if (sameFile(configStat, configPath)) {
          const configText = await $.fs.read(configPath);
          checkCancellation();
          const config = parseConfig(JSON.parse(configText));
          if (config?.enabled) {
            const rootStat = await $.fs.stat(config.stateDirectory, { resolve: true });
            checkCancellation();
            const path = recordPath(config, sessionId, agentKey(e.agentId), preceding.ids);
            if (rootStat.kind === "dir" && !rootStat.isLink && rootStat.realPath === config.stateDirectory) {
              const before = await $.fs.stat(path, { resolve: true });
              checkCancellation();
              if (sameFile(before, path)) {
                const content = await $.fs.read(path);
                checkCancellation();
                const after = await $.fs.stat(path, { resolve: true });
                checkCancellation();
                const currentConfigText = await $.fs.read(configPath);
                checkCancellation();
                const currentConfigStat = await $.fs.stat(configPath, { resolve: true });
                checkCancellation();
                const record = content.length <= MAX_RECORD_BYTES ? parseRecord(JSON.parse(content)) : void 0;
                if (record && sameFile(after, path) && before.mtimeMs === after.mtimeMs && before.size === after.size && currentConfigText === configText && sameFile(currentConfigStat, configPath) && configStat.mtimeMs === currentConfigStat.mtimeMs && configStat.size === currentConfigStat.size) {
                  selected = bridge.select(e, record, config, { sessionId, workspace }, Date.now());
                }
              }
            }
          }
        }
      } catch {
        selected = e;
      }
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
          if (typeof item.value === "object" && item.value !== null && "toolUses" in item.value && Array.isArray(item.value.toolUses)) expectedToolCount = item.value.toolUses.length;
          return item.value;
        }
        if (item.value.kind === "tool" && typeof item.value.id === "string") bridge.streamTool(e, item.value.id);
        yield item.value;
      }
    } finally {
      bridge.finish(e, complete && !next.signal.aborted, expectedToolCount);
      if (!complete) await stream.return(void 0);
    }
  });
}
export {
  register
};
