// OpenAI-compatible gateways can finish successfully without returning any answer text.
// Pi's compactor accepts that as an empty checkpoint and drops the summarized context.
// Reject empty successes at the provider boundary; keep Pi's conversion, retries and usage.
import { AssistantMessageEventStream, getApiProvider } from '@earendil-works/pi-ai/compat';

export const OPENAI_APIS = ['openai-responses', 'openai-completions'];

export function openaiStream(model, context, options, speed) {
  let request = null;
  // Agent turns and subagents set their tier in onPayload and account for it themselves.
  // Summaries bypass those hooks. Supply the conversation's speed only when the caller
  // leaves the tier unset, with request-local accounting for concurrent background calls.
  const requestOptions = speed ? {
    ...options,
    onPayload: async (payload, m) => {
      const next = (await options?.onPayload?.(payload, m)) ?? payload;
      request = next.service_tier === undefined ? speed.request(model, next) : null;
      return request?.payload ?? next;
    },
    onProviderStreamEvent: async (data, m) => {
      request?.event(data);
      await options?.onProviderStreamEvent?.(data, m);
    },
  } : options;
  const inner = getApiProvider(model.api).streamSimple(model, context, requestOptions);
  const outer = new AssistantMessageEventStream();
  (async () => {
    try {
      for await (const original of inner) {
        let event = original;
        if (event.type === 'done' && event.message.stopReason === 'stop' &&
            !event.message.content.some(block => block.type === 'toolCall' || (block.type === 'text' && block.text?.trim()))) {
          const message = { ...event.message, stopReason: 'error', errorMessage: 'OpenAI-compatible endpoint returned an empty response (no answer text). Please retry.' };
          event = { type: 'error', reason: 'error', error: message };
        }
        if (request && (event.type === 'done' || event.type === 'error')) {
          const key = event.type === 'done' ? 'message' : 'error';
          event = { ...event, [key]: request.finish(event[key]) };
          request = null;
        }
        outer.push(event);
      }
    } catch (error) {
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error?.message ?? String(error),
      };
      outer.push({ type: 'error', reason: message.stopReason, error: request ? request.finish(message) : message });
    }
    outer.end();
  })();
  return outer;
}
