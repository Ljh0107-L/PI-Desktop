// Keep old subscription selections explicit: removing a feature must never select a paid API instead.
export const isRetiredProvider = id => id === 'pidesk-chatgpt';
export const RETIRED_PROVIDER_MESSAGE = 'ChatGPT subscriptions were removed. Select another model explicitly in Settings → Models to continue. Existing history is preserved.';
