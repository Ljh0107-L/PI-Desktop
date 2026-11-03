// Pinned official packages, verified from https://cursor.com/install.
// Pi never runs that installer: it replaces the user's global agent/Grok symlinks.
export const CURSOR_RUNTIME_VERSION = '2026.10.22-27dcf5f';
const targets = {
  'darwin-arm64': { size: 180412627, sha256: '2f5b0a3dd5fb951cecffac813867d8a08d810e59837d59fd5f12d69b922398d7' },
  'darwin-x64': { size: 188039979, sha256: '7a3cfbf0fcfb979b6213feb5f9fd10fbc7cd4e51ab28c3b572bb935e0b114961' },
  'linux-arm64': { size: 182799294, sha256: '22a36df9720830668ccd4d707e5190204ab9c8a0efb2f068cc914895f804d3ec' },
  'linux-x64': { size: 184859176, sha256: '85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294' },
};
export function cursorRelease(platform, arch) {
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error(`Cursor SDK does not support ${platform}/${arch}`);
  return { ...target, platform, arch, version: CURSOR_RUNTIME_VERSION, url: `https://downloads.cursor.com/lab/${CURSOR_RUNTIME_VERSION}/${platform}/${arch}/agent-cli-package.tar.gz` };
}
export const managedCursor = command => !command?.trim() || ['auto', 'managed', 'agent', '~/.local/bin/agent'].includes(command.trim());
