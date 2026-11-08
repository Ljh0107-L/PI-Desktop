// Subscription grants are scoped to the machine that owns and refreshes them.
export const modelsForEnvironment = (catalog, environmentId) => catalog.filter(model =>
  !model.environments || model.environments.includes(environmentId));
export function modelForEnvironment(catalog, environmentId, preferred) {
  const available = modelsForEnvironment(catalog, environmentId);
  const model = available.find(m => m.provider === preferred?.provider && m.id === preferred?.id) ?? available[0];
  return model ? { provider: model.provider, id: model.id } : null;
}
