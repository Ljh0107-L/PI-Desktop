// Pi Desktop bridge extension. Runs inside every Pi process the desktop app starts, local or remote.
//
// 1. Reads the boot record that the launcher passed through stdin (never argv), registers the
//    user's providers with their API keys held only in this closure, and removes the record from
//    process.env so tool subprocesses (bash, etc.) cannot read the keys from their environment.
// 2. Adds an `ask_user` tool so the model can ask the person at the desktop a question — with
//    choices or free text — through the RPC extension-UI dialogs, which the desktop renders as a
//    question card. Tools run without approval prompts (Pi Desktop has a single "YOLO" mode).
import { Type } from 'typebox';

function literalKey(key) {
  // Pi treats "$NAME" and "!command" specially; "$$" and a leading "$!" are the documented escapes.
  const escaped = String(key).replace(/\$/g, '$$$$');
  return escaped.startsWith('!') ? '$' + escaped : escaped;
}

function modelDefaults(model) {
  return {
    name: model.id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...model,
  };
}

const text = value => ({ content: [{ type: 'text', text: value }], details: {} });

export default function pideskBridge(pi) {
  const raw = process.env.PIDESK_BOOT;
  delete process.env.PIDESK_BOOT;
  let boot = {};
  if (raw) {
    try { boot = JSON.parse(raw); } catch { process.stderr.write('pidesk: ignoring malformed boot record\n'); }
  }

  const register = providers => {
    for (const provider of providers ?? []) {
      const { id, apiKey, models, ...rest } = provider;
      const config = { ...rest };
      if (apiKey) config.apiKey = literalKey(apiKey);
      if (models) config.models = models.map(modelDefaults);
      pi.registerProvider(id, config);
    }
  };
  register(boot.providers);

  // Settings changed on the desktop (new key, model list…): re-register providers in this running Pi.
  // The payload is base64 JSON so keys never appear as readable text; extension commands are not
  // recorded in the session history.
  pi.registerCommand?.('pidesk-providers', {
    description: 'Pi Desktop: update providers',
    handler: async args => {
      try { register(JSON.parse(Buffer.from(String(args ?? '').trim(), 'base64').toString('utf8'))); }
      catch { process.stderr.write('pidesk: ignoring malformed provider update\n'); }
    },
  });

  pi.registerTool({
    name: 'ask_user',
    label: 'Ask user',
    description: 'Ask the user a question and wait for their answer. Use it when you need a decision, a preference, or information you cannot find yourself. Provide `options` when there are a few clear choices; the user can still answer in their own words.',
    promptSnippet: 'ask_user: ask the user a question (optionally with choices) and wait for the answer',
    promptGuidelines: ['Use ask_user only when you cannot proceed sensibly without the user; prefer finding answers yourself.'],
    parameters: Type.Object({
      question: Type.String({ description: 'The question, phrased for the user' }),
      options: Type.Optional(Type.Array(Type.String(), { description: 'Suggested answers, shortest first; omit for a free-text answer', maxItems: 8 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return text('Nobody is at the desktop to answer. Continue with your best judgement and state your assumption.');
      const options = (params.options ?? []).filter(Boolean);
      const answer = options.length ? await ctx.ui.select(params.question, options) : await ctx.ui.input(params.question, '');
      if (answer === undefined || answer === null || answer === '') return text('The user dismissed the question without answering.');
      return text(`The user answered: ${answer}`);
    },
  });
}
