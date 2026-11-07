// Custom endpoints (OpenAI-, Anthropic- or Google-compatible): their base URL is accepted with or
// without the API version.
//
// Pi hands the base URL to the provider's SDK unchanged. The Anthropic SDK appends /v1/messages
// itself, so a base ending in /v1 reached /v1/v1/messages. The OpenAI SDK appends only
// /chat/completions or /responses, so there the version belongs in the base, and servers differ:
// OpenAI and Moonshot serve only /v1/…, Perplexity only the root, DeepSeek both. Pi sets up Google's
// SDK to append only models/<model>:streamGenerateContent, so there too the version belongs in the
// base: /v1beta, the one Google's SDK uses by default, unless the URL names another.

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

// The Google bases worth trying, in order: as entered when it names a version, else with /v1beta
// added, then as entered for a gateway that serves the API without a version.
const googleCandidates = url => {
  const base = googleBase(url);
  return !isUrl(base) || GOOGLE_VERSION.test(base) ? [base] : [`${base}/v1beta`, base];
};

// For an OpenAI-compatible endpoint, which of the URL as entered and the same URL with /v1 added or
// removed serves the API. An empty request gets 404 where there is no such route and 400 or 401 where
// there is, without generating anything. Only when the URL as entered has no such route and the other
// one does is the other one used; a server this Mac cannot reach (it may be reachable only from an SSH
// host) keeps the URL as entered. A Google URL without a version gets /v1beta, unless only the URL as
// entered lists models (GET …/models generates nothing either).
export async function resolveProviderBaseUrl({ api, baseUrl, headers }, apiKey, { timeout = 8000 } = {}) {
  if (api === GOOGLE) {
    const [versioned, entered] = googleCandidates(baseUrl);
    if (!entered) return versioned;
    const status = url => statusOf(fetch(`${url}/models`, { headers: requestHeaders(api, apiKey, headers), signal: AbortSignal.timeout(timeout) }));
    const [withVersion, without] = await Promise.all([status(versioned), status(entered)]);
    return withVersion === 404 && without && without !== 404 ? entered : versioned;
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

const toModel = m => typeof m === 'string' ? { id: m } : {
  id: m.id ?? m.name?.replace(/^models\//, ''),
  name: m.display_name ?? m.displayName ?? undefined,
  contextWindow: m.context_length ?? m.context_window ?? m.inputTokenLimit ?? undefined,
  maxTokens: m.max_output_tokens ?? m.outputTokenLimit ?? m.top_provider?.max_completion_tokens ?? undefined,
  ...(typeof m.thinking === 'boolean' ? { reasoning: m.thinking } : {}), // Gemini says which models think
};
const toModels = list => list.map(toModel).filter(m => m.id).sort((a, b) => a.id.localeCompare(b.id));

// Gemini lists its models a page at a time, among them models that only embed text or make images:
// only the ones that generate content are kept.
async function googleModels(base, apiKey, headers) {
  const models = [];
  let token;
  for (let page = 0; page < 20; page++) {
    const url = `${base}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const res = await fetch(url, { headers: requestHeaders(GOOGLE, apiKey, headers), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const detail = await res.json().then(body => body?.error?.message, () => undefined); // e.g. "API key not valid."
      throw new Error(`${res.status} ${res.statusText} from ${base}/models${typeof detail === 'string' ? `: ${detail}` : ''}`);
    }
    const body = await res.json();
    models.push(...(Array.isArray(body) ? body : body.models ?? body.data ?? []));
    token = body.nextPageToken;
    if (!token) break;
  }
  return models.filter(m => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.some(method => /generateContent$/i.test(method)));
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
    try {
      const res = await fetch(url, { headers: requestHeaders(api, apiKey, headers), signal: AbortSignal.timeout(15000) });
      if (!res.ok) { res.body?.cancel().catch(() => {}); lastError = telling(lastError, new Error(`${res.status} ${res.statusText} from ${url}`)); continue; }
      const body = await res.json();
      return toModels(Array.isArray(body) ? body : body.data ?? body.models ?? []);
    } catch (error) { lastError = telling(lastError, error); }
  }
  throw new Error(`Couldn't list models: ${lastError?.message ?? 'no response'}`);
}
