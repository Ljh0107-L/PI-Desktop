# Cursor quota bridge integration (deprecated)

The VMISS `cursor-quota.service` has been stopped and disabled at the user's request. The source is retained for reference and rollback. Pi Desktop no longer includes any Cursor engine: its Cursor CLI sessions were removed in 0.1.38. Desktop updates do not restart or redeploy this service.

This directory is a maintained, MIT-licensed snapshot of the Python `cursor2api`
service deployed on the user's VMISS host, with offline regression fixtures.
The deployed tree was not a Git checkout; its original source commit could not be
verified. No credentials, environment files, logs, conversation data or virtual
environment are included. It is not bundled into the desktop app and is not
automatically deployed by desktop updates.

The service exposes Anthropic Messages and OpenAI Chat Completions interfaces for
models the authenticated Cursor account is permitted to use. It does **not**
remove account quotas or grant access to unavailable models. The upstream private
protocol is unofficial and can change independently; review the service and the
account's terms before use. See `LICENSE` for the original MIT license.

## Dependencies and CI

Python 3.9+ and `requirements.txt`. The desktop CI runs offline tests on Python
3.9 and 3.12:

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p 'test_bridge_unit.py' -v
```

These fixtures do not bind sockets, call a model or require credentials. Tests,
builds and app launches for this change are performed in GitHub CI, not on the
user's workstation.

## Configuration

Keep the existing service environment outside this repository. Important keys:
`CURSOR_API_KEY`, `API_KEY` (client authentication), `CURSOR_AGENT_HOST`,
`CURSOR_CLI_VERSION`, `BIND`, `PORT`, `DEFAULT_MODEL`, `CURSOR_MODEL_ALLOW`.
Use a strong client key, loopback binding behind an authenticated TLS proxy, and
restrict model access to the account's intended quota models. `/login` now obeys
client authentication, and model allowlisting is enforced on execution as well
as catalog listing.

## Usage semantics

- Measured cache counters, including zero, are retained. Previous requests do not
  prove a cache hit. Cache subsets are bounded by the upstream prompt total.
- Tool-only turns may finish before upstream usage is available. Their visible
  prompt/output estimates have no invented fixed overhead or cached prefix.
- Both wire formats expose additive `usage.cursor2api` metadata:
  `{source: "upstream"|"estimated", cache: "reported"|"unknown"}`.
- Desktop 0.1.22 records that provenance before SDK normalization, marks estimated
  speed/counts, and shows unknown cache hit as `—`. Cursor thinking is a summary,
  not a reliable stream of all hidden reasoning tokens.
- Upstream token-field semantics are private; these numbers must not be treated
  as an independently verified account-billing or quota ledger.

## Lifecycle and isolation

An EOF, reset, idle timeout or hard deadline before completion is an error, not a
successful `end_turn`. Socket read timeouts no longer prematurely end long
reasoning; the session's bounded deadlines remain in force. HTTP/2 send-window
stalls are bounded. Drain admission and active counts are synchronized.

Each HTTP request has its own upstream conversation ID. The caller supplies full
history; independent chats/parallel branches with the same first prompt must not
share hidden state. This intentionally does not promise hidden server-state cache
reuse. Builtin-to-client tools are translated only when required fields are
available, and binary writes are not silently converted into corrupted text.

## Deployment and rollback

Deployment is separate from releasing the desktop. Compare the live source hashes
with the original snapshot before replacing anything. Stage reviewed files in an
immutable release directory, retain the previous release and existing credentials,
and wait for active requests to drain before switching the service. Do not overwrite
modules underneath a running process or force-kill active model requests. Verify
`GET /health` and service metadata after activation; those checks do not exercise
real model compatibility. Keep a rollback copy until the new service has been
observed in ordinary use. No live inference is required by CI or deployment.

Known limits: private-protocol compatibility, exact hidden-token accounting,
complete JSON Schema validation and stop sequences split across chunks are not
claimed fixed by this patch.
