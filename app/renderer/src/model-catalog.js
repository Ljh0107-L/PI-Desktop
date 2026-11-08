// Subscription grants are scoped to the machine that owns and refreshes them.
export const modelsForEnvironment = (catalog, environmentId) => catalog.filter(model =>
  !model.environments || model.environments.includes(environmentId));
export function modelForEnvironment(catalog, environmentId, preferred) {
  const available = modelsForEnvironment(catalog, environmentId);
  const matched = available.find(m => m.provider === preferred?.provider && m.id === preferred?.id);
  // Losing a subscription grant must not silently switch the next prompt to a paid API key.
  if (!matched && preferred?.provider === 'pidesk-chatgpt') return preferred;
  const model = matched ?? available[0];
  return model ? { provider: model.provider, id: model.id } : null;
}
