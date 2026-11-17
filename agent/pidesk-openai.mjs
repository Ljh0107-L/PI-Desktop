// OpenAI-compatible gateways can finish successfully without returning any answer text.
// Pi's compactor accepts that as an empty checkpoint and drops the summarized context.
// Reject empty successes at the provider boundary; keep Pi's conversion, retries and usage.
import { AssistantMessageEventStream, getApiProvider } from '@earendil-works/pi-ai/compat';

export const OPENAI_APIS = ['openai-responses', 'openai-completions'];

export function openaiStream(model, context, options) {
  const inner = getApiProvider(model.api).streamSimple(model, context, options);
  const outer = new AssistantMessageEventStream();
  (async () => {
    try {
      for await (const event of inner) {
        if (event.type === 'done' && event.message.stopReason === 'stop' &&
            !event.message.content.some(block => block.type === 'toolCall' || (block.type === 'text' && block.text?.trim()))) {
          const message = { ...event.message, stopReason: 'error', errorMessage: 'OpenAI-compatible endpoint returned an empty response (no answer text). Please retry.' };
          outer.push({ type: 'error', reason: 'error', error: message });
        } else outer.push(event);
      }
    } catch (error) {
      outer.push({ type: 'error', reason: options?.signal?.aborted ? 'aborted' : 'error', error: {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error?.message ?? String(error),
      } });
    }
    outer.end();
  })();
  return outer;
}
