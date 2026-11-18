// Custom endpoints (OpenAI-, Anthropic- or Google-compatible): their base URL is accepted with or
// without the API version.
//
// Pi hands the base URL to the provider's SDK unchanged. The Anthropic SDK appends /v1/messages
// itself, so a base ending in /v1 reached /v1/v1/messages. The OpenAI SDK appends only
// /chat/completions or /responses, so there the version belongs in the base, and servers differ:
// OpenAI and Moonshot serve only /v1/…, Perplexity only the root, DeepSeek both. Pi sets up Google's
// SDK to append only models/<model>:streamGenerateContent, so there too the version belongs in the
// base. Only Google's own host defaults to /v1beta; a custom gateway may need the exact URL entered.

const ANTHROPIC = 'anthropic-messages';
const GOOGLE = 'google-generative-ai';
const GOOGLE_VERSION = /\/v\d+(?:(?:alpha|beta)\d*)?$/i;

// A Google URL without a pasted request's query (which can hold ?key=) or its models/… path.
function googleBase(url) {
  return String(url ?? '').trim().replace(/[?#].*$/s, '').replace(/\/+$/, '')
    .replace(/(\/v\d+(?:(?:alpha|beta)\d*)?)\/models(?:\/.*)?$/i, '$1').replace(/\/models$/i, '');
}

// The base the SDK needs, without a network check: no trailing slash, no pasted endpoint path, and
// for Anthropic no /v1. A Google base gets its version when it is saved (resolveProviderBaseUrl).
export function providerBaseUrl(api, url) {
  if (api === GOOGLE) return googleBase(url);
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (api === ANTHROPIC) return base.replace(/\/v1(?:\/messages)?$/i, '');
  return base.replace(/\/(?:chat\/completions|responses)$/i, '');
}

const withOrWithoutV1 = base => /\/v1$/i.test(base) ? base.slice(0, -3) : `${base}/v1`;
const isUrl = base => /^https?:\/\/[^/]/i.test(base);
function requestHeaders(api, apiKey, headers) {
  const auth = !apiKey ? {} : api === ANTHROPIC
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', authorization: `Bearer ${apiKey}` }
    : api === GOOGLE ? { 'x-goog-api-key': apiKey } // Google reads a bearer token as OAuth and rejects a key there
    : { authorization: `Bearer ${apiKey}` };
  return { ...auth, ...headers };
}
const statusOf = response => response.then(res => { res.body?.cancel().catch(() => {}); return res.status; }, () => 0);

// Model discovery tries Google's conventional version and the entered URL. A successful HTTP
// status alone proves nothing: some gateways return 200 with an empty body for unknown routes.
const googleCandidates = url => {
  const base = googleBase(url);
  return !isUrl(base) || GOOGLE_VERSION.test(base) ? [base] : [`${base}/v1beta`, base];
};

// For an OpenAI-compatible endpoint, which of the URL as entered and the same URL with /v1 added or
// removed serves the API. An empty request gets 404 where there is no such route and 400 or 401 where
// there is, without generating anything. Only when the URL as entered has no such route and the other
// one does is the other one used; a server this Mac cannot reach (it may be reachable only from an SSH
// host) keeps the URL as entered. Google custom URLs change only when a valid model list proves the
// alternative works. GET …/models generates nothing; generation-only gateways need no discovery.
export async function resolveProviderBaseUrl({ api, baseUrl, headers }, apiKey, { timeout = 8000 } = {}) {
  if (api === GOOGLE) {
    const [versioned, entered] = googleCandidates(baseUrl);
    if (!entered) return versioned;
    const servesModels = async url => {
      try {
        const res = await fetch(`${url}/models`, { headers: requestHeaders(api, apiKey, headers), signal: AbortSignal.timeout(timeout) });
        if (!res.ok) { res.body?.cancel().catch(() => {}); return false; }
        await googleModelPage(res);
        return true;
      } catch { return false; }
    };
    const [withVersion, without] = await Promise.all([servesModels(versioned), servesModels(entered)]);
    if (without) return entered;
    if (withVersion || entered === 'https://generativelanguage.googleapis.com') return versioned;
    return entered;
  }
  const base = providerBaseUrl(api, baseUrl);
  if (api === ANTHROPIC || !isUrl(base)) return base;
  const other = withOrWithoutV1(base);
  const path = api === 'openai-responses' ? '/responses' : '/chat/completions';
  const status = url => statusOf(fetch(url + path, {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json', ...requestHeaders(api, apiKey, headers) },
  }));
  const [entered, alternative] = await Promise.all([status(base), status(other)]);
  return entered === 404 && alternative && alternative !== 404 ? other : base;
}

export const toModel = m => typeof m === 'string' ? { id: m } : {
  id: m?.id ?? (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : undefined),
  name: m?.display_name ?? m?.displayName ?? (m?.id ? m.name : undefined),
  contextWindow: m?.context_length ?? m?.context_window ?? m?.max_context_length ?? m?.inputTokenLimit ?? m?.max_input_tokens ?? undefined,
  maxTokens: m?.max_output_tokens ?? m?.outputTokenLimit ?? m?.max_completion_tokens ?? m?.top_provider?.max_completion_tokens ?? m?.max_tokens ?? undefined,
  ...(typeof m?.thinking === 'boolean' ? { reasoning: m.thinking } : {}),
};
const toModels = list => list.map(toModel).filter(m => typeof m.id === 'string' && m.id).sort((a, b) => a.id.localeCompare(b.id));

export function modelList(body, description = 'a model list') {
  const models = Array.isArray(body) ? body : body?.data ?? body?.models;
  if (!Array.isArray(models)) throw new Error(`Expected ${description}`);
  return models;
}

// An empty array is a valid model list; an empty body, HTML login page, or unrelated JSON is not.
async function googleModelPage(res) {
  let body;
  try { body = await res.json(); } catch { throw new Error('Expected a Google model list'); }
  const models = modelList(body, 'a Google model list');
  return { models, nextPageToken: body?.nextPageToken };
}

// Gemini lists its models a page at a time, among them models that only embed text or make images:
// only the ones that generate content are kept.
export async function googleModels(base, apiKey, headers, options = {}) {
  const models = [];
  let token;
  for (let page = 0; page < 20; page++) {
    const url = `${base}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const res = await fetch(url, { headers: requestHeaders(GOOGLE, apiKey, headers), signal: AbortSignal.timeout(15000), ...options });
    if (!res.ok) {
      const detail = await res.json().then(body => body?.error?.message, () => undefined); // e.g. "API key not valid."
      const message = typeof detail === 'string' && apiKey ? detail.replaceAll(apiKey, '[redacted]') : detail;
      throw new Error(`${res.status} ${res.statusText} from ${base}/models${typeof message === 'string' ? `: ${message}` : ''}`);
    }
    const pageData = await googleModelPage(res);
    models.push(...pageData.models);
    token = pageData.nextPageToken;
    if (!token) break;
  }
  return models.filter(m => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.some(method => /generateContent$/i.test(method)));
}

export async function fetchModelList(url, { headers, paginate = false, redirect } = {}) {
  const models = [];
  const seen = new Set();
  const signal = AbortSignal.timeout(15000);
  let pageUrl = url;
  while (true) {
    const res = await fetch(pageUrl, { headers, signal, redirect });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`${res.status} ${res.statusText} from ${url}`);
    }
    const body = await res.json().catch(() => null);
    models.push(...modelList(body));
    if (!paginate || !body?.has_more) return models;
    const cursor = body.last_id;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error(`Invalid model list cursor from ${url}`);
    seen.add(cursor);
    const next = new URL(url);
    next.searchParams.set('after_id', cursor);
    pageUrl = next.href;
  }
}

// A refused key says more than a missing route: the first error that isn't a 404 is the one shown.
const telling = (kept, error) => kept && !/^404 /.test(kept.message) ? kept : error;

// The endpoint's model list: GET …/models, also tried with /v1 added or removed (for Google, with
// and without /v1beta).
export async function listCustomModels({ api, baseUrl, headers }, apiKey) {
  const base = providerBaseUrl(api, baseUrl);
  if (!isUrl(base)) throw new Error('Enter the base URL first.');
  let lastError;
  if (api === GOOGLE) {
    for (const candidate of googleCandidates(baseUrl)) {
      try { return toModels(await googleModels(candidate, apiKey, headers)); }
      catch (error) { lastError = telling(lastError, error); }
    }
    throw new Error(`Couldn't list models: ${lastError?.message ?? 'no response'}`);
  }
  const urls = api === ANTHROPIC ? [`${base}/v1/models`, `${base}/models`] : [`${base}/models`, `${withOrWithoutV1(base)}/models`];
  for (const url of urls) {
    try { return toModels(await fetchModelList(url, { headers: requestHeaders(api, apiKey, headers), paginate: api === ANTHROPIC })); }
    catch (error) { lastError = telling(lastError, error); }
  }
  throw new Error(`Couldn't list models: ${lastError?.message ?? 'no response'}`);
}
