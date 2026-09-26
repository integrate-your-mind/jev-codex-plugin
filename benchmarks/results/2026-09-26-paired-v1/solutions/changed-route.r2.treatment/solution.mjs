export function selectBackend(task, backends) {
  let best = null;

  for (const backend of backends) {
    if (!backend.available ||
        backend.region !== task.region ||
        !(backend.latencyMs <= task.maxLatencyMs) ||
        !task.required.every(capability => backend.capabilities.includes(capability))) {
      continue;
    }

    if (best === null || backend.cost < best.cost ||
        (backend.cost === best.cost && backend.id < best.id)) {
      best = backend;
    }
  }

  return best === null ? null : best.id;
}
