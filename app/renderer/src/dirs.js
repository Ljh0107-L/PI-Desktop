// Remote folder listings, cached per environment so the folder browser opens instantly.
import { api } from './store.js';

const cache = new Map(); // `${envId}\n${path}` -> { path, entries }
const inflight = new Map();
const keyOf = (envId, path) => `${envId}\n${path ?? '~'}`;

export const cachedDir = (envId, path) => cache.get(keyOf(envId, path)) ?? null;

export function listDir(envId, path) {
  const key = keyOf(envId, path);
  if (inflight.has(key)) return inflight.get(key);
  const promise = api('listDir', envId, path).then(result => {
    cache.set(key, result);
    cache.set(keyOf(envId, result.path), result);
    return result;
  }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// Warm the home folder and a few of its children in the background, one request at a time so
// prefetching never competes with what the user is doing.
export async function prefetchDir(envId, path) {
  try {
    const dir = await listDir(envId, path);
    for (const name of dir.entries.slice(0, 8)) {
      const child = `${dir.path.replace(/\/$/, '')}/${name}`;
      if (!cachedDir(envId, child)) await listDir(envId, child).catch(() => {});
    }
  } catch { /* host unreachable: the browser shows the error when opened */ }
}
