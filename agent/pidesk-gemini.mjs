// Gemini models behind custom endpoints whose model id doesn't say which Gemini they are.
//
// pi-ai's Gemini adapter reads the model's generation from its id: whether thinking is set with
// thinkingLevel (Gemini 3 and later) or thinkingBudget, whether tool results carry their call's id,
// whether tool calls are sampled strictly. Behind a custom endpoint the id can be anything, such as a
// Volcengine Ark endpoint id (ep-20261104202510-wbfrp): a Gemini 4 model then got thinkingBudget, which
// it refuses with a 400, at every thinking level including off. Such a model goes to the adapter under
// the Gemini model its id or display name names (gemini-4-argon, "Gemini 4 Argon"), with that model's
// thinking levels from Pi's catalog when Settings gives none; the request still names the endpoint's
// id, and so does the reply, so the conversation keeps the model it was started with.
import { AssistantMessageEventStream, getApiProvider } from '@earendil-works/pi-ai/compat';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';

export const GEMINI_API = 'google-generative-ai';
const catalogModel = id => getBuiltinModel('google', id);

// A Gemini or Gemma model name in a text: from its first "gemini" or "gemma", lowercase, with dashes.
const geminiName = text => {
  const slug = String(text ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, '-');
  const at = slug.search(/gemini|gemma/);
  return at < 0 ? '' : slug.slice(at).replace(/-+$/, '');
};

// The Gemini model a custom model is, when its id doesn't start with a Gemini name: the name found in
// its id (after a vendor prefix) or else its display name, shortened to the catalog model it extends
// ("gemini-4-argon-ark" is gemini-4-argon).
export function geminiAlias({ id, name } = {}, catalog = catalogModel) {
  if (/^(?:models\/)?(?:gemini|gemma)/i.test(String(id ?? ''))) return undefined;
  const found = geminiName(id) || geminiName(name);
  for (let prefix = found; prefix; prefix = prefix.replace(/-?[^-]*$/, '')) if (catalog(prefix)) return prefix;
  return found || undefined;
}

// The model as registered: with its alias's thinking levels when Settings gives none, so that the
// effort menu offers what the model accepts and off asks for its lowest level when it can't turn
// thinking off (Gemini 4 Argon accepts only low, medium and high).
export function geminiModel(model, catalog = catalogModel) {
  const alias = geminiAlias(model, catalog);
  const levels = alias && !model.thinkingLevelMap ? catalog(alias)?.thinkingLevelMap : undefined;
  return levels ? { ...model, thinkingLevelMap: levels } : model;
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// A provider's streamSimple (Pi routes its models' requests here) that sends each aliased model to the
// Gemini adapter under its alias: the earlier replies of this model under the alias too (they carry
// its thought signatures), the request body and the reply with the endpoint's id.
export function geminiStream(models, { adapter = () => getApiProvider(GEMINI_API), catalog = catalogModel } = {}) {
  const aliases = new Map(models.map(m => [m.id, geminiAlias(m, catalog)]).filter(([, alias]) => alias));
  return (model, context, options) => {
    const gemini = adapter();
    const alias = aliases.get(model.id);
    if (!alias) return gemini.streamSimple(model, context, options);
    const real = model.id;
    const messages = context.messages.map(m => m.role === 'assistant' && m.provider === model.provider && m.model === real ? { ...m, model: alias } : m);
    const inner = gemini.streamSimple({ ...model, id: alias }, { ...context, messages }, {
      ...options,
      onPayload: async params => { const sent = { ...params, model: real }; return (await options?.onPayload?.(sent, model)) ?? sent; },
      ...(options?.onProviderStreamEvent ? { onProviderStreamEvent: event => options.onProviderStreamEvent(event, model) } : {}),
    });
    const outer = new AssistantMessageEventStream();
    const relabel = message => { if (message?.model === alias) message.model = real; };
    (async () => {
      try {
        for await (const event of inner) { relabel(event.partial); relabel(event.message); relabel(event.error); outer.push(event); }
      } catch (error) {
        outer.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api, provider: model.provider, model: real,
          usage: emptyUsage(), stopReason: 'error', errorMessage: error?.message ?? String(error), timestamp: Date.now() } });
      }
      outer.end();
    })();
    return outer;
  };
}
