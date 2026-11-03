// Offline test-only runtime layout matching the official Cursor package identity.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../core/transports.mjs';

export function mockCursorCommand(root, flags = []) {
  const dir = join(root, 'mock Cursor runtime');
  mkdirSync(dir, { recursive: true });
  const peer = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/cursor-peer.mjs');
  const command = join(dir, 'cursor-agent');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@anysphere/agent-cli-runtime' }));
  symlinkSync(process.execPath, join(dir, 'node'));
  symlinkSync(peer, join(dir, 'index.js'));
  writeFileSync(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(peer)} ${flags.map(shellQuote).join(' ')} "$@"\n`, { mode: 0o700 });
  return command;
}
