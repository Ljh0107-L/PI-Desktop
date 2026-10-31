# M0 — Pi RPC technical spike

Goal: prove that one desktop process can drive several [Pi](https://github.com/earendil-works/pi) sessions at once — on this machine and on SSH hosts — with per-session multi-provider model selection, desktop-side tool approval, and API keys that stay owned by the desktop.

## What is here

| File | Role |
|---|---|
| [`core/pi-session.mjs`](../core/pi-session.mjs) | One Pi RPC process = one desktop session. JSONL framing, request/response correlation, event + approval (extension UI) channels. |
| [`core/transports.mjs`](../core/transports.mjs) | Local and SSH launchers. Both run the same POSIX `sh` bootstrap on the target. |
| [`agent/pidesk-bridge.js`](../agent/pidesk-bridge.js) | Pi extension loaded into every session: registers providers from the boot record, scrubs it from `process.env`, gates tool calls on desktop approval. |
| [`m0/mock-llm.mjs`](mock-llm.mjs) | Offline OpenAI-compatible streaming server; logs which bearer token reached which provider. |
| [`m0/verify.mjs`](verify.mjs) | The 18-check verification run. |
| [`m0/disconnect-probe.mjs`](disconnect-probe.mjs) | Shows what an SSH drop does to a remote run. |
| [`m0/test-sshd.sh`](test-sshd.sh) | Throwaway unprivileged sshd on 127.0.0.1 so the SSH path is tested for real. |

## How API keys travel (decision B: keys live on the desktop)

1. The desktop builds a boot record `{ providers: [{ id, api, baseUrl, apiKey, models }], permissionMode }`.
2. It starts `sh -c BOOTSTRAP …` locally or `ssh host 'sh -c BOOTSTRAP …'` and writes the boot record as the **first stdin line**. No secret is ever in argv on either machine.
3. The bootstrap `read`s that one line into `PIDESK_BOOT`, then `exec`s `pi --mode rpc`; the rest of stdin is the RPC stream.
4. `pidesk-bridge.js` parses the record, registers the providers with the literal keys held in its closure, and deletes `PIDESK_BOOT` from `process.env` before any tool runs.

## Run

```sh
npm install --ignore-scripts
node m0/verify.mjs                                   # both sessions local
sh m0/test-sshd.sh                                   # in another terminal
node m0/verify.mjs --ssh-host pidesk-test --ssh-config /tmp/pidesk-sshd/ssh_config
node m0/disconnect-probe.mjs --ssh-host pidesk-test --ssh-config /tmp/pidesk-sshd/ssh_config
```

Against a real server, pass `--ssh-host <alias>` plus `--remote-node` / `--remote-pi` absolute paths (non-interactive SSH shells usually lack `node` on `PATH`).

## Results (2026-10-30, Pi 1.4.0)

18/18 checks pass over a real SSH connection: concurrent streaming of two sessions, provider registration from the boot record, each provider receiving only its own key, switching provider mid-session, approval allowed (tool ran in the remote project) and denied (blocked, nothing written), no key in any argv / tool environment / session file, history via `get_messages`.

### Real environment (SCC + relay model)

[`m0/real-check.mjs`](real-check.mjs) against SSH host `SCC` (Linux x86_64, Node 22.23) with an OpenAI Responses-compatible relay model: **13/13 pass** — real streaming on both sessions concurrently, approval allow/deny on the server, tool output from the server (`hostname`, cwd), no key in argv on either machine, in tool environments or in session files.

SCC cannot resolve the relay's corporate domain, so `--egress` routes the remote model traffic back through the Mac: [`core/egress-proxy.mjs`](../core/egress-proxy.mjs) is a loopback CONNECT proxy restricted to the provider's `host:port`, reached through `ssh -R` on the session's own connection; the remote Pi uses `HTTPS_PROXY` (Pi's undici `EnvHttpProxyAgent` tunnels with CONNECT), so TLS stays end-to-end and the Mac never sees the key or request bodies. The forwarded port is bound to the server's loopback, so other users on that server could also reach the (allowlisted) provider through it while the session is open; they would still need a key.

Remote setup used: Pi 1.4.0 in `~/.pidesk/pi` (npm, `--ignore-scripts`), bridge at `~/.pidesk/ext/pidesk-bridge.js`, agent dir `~/.pidesk/agent`. Remove everything with `rm -rf ~/.pidesk`.

## Known limits found

- **SSH drop kills the remote run.** The probe shows the remote Pi process and its in-flight tool die when the link drops. "Close the laptop, keep working" needs the M3 remote relay that owns Pi processes and replays events on reconnect.
- **Key exposure on the remote host** is the same class as Claude Desktop's 3P SSH mode: the key is in the Pi process's memory, and on Linux the initial environment block (`/proc/<pid>/environ`) stays readable by the same user and root even after `delete process.env.PIDESK_BOOT`. Only connect hosts you trust; prefer short-lived keys.
- **Remote prerequisites.** `node`, Pi and the bridge extension must exist on the host; non-interactive SSH `PATH` usually lacks `node`. M3 should install them under `~/.pidesk/`.
- Pi sets its process title to `pi`, so process discovery must not rely on argv.
- With egress through the Mac, the remote session also loses its model when the laptop disconnects; hosts that can reach the provider directly do not need it.
