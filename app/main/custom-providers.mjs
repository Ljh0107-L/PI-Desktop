// Custom endpoints (OpenAI- or Anthropic-compatible): their base URL is accepted with or without /v1.
//
// Pi hands the base URL to the provider's SDK unchanged. The Anthropic SDK appends /v1/messages
// itself, so a base ending in /v1 reached /v1/v1/messages. The OpenAI SDK appends only
// /chat/completions or /responses, so there the version belongs in the base, and servers differ:
// OpenAI and Moonshot serve only /v1/…, Perplexity only the root, DeepSeek both.

const ANTHROPIC = 'anthropic-messages';

// The base the SDK needs, without a network check: no trailing slash, no pasted endpoint path, and
// for Anthropic no /v1.
export function providerBaseUrl(api, url) {
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (api === ANTHROPIC) return base.replace(/\/v1(?:\/messages)?$/i, '');
  return base.replace(/\/(?:chat\/completions|responses)$/i, '');
}

const withOrWithoutV1 = base => /\/v1$/i.test(base) ? base.slice(0, -3) : `${base}/v1`;
const isUrl = base => /^https?:\/\/[^/]/i.test(base);
function requestHeaders(api, apiKey, headers) {
  const auth = !apiKey ? {} : api === ANTHROPIC
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', authorization: `Bearer ${apiKey}` }
    : { authorization: `Bearer ${apiKey}` };
  return { ...auth, ...headers };
}

// For an OpenAI-compatible endpoint, which of the URL as entered and the same URL with /v1 added or
// removed serves the API. An empty request gets 404 where there is no such route and 400 or 401 where
// there is, without generating anything. Only when the URL as entered has no such route and the other
// one does is the other one used; a server this Mac cannot reach (it may be reachable only from an SSH
// host) keeps the URL as entered.
export async function resolveProviderBaseUrl({ api, baseUrl, headers }, apiKey, { timeout = 8000 } = {}) {
  const base = providerBaseUrl(api, baseUrl);
  if (api === ANTHROPIC || !isUrl(base)) return base;
  const other = withOrWithoutV1(base);
  const path = api === 'openai-responses' ? '/responses' : '/chat/completions';
  const status = url => fetch(url + path, {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json', ...requestHeaders(api, apiKey, headers) },
  }).then(res => { res.body?.cancel().catch(() => {}); return res.status; }, () => 0);
  const [entered, alternative] = await Promise.all([status(base), status(other)]);
  return entered === 404 && alternative && alternative !== 404 ? other : base;
}

// The endpoint's model list: GET …/models, also tried with /v1 added or removed.
export async function listCustomModels({ api, baseUrl, headers }, apiKey) {
  const base = providerBaseUrl(api, baseUrl);
  if (!isUrl(base)) throw new Error('Enter the base URL first.');
  const urls = api === ANTHROPIC ? [`${base}/v1/models`, `${base}/models`] : [`${base}/models`, `${withOrWithoutV1(base)}/models`];
  let lastError;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: requestHeaders(api, apiKey, headers), signal: AbortSignal.timeout(15000) });
      if (!res.ok) { res.body?.cancel().catch(() => {}); lastError = new Error(`${res.status} ${res.statusText} from ${url}`); continue; }
      const body = await res.json();
      const list = Array.isArray(body) ? body : body.data ?? body.models ?? [];
      return list.map(m => typeof m === 'string' ? { id: m } : {
        id: m.id ?? m.name?.replace(/^models\//, ''),
        name: m.display_name ?? m.displayName ?? undefined,
        contextWindow: m.context_length ?? m.context_window ?? m.inputTokenLimit ?? undefined,
        maxTokens: m.max_output_tokens ?? m.outputTokenLimit ?? m.top_provider?.max_completion_tokens ?? undefined,
      }).filter(m => m.id).sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) { lastError = error; }
  }
  throw new Error(`Couldn't list models: ${lastError?.message ?? 'no response'}`);
}
