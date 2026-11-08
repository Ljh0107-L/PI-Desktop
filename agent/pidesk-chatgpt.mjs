// The subscription is separate from OpenAI API-key providers. Only a request-scoped access token
// reaches Pi; refresh tokens and vault keys stay in the host-local authentication owner.
import { isAbsolute } from 'node:path';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { CHATGPT_PROVIDER, validVaultId } from './pidesk-chatgpt-vault.mjs';
import { chatGPTRequest } from './pidesk-chatgpt-auth.mjs';

let nativeOpenAI;
const openaiProvider = () => nativeOpenAI ??= builtinProviders().find(provider => provider.id === 'openai');

const EDITABLE_FIELDS = ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinkingLevelMap'];
export function chatGPTModelOverrides(available, selection) {
  if (selection == null) return undefined;
  if (!Array.isArray(selection)) throw new Error('Choose a list of ChatGPT models.');
  const catalog = new Map(available.map(m => [m.id, m])), seen = new Set();
  return selection.map(row => {
    const base = catalog.get(row?.id);
    if (!base || seen.has(row.id)) throw new Error('Choose unique models from the ChatGPT catalog.');
    seen.add(row.id);
    const result = { id: row.id };
    for (const field of EDITABLE_FIELDS) {
      const value = row[field];
      if (value === undefined) continue;
      if (['contextWindow', 'maxTokens'].includes(field) && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Token limits must be positive whole numbers.');
      if (field === 'name' && (typeof value !== 'string' || !value.trim())) throw new Error('Enter a model name.');
      if (field === 'reasoning' && typeof value !== 'boolean') throw new Error('Invalid reasoning setting.');
      if (field === 'input' && (!Array.isArray(value) || !value.length || value.some(v => !['text', 'image'].includes(v)))) throw new Error('Choose text or image input.');
      if (field === 'thinkingLevelMap' && (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([k, v]) =>
        !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(k) || (v !== null && typeof v !== 'string')))) throw new Error('Invalid thinking levels.');
      if (JSON.stringify(value) !== JSON.stringify(base[field])) result[field] = structuredClone(value);
    }
    if ((result.maxTokens ?? base.maxTokens) > (result.contextWindow ?? base.contextWindow)) throw new Error('Maximum output cannot exceed the context window.');
    return result;
  });
}
export function chatGPTModels(provider = openaiProvider(), selection) {
  const available = provider.getModels();
  const overrides = chatGPTModelOverrides(available, selection);
  const models = overrides === undefined ? available : overrides.map(row => ({ ...available.find(m => m.id === row.id), ...row }));
  return models.map(model => ({ ...model, provider: CHATGPT_PROVIDER, pideskChatGPTSettings: 1,
    // Pi disables mid-conversation effort updates for Sign in with ChatGPT. Our provider alias
    // must preserve that protocol behavior too, not just the catalog's API-key capabilities.
    compat: { ...model.compat, supportsMidConvoEffort: false },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}
function subscriptionOptions(options) {
  return { ...options, onPayload: async (body, model) => {
    const payload = { ...(await options?.onPayload?.(body, model) ?? body) };
    // These fields are omitted by Pi's official ChatGPT sign-in path, whose detection is keyed
    // to provider "openai". Keep the same rules under our separate subscription identity.
    for (const key of ['max_output_tokens', 'temperature', 'prompt_cache_retention', 'prompt_cache_options']) delete payload[key];
    return payload;
  } };
}
export function chatGPTProvider(config, { provider = openaiProvider(), request = chatGPTRequest } = {}) {
  if (!validVaultId(config?.vaultId) || !isAbsolute(config?.socketPath ?? '') ||
      !/^[0-9a-f]{64}$/.test(config?.capability ?? '')) throw new Error('Invalid ChatGPT connection');
  const models = chatGPTModels(provider, config.models);
  return {
    ...provider, id: CHATGPT_PROVIDER, name: 'ChatGPT',
    stream: (model, context, options) => provider.stream(model, context, subscriptionOptions(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, subscriptionOptions(options)),
    getModels: () => models, getAllModels: () => models,
    auth: { apiKey: {
      name: 'ChatGPT subscription',
      check: async () => ({ type: 'api_key', source: 'ChatGPT subscription' }),
      resolve: async ({ signal }) => {
        const result = await request(config.socketPath, { op: 'access', vaultId: config.vaultId, capability: config.capability }, { signal });
        if (typeof result.access !== 'string' || !result.access) throw new Error('Reconnect ChatGPT for this environment in Settings.');
        return { auth: { apiKey: result.access }, source: 'ChatGPT subscription' };
      },
    } },
  };
}
