// Execution environments: this computer plus concrete Host aliases from the user's OpenSSH config.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, basename } from 'node:path';

const expandHome = path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

function globFiles(pattern, base) {
  const absolute = isAbsolute(pattern) ? pattern : join(base, pattern);
  if (!/[*?]/.test(absolute)) return [absolute];
  const dir = dirname(absolute);
  const re = new RegExp('^' + basename(absolute).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  try { return readdirSync(dir).filter(name => re.test(name)).sort().map(name => join(dir, name)); } catch { return []; }
}

// Returns [{ alias, hostName, user, port, source }] for concrete aliases (no wildcards / negations).
export function readSshHosts(configPath = join(homedir(), '.ssh', 'config')) {
  const hosts = new Map();
  const seen = new Set();
  const visit = file => {
    file = expandHome(file);
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try { if (!statSync(file).isFile()) return; text = readFileSync(file, 'utf8'); } catch { return; }
    let current = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/(^|\s)#.*$/, '').trim();
      if (!line) continue;
      const match = /^(\S+)\s*=?\s*(.*)$/.exec(line);
      if (!match) continue;
      const keyword = match[1].toLowerCase();
      const value = match[2].trim();
      if (keyword === 'include') {
        for (const pattern of value.split(/\s+/)) for (const included of globFiles(expandHome(pattern), join(homedir(), '.ssh'))) visit(included);
        continue;
      }
      if (keyword === 'match') { current = []; continue; }
      if (keyword === 'host') {
        current = value.split(/\s+/).filter(alias => alias && !/[*?!]/.test(alias));
        for (const alias of current) if (!hosts.has(alias)) hosts.set(alias, { alias, source: file });
        continue;
      }
      // OpenSSH semantics: the first value obtained for a keyword wins.
      for (const alias of current) {
        const entry = hosts.get(alias);
        if (keyword === 'hostname' && entry.hostName === undefined) entry.hostName = value;
        if (keyword === 'user' && entry.user === undefined) entry.user = value;
        if (keyword === 'port' && entry.port === undefined) entry.port = value;
      }
    }
  };
  visit(configPath);
  return [...hosts.values()];
}

const shortHost = name => name.length > 34 && name.includes('.') ? name.split('.')[0] + '…' : name;

// All environments: this computer, Host aliases from ~/.ssh/config, and hosts added by hand.
// `state` (settings.environments) marks which SSH hosts the user added and whether they are enabled.
export function listEnvironments({ sshConfig, customHosts = [], state = {} } = {}) {
  const config = sshConfig ? expandHome(sshConfig) : undefined;
  const local = { id: 'local', kind: 'local', label: 'This computer', added: true, enabled: true };
  const fromConfig = readSshHosts(config).map(host => ({
    id: `ssh:${host.alias}`,
    kind: 'ssh',
    source: 'config',
    label: host.alias,
    host: host.alias,
    // user@host:port as OpenSSH will connect (long proxy host names shortened to their first label).
    detail: !host.user && (host.hostName ?? host.alias) === host.alias
      ? (host.port && host.port !== '22' ? `Port ${host.port}` : 'SSH host')
      : `${host.user ? host.user + '@' : ''}${shortHost(host.hostName ?? host.alias)}${host.port && host.port !== '22' ? ':' + host.port : ''}`,
    sshArgs: config ? ['-F', config] : [],
  }));
  const manual = customHosts.map(h => ({
    id: `ssh:${h.id}`,
    kind: 'ssh',
    source: 'manual',
    label: h.label,
    host: h.host,
    detail: `${h.host}${h.port && String(h.port) !== '22' ? ':' + h.port : ''}`,
    sshArgs: [...(config ? ['-F', config] : []), ...(h.port ? ['-p', String(h.port)] : []), ...(h.identityFile ? ['-i', expandHome(h.identityFile)] : [])],
  }));
  const ssh = [...manual, ...fromConfig].map(env => ({ ...env, added: !!state[env.id]?.added, enabled: state[env.id]?.enabled !== false, root: state[env.id]?.root }));
  return [local, ...ssh];
}
