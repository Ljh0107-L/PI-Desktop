// Public Release assets do not use GitHub's shared-IP REST API quota.
import { parseDocument } from 'yaml';

const RELEASES = 'https://github.com/Ljh0107-L/PI-Desktop/releases';
export const UPDATE_MANIFEST_URL = `${RELEASES}/latest/download/latest-mac.yml`;
export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024;

export function parseUpdateManifest(text, arch = process.arch) {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('The update manifest is too large');
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error('The update manifest is not valid YAML');
  let manifest;
  try { manifest = document.toJS({ maxAliasCount: 0 }); }
  catch { throw new Error('The update manifest must not contain aliases'); }
  const version = manifest?.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || !version.split('.').every(n => Number.isSafeInteger(Number(n)))) throw new Error('The update manifest has an invalid release version');
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`No update build for architecture ${arch}`);
  const name = `Pi-Desktop-${version}-${arch}-mac.zip`;
  // Accept only our exact asset filename, never an arbitrary URL or filesystem path.
  const candidates = Array.isArray(manifest.files) ? manifest.files.filter(f => f?.url === name) : [];
  if (candidates.length !== 1) throw new Error(`The update manifest must contain one ${arch} build`);
  const { sha512, size } = candidates[0];
  if (typeof sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)
    || Buffer.from(sha512, 'base64').toString('base64') !== sha512) throw new Error('The update manifest has an invalid SHA-512 checksum');
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPDATE_BYTES) throw new Error('The update manifest has an invalid download size');
  // Pin the version from this manifest: /latest may advance while the ZIP downloads.
  return { version, sha512, asset: { name, size, browser_download_url: `${RELEASES}/download/v${version}/${name}` } };
}
