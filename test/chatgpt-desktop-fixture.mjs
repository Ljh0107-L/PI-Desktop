// Injected only when both insecure test storage and PIDESK_CHATGPT_TEST are enabled.
// Exercises the real controller/vault/UI without opening a browser or contacting OpenAI.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { ChatGPTAuthHost } from '../agent/pidesk-chatgpt-auth.mjs';

export function chatGPTDesktopFixture(profile) {
  const original = openaiCodexProvider();
  const host = new ChatGPTAuthHost({ loadModels: async () => ({ getAuth: async () => { throw new Error('No inference in the OAuth UI fixture'); } }) });
  return {
    provider: { ...original, getModels: () => original.getModels().filter(m => ['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol'].includes(m.id)), auth: { oauth: {
      async login(interaction, options) {
        interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/fixture/authorize' });
        const input = await interaction.prompt({ type: 'manual_code' });
        if (input !== 'fixture-authorized') throw new Error('private fixture-refresh-token must not appear in the UI');
        return { type: 'oauth', access: `fixture-access-${options.getDeviceId()}`, refresh: `fixture-refresh-${options.getDeviceId()}`,
          expires: Date.now() + 3600000, clientId: options.getDeviceId(), scopes: ['chatgpt.tokens.use.direct'] };
      },
    } } },
    openExternal: async () => {}, probe: async () => {},
    run: (target, message) => host.handle({ ...message,
      ...(message.op === 'configure' ? { agentDir: join(profile, 'oauth-fixtures', createHash('sha256').update(target.env.id).digest('hex').slice(0, 12)) } : {}),
    }),
  };
}
