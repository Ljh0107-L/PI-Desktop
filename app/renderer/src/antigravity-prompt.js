// Match the adapter's encoded ACP prompt limit. Base64 is ASCII and needs no JSON escaping.
export const ANTIGRAVITY_IMAGE_LIMIT = 4 * 1024 * 1024;
const promptLimit = 6 * 1024 * 1024;
const encoder = new TextEncoder();
const jsonBytes = value => encoder.encode(JSON.stringify(value)).length;

export function antigravityPromptFits(text, attachments) {
  let bytes = 2; // array brackets
  let count = 0;
  if (text) { bytes += jsonBytes({ type: 'text', text }); count++; }
  for (const { kind, mimeType, data } of attachments) {
    if (kind !== 'image') continue;
    bytes += (count++ ? 1 : 0) + jsonBytes({ type: 'image', mimeType, data: '' }) + data.length;
  }
  return bytes <= promptLimit;
}
