export function selectBackend(task, backends) {
  let best = null;

  for (const backend of backends) {
    if (!backend.available) continue;
    if (backend.region !== task.region) continue;
    if (!(backend.latencyMs <= task.maxLatencyMs)) continue;
    if (!task.required.every(capability => backend.capabilities.includes(capability))) continue;

    if (
      best === null ||
      backend.cost < best.cost ||
      (backend.cost === best.cost && backend.id < best.id)
    ) {
      best = backend;
    }
  }

  return best === null ? null : best.id;
}
