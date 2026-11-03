// The agent files Pi loads (bridge, subagent), staged where Pi loads them fast.
//
// Pi loads extensions with jiti. A .js file that belongs to a "type": "module" package (this app's
// own package.json) is imported natively, so its @earendil-works/* and typebox imports resolve to
// node_modules: a second, unbundled copy of Pi compiled on every start, 1–6 s with Electron's Node
// before the first get_state answers. Outside such a package jiti transpiles the bridge and binds
// those imports to the modules Pi's bundle has already loaded (milliseconds), which is how SSH hosts
// have always run it. The package.json written beside the files ends the lookup there.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXTENSION_FILES = ['pidesk-subagent.mjs', 'pidesk-bridge.js'];
// Left by versions with the (removed) Cursor CLI engine.
export const OBSOLETE_FILES = ['cursor-acp.mjs', 'pidesk-cursor.mjs'];
export const EXTENSION_PACKAGE = '{"private":true}\n';

// Copies changed files atomically (a running relay may start a Pi at any moment) and returns the
// staged bridge path.
export function stageExtensions(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const files = [...EXTENSION_FILES.map(name => [name, readFileSync(join(sourceDir, name))]), ['package.json', Buffer.from(EXTENSION_PACKAGE)]];
  for (const [name, content] of files) {
    const dest = join(targetDir, name);
    let current = null;
    try { current = readFileSync(dest); } catch { /* first start */ }
    if (current?.equals(content)) continue;
    const temp = `${dest}.${process.pid}.tmp`;
    writeFileSync(temp, content, { mode: 0o644 });
    renameSync(temp, dest);
  }
  for (const name of OBSOLETE_FILES) rmSync(join(targetDir, name), { force: true });
  return join(targetDir, 'pidesk-bridge.js');
}
