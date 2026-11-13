import { isRetiredProvider } from '../../../core/retired-providers.mjs';

export const isModelForEngine = (model, engine = 'pi') =>
  engine === 'claude-code'
    ? (Array.isArray(model?.engines) ? model.engines.includes('claude-code') : model?.api === 'anthropic-messages')
    : true;

export const modelsForEnvironment = (catalog, environmentId, engine = 'pi') =>
  catalog.filter(m => !isRetiredProvider(m.provider) && (!m.environments || m.environments.includes(environmentId)) && isModelForEngine(m, engine));

export function modelForEnvironment(catalog, environmentId, preferred, engine = 'pi') {
  const available = modelsForEnvironment(catalog, environmentId, engine);
  const matched = available.find(m => m.provider === preferred?.provider && m.id === preferred?.id);
  // Removing subscriptions must not silently switch an old selection to a paid API key.
  if (!matched && engine !== 'claude-code' && isRetiredProvider(preferred?.provider)) return preferred;
  const model = matched ?? available[0];
  return model ? { provider: model.provider, id: model.id } : null;
}
