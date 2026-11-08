// The subscription is separate from OpenAI API-key providers. Only a request-scoped access token
// reaches Pi; refresh tokens and vault keys stay in the host-local authentication owner.
import { isAbsolute } from 'node:path';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { CHATGPT_PROVIDER, validVaultId } from './pidesk-chatgpt-vault.mjs';
import { chatGPTRequest } from './pidesk-chatgpt-auth.mjs';

export function chatGPTModels(provider = openaiProvider()) {
  return provider.getModels().map(model => ({ ...model, provider: CHATGPT_PROVIDER,
    // API list prices are not the subscription's bill or remaining quota.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}
export function chatGPTProvider(config, { provider = openaiProvider(), request = chatGPTRequest } = {}) {
  if (!validVaultId(config?.vaultId) || !isAbsolute(config?.socketPath ?? '') ||
      !/^[0-9a-f]{64}$/.test(config?.capability ?? '')) throw new Error('Invalid ChatGPT connection');
  const models = chatGPTModels(provider);
  return {
    ...provider, id: CHATGPT_PROVIDER, name: 'ChatGPT',
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
