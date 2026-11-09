import { isRetiredProvider } from '../../../core/retired-providers.mjs';

export const modelsForEnvironment = (catalog, environmentId) => catalog.filter(m => !isRetiredProvider(m.provider) && (!m.environments || m.environments.includes(environmentId)));
export function modelForEnvironment(catalog, environmentId, preferred) {
  const available = modelsForEnvironment(catalog, environmentId);
  const matched = available.find(m => m.provider === preferred?.provider && m.id === preferred?.id);
  // Removing subscriptions must not silently switch an old selection to a paid API key.
  if (!matched && isRetiredProvider(preferred?.provider)) return preferred;
  const model = matched ?? available[0];
  return model ? { provider: model.provider, id: model.id } : null;
}
