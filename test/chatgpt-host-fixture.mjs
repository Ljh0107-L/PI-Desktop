// CI worker: a separate host-local auth owner. Refreshes only against the test's loopback server.
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { ChatGPTAuthHost, serveChatGPT } from '../agent/pidesk-chatgpt-auth.mjs';

const [runDir, baseUrl] = process.argv.slice(2);
if (new URL(baseUrl).hostname !== '127.0.0.1') throw new Error('Loopback fixture only');
const host = new ChatGPTAuthHost({ loadModels: async (_piCli, credentials) => {
  const models = createModels({ credentials }), provider = openaiProvider();
  models.setProvider({ ...provider, auth: { oauth: { ...provider.auth.oauth,
    async refresh(credential, signal) {
      const response = await fetch(baseUrl + '/refresh', { method: 'POST', body: JSON.stringify({ refresh: credential.refresh }), signal });
      if (!response.ok) throw new Error('fixture refresh failed');
      return { ...credential, ...await response.json() };
    },
  } } });
  return models;
} });
await serveChatGPT(runDir, host);
process.stdout.write('ready\n');
