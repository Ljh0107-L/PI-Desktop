import { fetchModelList, googleModels, toModel } from './custom-providers.mjs';

const CHAT = 'openai-completions';
const RESPONSES = 'openai-responses';
const ANTHROPIC = 'anthropic-messages';
const GOOGLE = 'google-generative-ai';

// Discovery follows the provider's own list API. It can differ from the inference protocol and URL.
const endpoints = {
  anthropic: { name: 'Anthropic', api: ANTHROPIC, baseUrl: 'https://api.anthropic.com', listPath: '/v1/models' },
  openai: { name: 'OpenAI', api: RESPONSES, baseUrl: 'https://api.openai.com/v1' },
  deepseek: { name: 'DeepSeek', api: CHAT, baseUrl: 'https://api.deepseek.com' },
  google: { name: 'Google Gemini', api: GOOGLE, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  openrouter: { name: 'OpenRouter', api: CHAT, baseUrl: 'https://openrouter.ai/api/v1', listPath: '/models/user' },
  xai: { name: 'xAI', api: RESPONSES, baseUrl: 'https://api.x.ai/v1', listPath: '/language-models' },
  groq: { name: 'Groq', api: CHAT, baseUrl: 'https://api.groq.com/openai/v1' },
  mistral: { name: 'Mistral', api: 'mistral-conversations', baseUrl: 'https://api.mistral.ai', listPath: '/v1/models' },
  moonshotai: { name: 'Moonshot (Kimi)', api: CHAT, baseUrl: 'https://api.moonshot.ai/v1' },
  zai: { name: 'Z.ai (GLM)', api: CHAT, baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
  fireworks: { name: 'Fireworks', api: CHAT, baseUrl: 'https://api.fireworks.ai/inference/v1' },
  together: { name: 'Together', api: CHAT, baseUrl: 'https://api.together.ai/v1' },
};

export const BUILTIN_PROVIDERS = Object.fromEntries(Object.entries(endpoints).map(([id, { name }]) => [id, name]));

// Model lists often return only identifiers. These settings supplement Pi's catalog for the GPT-6.2
// release, and only apply when the model is returned by the endpoint.
function openAIModel(id) {
  const variant = /^gpt-6\.2-(sol|astra)(?:$|-\d{4}-\d{2}-\d{2}$)/.exec(id)?.[1];
  if (!variant) return {};
  const [input, output, cacheRead, cacheWrite] = variant === 'sol' ? [2, 10, 0.1, 2.5] : [8, 40, 0.4, 10];
  return {
    name: variant === 'sol' ? 'GPT-6.2 Sol' : 'GPT-6.2 Astra',
    input: ['text', 'image'], reasoning: true, contextWindow: 1050000, maxTokens: 128000,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    cost: { input, output, cacheRead, cacheWrite, tiers: [
      { inputTokensAbove: 272000, input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: cacheWrite * 2 },
    ] },
  };
}

export function builtinModelRoute(providerId, model) {
  const endpoint = Object.hasOwn(endpoints, providerId) ? endpoints[providerId] : undefined;
  return endpoint ? { ...model, api: model.api ?? endpoint.api, baseUrl: model.baseUrl ?? endpoint.baseUrl } : model;
}

function supportsChat(providerId, entry, id) {
  if (entry?.active === false || entry?.capabilities?.completion_chat === false) return false;
  const outputs = entry?.architecture?.output_modalities ?? entry?.output_modalities;
  if (Array.isArray(outputs) && !outputs.includes('text')) return false;
  if (/^(?:audio|classifier|embedding|embeddings|image|moderation|rerank|reranker|speech|transcription|video)$/i.test(entry?.type)) return false;
  // Some list APIs return only IDs, including models for other products on the same host.
  if (providerId === 'openai' && !/^(?:ft:)?(?:gpt-[1-9]|o[1-9](?:$|-)|chatgpt-)/i.test(id)) return false;
  return !/(?:^|[/-])(?:audio|embedding|embed|imagen|realtime|transcribe|tts|whisper)(?:[-/]|$)/i.test(id);
}

function positiveLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function discoveredModel(providerId, entry, model) {
  const { id } = model;
  const documented = providerId === 'openai' ? openAIModel(id) : {};
  const inputs = entry?.architecture?.input_modalities ?? entry?.input_modalities;
  const input = inputs?.includes?.('image') || entry?.capabilities?.vision === true || entry?.capabilities?.image_input?.supported === true
    ? ['text', 'image'] : ['text'];
  return builtinModelRoute(providerId, {
    id, name: model.name ?? documented.name ?? id,
    input: documented.input ?? input,
    reasoning: model.reasoning ?? documented.reasoning ?? (entry?.capabilities?.thinking?.supported === true),
    contextWindow: positiveLimit(model.contextWindow) ?? documented.contextWindow ?? 32768,
    maxTokens: positiveLimit(model.maxTokens) ?? documented.maxTokens ?? 4096,
    ...(documented.thinkingLevelMap ? { thinkingLevelMap: documented.thinkingLevelMap, cost: documented.cost } : {}),
  });
}

export async function listBuiltinModels(providerId, apiKey, loadCatalog) {
  if (!Object.hasOwn(endpoints, providerId)) throw new Error('Unknown built-in provider.');
  const { name, api, baseUrl, listPath = '/models' } = endpoints[providerId];
  const headers = api === ANTHROPIC ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` };
  try {
    const live = api === GOOGLE
      ? googleModels(baseUrl, apiKey, undefined, { redirect: 'error', signal: AbortSignal.timeout(15000) })
      : fetchModelList(baseUrl + listPath, { headers, paginate: api === ANTHROPIC, redirect: 'error' });
    const [entries, catalog] = await Promise.all([live, loadCatalog().catch(() => [])]);
    const known = new Map(catalog.map(model => [model.id, model]));
    const models = new Map();
    for (const entry of entries) {
      const model = toModel(entry);
      if (typeof model.id !== 'string' || !model.id || !supportsChat(providerId, entry, model.id)) continue;
      if (!models.has(model.id)) models.set(model.id, known.get(model.id) ?? discoveredModel(providerId, entry, model));
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    const detail = error.cause?.code ?? error.message;
    throw new Error(`Couldn't list ${name} models: ${detail}`, { cause: error });
  }
}
