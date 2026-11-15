// Native Gemini streaming for models with streamed function arguments. pi-ai's current
// adapter only accepts complete args; keep its request conversion, but own the wire stream.
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AssistantMessageEventStream, calculateCost, clampThinkingLevel, collapseSystemMessages, getCurrentTools, getInitialSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai/compat';
import { GooglePartialArgs } from './pidesk-google-args.mjs';

// Staged extensions live outside node_modules. Resolve the pinned, exported helpers from
// Pi's executable when necessary; they are pure converters, not a second agent runtime.
let helpers;
async function googleHelpers() {
  if (!helpers) helpers = (async () => {
    let packageFile;
    for (const anchor of [import.meta.url, process.argv[1] && pathToFileURL(process.argv[1])].filter(Boolean)) {
      try { packageFile = findPackageJSON('@earendil-works/pi-ai', anchor); if (packageFile) break; } catch { /* try Pi's installation */ }
    }
    if (!packageFile) throw new Error('Cannot resolve the pinned Google protocol helpers');
    const load = name => import(new URL(`dist/${name}.js`, pathToFileURL(packageFile)).href);
    const [shared, simple, retry, headers, identity] = await Promise.all([
      load('api/google-shared'), load('api/simple-options'), load('utils/provider-retry'), load('utils/headers'), load('utils/identity'),
    ]);
    return { ...shared, ...simple, ...retry, ...headers, ...identity };
  })();
  return helpers;
}
export const streamsGoogleArguments = model => /^(?:models\/)?gemini-4-(argon|carbon)(?:-|$)/i.test(model.id);
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const incomplete = text => new Error(`Google stream ${text}`);

async function* events(response) {
  if (!response.body) throw incomplete('ended without a response body');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', data = [], size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 32 * 1024 * 1024) throw incomplete('event exceeds the 32 MiB limit');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
        if (line.startsWith('data:')) {
          size += line.length;
          if (size > 32 * 1024 * 1024) throw incomplete('event exceeds the 32 MiB limit');
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (!line && data.length) {
          const raw = data.join('\n'); data = []; size = 0;
          if (raw === '[DONE]') return;
          yield JSON.parse(raw);
        }
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
        if (data.length && data.join('\n') !== '[DONE]') yield JSON.parse(data.join('\n'));
        return;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function responseError(response, signal) {
  // Gateways sometimes leave error bodies open or advertise an inflated Content-Length.
  // Bound diagnostics independently, classify known errors, and never echo the raw body.
  const reader = response.body?.getReader();
  let text = '', timer;
  const cancel = () => { reader?.cancel().catch(() => {}); };
  try {
    timer = setTimeout(cancel, 1000);
    signal.addEventListener('abort', cancel, { once: true });
    if (reader) {
      const decoder = new TextDecoder();
      while (text.length < 16384 && !signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        try { JSON.parse(text); break; } catch { /* bounded partial JSON */ }
      }
    }
  } catch { /* the status is enough when a body cannot be read */ }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); cancel(); reader?.releaseLock(); }
  let detail;
  try { detail = JSON.parse(text)?.error; } catch { /* non-JSON error */ }
  const code = String(detail?.code ?? '');
  let status = response.status;
  if (status === 400 && code === 'InvalidParameter' && String(detail?.message).startsWith('429: TPM quota exhausted.')) status = 429;
  const overflow = [400, 413].includes(status) && /context_length_exceeded|context window|maximum context length|too many (?:input )?tokens/i.test(String(detail?.message));
  const label = overflow ? 'context_length_exceeded' : /^[-\w.:]{1,128}$/.test(code) ? code : '';
  const error = new Error(`Google HTTP ${status}${label ? ` (${label})` : ''}`);
  error.status = status; error.headers = response.headers;
  return error;
}

export function streamGoogle(model, context, options = {}) {
  const stream = new AssistantMessageEventStream();
  const output = { role: 'assistant', content: [], api: 'google-generative-ai', provider: model.provider, model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now() };
  const emit = (type, fields = {}) => stream.push({ type, ...fields, partial: output });
  (async () => {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let timer, iterator, activeCall = null, textBlock = null, textIndex = -1;
    const timeout = options.timeoutMs ?? 300000;
    // One deadline per parsed event (not for the whole generation). SSE comments do not
    // masquerade as model progress; continuations and active long writes stay alive.
    const wait = async operation => {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Request aborted');
      if (timeout > 0) timer = setTimeout(() => controller.abort(new Error(`Google stream idle timeout after ${timeout} ms`)), timeout);
      try { return await operation(); } finally { clearTimeout(timer); }
    };
    const endText = () => {
      if (textBlock) emit(textBlock.type === 'thinking' ? 'thinking_end' : 'text_end', { contentIndex: textIndex, content: textBlock.thinking ?? textBlock.text });
      textBlock = null;
    };
    const completedCalls = [];
    const ids = new Set();
    const startCall = part => {
      endText();
      const call = part.functionCall;
      if (!call.name) throw incomplete('contained a tool fragment without a call name');
      const id = call.id || `call_${crypto.randomUUID()}`;
      if (ids.has(id)) throw incomplete('contained a duplicate tool call ID');
      ids.add(id);
      const block = { type: 'toolCall', id, name: call.name, arguments: {}, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
      const index = output.content.push(block) - 1;
      emit('toolcall_start', { contentIndex: index });
      return { block, index, providerId: call.id, args: new GooglePartialArgs() };
    };
    try {
      const h = await googleHelpers();
      if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
      const wireModel = { ...model, id: model.id.replace(/^models\//, '') };
      const normalized = collapseSystemMessages({ ...context, messages: context.messages.map(m =>
        m.role === 'assistant' && m.provider === model.provider && m.model === model.id ? { ...m, model: wireModel.id } : m) });
      const base = h.buildBaseOptions(wireModel, normalized, options, options.apiKey);
      const tools = getCurrentTools(normalized.messages), initial = getInitialSystemMessage(normalized.messages);
      const strict = h.supportsGoogleStrictToolSampling(wireModel.id);
      const config = { maxOutputTokens: base.maxTokens,
        ...(base.temperature !== undefined ? { temperature: base.temperature } : {}),
        ...(initial ? { systemInstruction: getSystemMessageText(initial) } : {}),
        ...(tools.length ? { tools: h.convertTools(tools, false, strict) } : {}),
      };
      if (tools.length) config.toolConfig = { functionCallingConfig: {
        mode: h.resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict),
        ...(streamsGoogleArguments(model) ? { streamFunctionCallArguments: true } : {}),
      } };
      if (model.reasoning) {
        const level = clampThinkingLevel(model, options.reasoning ?? 'off');
        config.thinkingConfig = level === 'off' ? h.getDisabledGoogleThinkingConfig(model)
          : { includeThoughts: true, thinkingLevel: h.toGoogleThinkingLevel(h.resolveGoogleThinkingLevel(model, level)) };
      }
      let params = { model: model.id, contents: h.convertMessages(wireModel, normalized), config };
      params = (await options.onPayload?.(params, model)) ?? params;
      const { systemInstruction, tools: declarations, toolConfig, ...generationConfig } = params.config;
      let body = { contents: params.contents, generationConfig,
        ...(systemInstruction ? { systemInstruction: typeof systemInstruction === 'string' ? { parts: [{ text: systemInstruction }] } : systemInstruction } : {}),
        ...(declarations ? { tools: declarations } : {}), ...(toolConfig ? { toolConfig } : {}),
      };
      let headers = new Headers(h.providerHeadersToRecord(h.getIdentityHeaders(model, options.identity), model.headers, options.headers));
      headers.set('content-type', 'application/json'); headers.set('x-goog-api-key', options.apiKey);
      if (options.transformHeaders) headers = new Headers((await options.transformHeaders(headers)) ?? headers);
      const root = (model.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      const endpoint = `${root}/models/${encodeURIComponent(params.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`;
      let started = false, finish, hops = 0, totals = usage();
      const tokens = new Set();
      while (true) {
        let hopUsage;
        const response = await h.retryProviderRequest(async () => {
          const res = await wait(() => (options.fetch ?? globalThis.fetch)(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal }));
          await options.onResponse?.({ status: res.status, headers: Object.fromEntries(res.headers) }, model);
          if (!res.ok) {
            throw await responseError(res, controller.signal);
          }
          return res;
        }, { ...options, maxRetries: options.maxRetries ?? 5, signal: controller.signal });
        if (!started) { emit('start'); started = true; }
        iterator = events(response)[Symbol.asyncIterator]();
        let continuation;
        finish = undefined;
        while (true) {
          const next = await wait(() => iterator.next());
          if (next.done) break;
          const chunk = next.value;
          await options.onProviderStreamEvent?.(chunk, model);
          if (chunk.error) {
            const status = Number(chunk.error.code);
            throw new Error(`Google provider error${Number.isFinite(status) ? ` (${status})` : ''}`);
          }
          output.responseId ||= chunk.responseId;
          if (chunk.candidates?.[0]?.continuationToken || chunk.continuationToken) continuation = chunk.candidates?.[0]?.continuationToken ?? chunk.continuationToken;
          if (chunk.usageMetadata) hopUsage = chunk.usageMetadata;
          if (chunk.candidates?.length > 1) throw incomplete('returned multiple candidates');
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) finish = candidate.finishReason;
          if (chunk.promptFeedback?.blockReason && chunk.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') throw new Error('Google prompt blocked by safety policy');
          for (const part of candidate?.content?.parts ?? []) {
            if (part.functionCall) {
              const call = part.functionCall;
              activeCall ??= startCall(part);
              const { block, index, args } = activeCall;
              if ((call.name && call.name !== block.name) || (call.id && activeCall.providerId && call.id !== activeCall.providerId)) throw incomplete('changed an unfinished tool call identity');
              if (call.id && !activeCall.providerId) {
                if (ids.has(call.id)) throw incomplete('contained a duplicate tool call ID');
                ids.delete(block.id); ids.add(call.id); block.id = call.id; activeCall.providerId = call.id;
              }
              if (part.thoughtSignature) {
                if (block.thoughtSignature && block.thoughtSignature !== part.thoughtSignature) throw incomplete('changed a tool thought signature');
                block.thoughtSignature = part.thoughtSignature;
              }
              if (call.args !== undefined && (call.partialArgs !== undefined || call.willContinue || args.fragments.length)) throw incomplete('mixed complete and partial tool arguments');
              if (call.args !== undefined) {
                if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) throw incomplete('contained invalid tool arguments');
                block.arguments = call.args;
                emit('toolcall_delta', { contentIndex: index, delta: JSON.stringify(call.args) });
              } else {
                for (const arg of call.partialArgs ?? []) {
                  const delta = args.feed(arg);
                  if (delta) emit('toolcall_delta', { contentIndex: index, delta });
                }
                if (!call.willContinue) {
                  const result = args.finish(); block.arguments = result.args;
                  emit('toolcall_delta', { contentIndex: index, delta: result.suffix });
                }
              }
              if (!call.willContinue) { completedCalls.push(activeCall); activeCall = null; }
            } else if (part.text !== undefined || part.thoughtSignature) {
              if (activeCall) throw incomplete('interrupted unfinished tool arguments');
              const thinking = part.thought === true, type = thinking ? 'thinking' : 'text', key = thinking ? 'thinking' : 'text';
              if (!textBlock || textBlock.type !== type || textBlock.thinkingSignature || textBlock.textSignature || part.thoughtSignature) {
                endText(); textBlock = { type, [key]: '' }; textIndex = output.content.push(textBlock) - 1;
                emit(`${type}_start`, { contentIndex: textIndex });
              }
              textBlock[key] += part.text ?? '';
              if (part.thoughtSignature) textBlock[thinking ? 'thinkingSignature' : 'textSignature'] = part.thoughtSignature;
              if (part.text) emit(`${type}_delta`, { contentIndex: textIndex, delta: part.text });
            } else throw new Error('Google returned an unsupported output modality');
          }
        }
        iterator = null;
        if (hopUsage) {
          const cache = hopUsage.cachedContentTokenCount || 0;
          totals.input += (hopUsage.promptTokenCount || 0) + (hopUsage.toolUsePromptTokenCount || 0) - cache;
          totals.cacheRead += cache; totals.reasoning += hopUsage.thoughtsTokenCount || 0;
          totals.output += (hopUsage.candidatesTokenCount || 0) + (hopUsage.thoughtsTokenCount || 0);
          totals.totalTokens += hopUsage.totalTokenCount || (hopUsage.promptTokenCount || 0) + (hopUsage.toolUsePromptTokenCount || 0) + (hopUsage.candidatesTokenCount || 0) + (hopUsage.thoughtsTokenCount || 0);
          output.usage = { ...totals }; calculateCost(model, output.usage);
        }
        if (finish !== 'CONTINUATION') break;
        if (generationConfig.maxOutputTokens && totals.output >= generationConfig.maxOutputTokens) { finish = 'MAX_TOKENS'; break; }
        if (!continuation || tokens.has(continuation) || ++hops > 64) throw incomplete('ended without a fresh continuation token');
        tokens.add(continuation);
        body = { ...body, continuationToken: continuation };
      }
      endText();
      output.rawStopReason = finish;
      if (finish !== 'STOP' && finish !== 'MAX_TOKENS') throw incomplete(finish ? `stopped with ${finish}` : 'ended without a finish reason');
      if (activeCall || (completedCalls.length && finish !== 'STOP')) throw incomplete(finish === 'MAX_TOKENS' ? 'exhausted its output budget during a tool call' : 'ended with unfinished tool arguments');
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Request aborted');
      for (const { index, block } of completedCalls) emit('toolcall_end', { contentIndex: index, toolCall: block });
      output.stopReason = completedCalls.length ? 'toolUse' : finish === 'MAX_TOKENS' ? 'length' : 'stop';
      stream.push({ type: 'done', reason: output.stopReason, message: output });
    } catch (error) {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      const cause = controller.signal.aborted ? controller.signal.reason : error;
      output.errorMessage = cause?.message || error?.message || String(error);
      if (error?.cause?.code) output.errorMessage += ` (${error.cause.code})`;
      stream.push({ type: 'error', reason: output.stopReason, error: output });
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      controller.abort();
      await iterator?.return?.().catch(() => {});
      stream.end();
    }
  })();
  return stream;
}
