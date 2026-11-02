# Backend review — 0.1.17

Scope: desktop session manager, RPC client, local/SSH relay, remote setup, egress proxy, bridge, persistence, updater and CI/release lifecycle. This is a targeted code review with regressions, not a complete security audit.

## Fixed

| Priority | Finding | Fix / evidence |
| --- | --- | --- |
| P1 | A cancelled pre-warm's rejected start still emitted a visible error and its catch could delete a replacement under the same key. Closing during SSH preparation could spawn a late orphan. | Runtime ownership checks, identity-checked spare cleanup, silent background status and waiting for cancelled starts. Both races fail on 0.1.16 and pass after the fix. |
| P1 | Relay stop acknowledged before Pi exited; immediate restart could attach to the dying writer, and delete could race a final session-file write. | Stop is idempotent and acknowledges actual close, with TERM/KILL escalation. Regression uses a process that ignores EOF/TERM. |
| P1 | Fork persisted a record pointing at the source file before checking clone success/cancellation. Deleting that failed fork could delete the source file. | Publish only after a distinct clone file is confirmed; failure only detaches/stops the provisional process. |
| P1 | Interrupted-prompt fallback awaited abort before starting its four-second deadline. | Deadline now includes the abort RPC. Regression simulates a hung abort and checks the old process is replaced. |
| P2 | Attach called process.exit before stdout drained, and the RPC client classified child exit before reading remaining stdout. Real Pi failures became generic connection-closed errors. | Natural stdout flush, close-based classification, original Pi status/stderr preserved. |
| P2 | Spawn errors never updated relay liveness; malformed handshake objects could crash the daemon. Concurrent cold launchers raced stale socket recovery. | Close-based finalization, validated/contained handshakes, serialized startup with dead-owner recovery, EEXIST handling. |
| P2 | Timed-out startup leaked its attach process; diagnostic stderr grew without bound. | Failed-start cleanup, bounded stop escalation and bounded stderr retention. |
| P2 | Active CONNECT sockets could keep proxy close/app quit waiting forever; concurrent proxy creation could leak a server. | Explicit tracking/closing of both tunnel ends, rejected listen promises and shared in-flight proxy creation. |
| P2 | `terminated` was shown permanently as a final red error even after Pi successfully retried the stream. | Consume auto_retry events; show attempt count; use Pi's durable context-edit recovery markers in history. Final exhausted/authentication errors remain visible. |
| P1 | Keychain read/decryption failures could replace a master key or delete legacy ciphertext. | Fail closed except a genuine first-use item-not-found, never update an existing master during creation, and commit migration only after all entries succeed. Injected Keychain tests never access the real login Keychain. |
| P2 | Release tags packaged without requiring the full CI suites. E2E installation used a developer's home directory. | Reusable CI gate before packaging/publishing; isolated E2E remote installation and cleanup. |

## `terminated`: what is and is not fixed

The observed failure was an assistant `stopReason: error` with `errorMessage: terminated`. Pi persisted a recovery context edit and then a successful tool-use response in the same turn: retry had already worked, while the UI still displayed the old attempt as a final failure.

Pi 1.4.0 already recognizes `terminated` and premature Responses EOF as transient failures and defaults to three agent-level retries with backoff. This release deliberately does **not** add a second retry loop or replay the user's prompt. Real HTTP reset and premature-EOF tests verify recovery, bounded exhaustion, abort during backoff, no authentication retry, and no re-execution of an already completed tool.

An upstream provider/gateway can still disconnect. Fixing its transport policy or timeout requires provider-side diagnostics; a desktop release cannot guarantee that never happens.

## Remaining risks / follow-up

1. **High-priority dependency debt.** At review time, `npm audit --omit=dev` reports one high and two moderate affected package entries: Pi 1.4.0 pins undici 8.10.2 and minimatch 10.2.6. Advisories include `GHSA-2m5v-pch6-74hx`, `GHSA-xjj6-f33q-929c`, and `GHSA-g3hv-75wg-m249`. Patched undici/minimatch versions exist, but Pi's current latest package remains 1.4.0 and its distribution includes bundled undici code. An npm override alone would not replace that bundled copy. Follow up with an upstream rebuilt release or a separately reviewed reproducible Pi rebuild; do not claim an audit-clean dependency tree for 0.1.17. These findings do not demonstrate that every advisory is reachable through this application's configuration.
2. **Update trust is limited by ad-hoc signing.** Download checksums detect mismatched/corrupt release assets, but the manifest and asset share the same GitHub trust source. There is no independent Developer ID/notarization trust chain. Keep GitHub release permissions protected and plan signed/notarized releases.
3. **Existing daemon/Pi processes keep their loaded code.** Main-process UI/lifecycle fixes apply when updating the desktop, but a relay or Pi intentionally kept alive across updates runs its existing code until it exits. New daemon/process instances receive the updated implementation. A future versioned graceful handover should avoid interrupting active work.
4. **Resource/security review is not exhaustive.** Large JSONL buffers, long histories, disk-full/corrupt-store recovery and stronger IPC-origin validation remain useful follow-up work. This release does not promise exactly-once distributed tool execution under arbitrary crashes.

## Verification

- New backend + real-stream tests: 21 passing.
- Protocol: 19/19; relay: 16/16; latency: 39/39 within budget.
- Electron UI: 76/76, including cancelled pre-warms and recovered stream rendering.
- Four selected lifecycle regressions were run against 0.1.16: all four failed, confirming that the tests detect the old defects.
- Release pipeline additionally verifies code signatures and runs the packaged-app smoke test; GitHub Actions is the release verification source of truth.

Run `npm run test:backend` without SSH or model credentials. See README for the full suites.
