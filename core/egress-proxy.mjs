// Model egress through the desktop for SSH hosts that cannot reach a provider themselves
// (e.g. a provider on a corporate network the laptop is on but the server is not).
//
// A loopback-only HTTP CONNECT proxy that tunnels raw TCP to an allowlist of host:port pairs.
// The SSH session reverse-forwards a remote loopback port to it (ssh -R), and the remote Pi gets
// HTTPS_PROXY pointing there. TLS stays end-to-end between the remote Pi and the provider, so the
// desktop never sees request bodies or the API key in clear text.
import http from 'node:http';
import net from 'node:net';

export function startEgressProxy({ allow = [], port = 0 } = {}) {
  const allowed = new Set(allow.map(entry => entry.toLowerCase()));
  const stats = { tunnels: 0, rejected: [] };
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const server = http.createServer((req, res) => { res.writeHead(405).end('CONNECT only'); });
  server.on('connection', track);
  server.on('connect', (req, clientSocket, head) => {
    const target = String(req.url ?? '').toLowerCase();
    const match = /^([a-z0-9.-]+):(\d{1,5})$/.exec(target);
    if (!match || !allowed.has(target)) {
      stats.rejected.push(target);
      if (stats.rejected.length > 100) stats.rejected.shift();
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = track(net.connect(Number(match[2]), match[1], () => {
      stats.tunnels++;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }));
    const close = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('error', () => { if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); close(); });
    clientSocket.on('error', close);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      stats,
      allow: entries => { for (const entry of entries) allowed.add(entry.toLowerCase()); },
      // closeAllConnections does not cover upgraded CONNECT sockets. Destroy both
      // ends explicitly or quitting can wait forever on an active model tunnel.
      close: () => new Promise(r => { server.close(r); for (const socket of sockets) socket.destroy(); }),
    }));
  });
}

export const hostPortOf = url => { const u = new URL(url); return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`; };
