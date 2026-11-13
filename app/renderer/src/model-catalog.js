import { isRetiredProvider } from '../../../core/retired-providers.mjs';

export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Levels a model offers, per Pi: a thinkingLevelMap value of null removes a level; unmapped levels use the
// provider default up to high, and xhigh/max exist only when mapped.
export const effortsFor = model => {
  if (model?.reasoning === false) return [];
  const map = model?.thinkingLevelMap ?? {};
  return EFFORTS.filter(l => map[l] === null ? false : ['xhigh', 'max'].includes(l) ? map[l] != null : true);
};

// Claude Code efforts (low..max): respects reasoning=false and thinkingLevelMap when configured.
export const claudeEffortsFor = model => {
  if (model?.reasoning === false) return [];
  if (!model?.thinkingLevelMap) return [...CLAUDE_EFFORTS];
  return effortsFor(model).filter(l => CLAUDE_EFFORTS.includes(l));
};

export function clampEffort(allowed, wanted, fallback = 'medium') {
  if (!Array.isArray(allowed) || !allowed.length) return wanted;
  if (allowed.includes(wanted)) return wanted;
  const idx = EFFORTS.indexOf(wanted);
  if (idx >= 0) {
    for (let i = idx; i < EFFORTS.length; i++) if (allowed.includes(EFFORTS[i])) return EFFORTS[i];
    for (let i = idx - 1; i >= 0; i--) if (allowed.includes(EFFORTS[i])) return EFFORTS[i];
  }
  return allowed.includes(fallback) ? fallback : allowed[0];
}

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
