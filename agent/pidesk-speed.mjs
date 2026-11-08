// Faster processing that providers sell for some models: the composer's Speed control.
//   OpenAI: service_tier "fast" (Fast mode, formerly Priority processing; the GPT-5.6 and GPT-6
//   models its guide names, Responses and Chat Completions) and "ultrafast" (GPT-6 Astra and
//   GPT-6.1 Sol, Responses API only). Both are billed per response: Fast at 2x, Ultrafast at 6x.
//   Anthropic: speed "fast" on Claude Opus 5.5, and on Opus 5 and Opus 4.8 in research preview
//   with a beta. Billed at 2x. A request at another speed misses the prompt cache.
// Shared by the desktop (which speeds a model offers) and the bridge (what each request asks for),
// so a conversation's speed never reaches a model without it, for example after a model switch.

export const SPEEDS = ['standard', 'fast', 'ultrafast'];
const OPENAI_FAST = /^gpt-(?:5\.6|6(?:\.\d+)?)-/;
const OPENAI_ULTRAFAST = new Set(['gpt-6-astra', 'gpt-6.1-sol']);
const ANTHROPIC_FAST = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']);
const ANTHROPIC_PREVIEW = new Set(['claude-opus-5', 'claude-opus-4-8']);
export const ANTHROPIC_FAST_BETA = 'fast-mode-2026-02-01';
// Rate limited or out of capacity at the faster speed: Anthropic answers 429 or 529.
const UNAVAILABLE = /rate.?limit|too many requests|overloaded|capacity|(?<![a-z0-9])(?:429|529)(?![a-z0-9])/i;
export const SPEED_COOLDOWN_MS = 5 * 60 * 1000;

// The speeds a model offers, standard first; none for models (and custom endpoints) without any.
export function speedOptions(model) {
  const { provider, api, id } = model ?? {};
  if (['openai', 'pidesk-chatgpt'].includes(provider) && OPENAI_FAST.test(id ?? '')) {
    if (api === 'openai-responses') return OPENAI_ULTRAFAST.has(id) ? [...SPEEDS] : ['standard', 'fast'];
    if (api === 'openai-completions') return ['standard', 'fast'];
  }
  if (provider === 'anthropic' && api === 'anthropic-messages' && ANTHROPIC_FAST.has(id)) return ['standard', 'fast'];
  return [];
}

// The speed a request gets: the one asked for, else the fastest slower one the model offers that
// isn't cooling down after a rate limit.
export function effectiveSpeed(wanted, offered, cooling = () => false) {
  for (let i = SPEEDS.indexOf(wanted); i > 0; i--) if (offered.includes(SPEEDS[i]) && !cooling(SPEEDS[i])) return SPEEDS[i];
  return 'standard';
}

// The request body at that speed, or undefined to leave it as it is.
export function withSpeed(payload, model, speed) {
  if (!speed || speed === 'standard' || !model || payload?.model !== model.id || !speedOptions(model).includes(speed)) return undefined;
  if (model.api !== 'anthropic-messages') return { ...payload, service_tier: speed };
  // pi-ai sends `betas` as the anthropic-beta header.
  const betas = ANTHROPIC_PREVIEW.has(model.id) ? { betas: [...new Set([...(payload.betas ?? []), ANTHROPIC_FAST_BETA])] } : {};
  return { ...payload, speed: 'fast', ...betas };
}

// The speed the provider says it used, from a raw stream event: OpenAI's response service_tier
// ("priority" for older models in Fast mode, "default" when it ran at standard speed) and
// Anthropic's usage.speed.
export function speedUsed(data) {
  const tier = data?.response?.service_tier ?? data?.service_tier ?? data?.message?.usage?.speed ?? data?.usage?.speed;
  if (typeof tier !== 'string' || tier === 'auto') return null;
  return tier === 'priority' ? 'fast' : tier === 'default' ? 'standard' : tier;
}

// The factor on the standard-rate cost Pi computed. pi-ai already prices OpenAI's Fast mode from
// the response's service tier; it knows neither Ultrafast nor Anthropic's fast mode.
export function extraCost(model, used) {
  if (model?.api === 'anthropic-messages' && used === 'fast') return 2;
  if (model?.api?.startsWith('openai-') && used === 'ultrafast') return 6;
  return 1;
}
const scaleCost = (cost, factor) => {
  const scaled = { ...cost };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) if (Number.isFinite(cost[key])) scaled[key] = cost[key] * factor;
  scaled.total = ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + (Number.isFinite(scaled[key]) ? scaled[key] : 0), 0);
  return scaled;
};

// A conversation's speed and its fallback. After a rate limit or overload at a faster speed, that
// speed rests for a few minutes and requests go one step slower (Pi retries the failed one), rather
// than failing the run; it doesn't switch back sooner, since every switch misses the prompt cache.
export function createSpeed({ speed = 'standard', now = Date.now } = {}) {
  let wanted = SPEEDS.includes(speed) ? speed : 'standard';
  const resting = new Map(); // speed -> until
  const cooling = s => (resting.get(s) ?? 0) > now();
  return {
    get speed() { return wanted; },
    set(next) {
      if (!SPEEDS.includes(next) || next === wanted) return;
      wanted = next;
      resting.clear();
    },
    // One request to `model`: the body to send (undefined: unchanged), then the provider's raw
    // stream events, then its finished message, returned with the speed and the cost it ran at.
    // Null when the conversation is at standard speed or the model offers no other.
    request(model, payload) {
      const offered = speedOptions(model);
      if (wanted === 'standard' || !offered.length || payload?.model !== model.id) return null;
      const requested = wanted, sent = effectiveSpeed(wanted, offered, cooling);
      // Slower than asked: the model doesn't offer that speed, or it is resting after a rate limit.
      const reason = sent === requested ? {} : { reason: offered.includes(requested) ? 'resting' : 'model' };
      let used = null;
      return {
        provider: model.provider, model: model.id,
        payload: withSpeed(payload, model, sent),
        event(data) { used = speedUsed(data) ?? used; },
        finish(message) {
          if (sent !== 'standard' && message?.stopReason === 'error' && UNAVAILABLE.test(message.errorMessage ?? '')) resting.set(sent, now() + SPEED_COOLDOWN_MS);
          const factor = extraCost(model, used ?? sent);
          const usage = factor !== 1 && message?.usage?.cost ? { usage: { ...message.usage, cost: scaleCost(message.usage.cost, factor) } } : {};
          return { ...message, ...usage, __speed: { requested, sent, ...reason, ...(used ? { used } : {}) } };
        },
      };
    },
  };
}
