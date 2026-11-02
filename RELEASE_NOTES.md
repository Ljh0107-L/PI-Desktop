Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Existing installations can use **Check for Updates…**, then the **Update** button next to Settings.

## 0.1.18 — Updates without GitHub API quota

- **No more shared-IP API quota for updates.** Checks now fetch the public `releases/latest/download/latest-mac.yml` asset directly. No GitHub token, REST API call or quota-dependent fallback is used.
- **Version-pinned, verified downloads.** The ZIP URL is pinned to the version in that manifest, preventing a new release appearing mid-download from mixing versions. SHA-512 verification is retained, with strict manifest, filename and size validation.
- **Bounded requests and fresh checks.** Manifest and archive fetches have deadlines, overlapping checks are coalesced, and metadata requests bypass the local cache.
- **Regression coverage.** Added tests for both Mac architectures, an API-unavailable update with a real ZIP extraction, tampered/truncated downloads, invalid manifests and retryable network failures.

**One-time upgrade from 0.1.17 or earlier:** if the old app shows `GitHub returned 403`, download this release's DMG directly from the assets below, quit Pi Desktop, and replace the app in Applications. Settings and conversation files are stored separately. After that, automatic updates use the API-free method. Company-wide blocks on GitHub/download hosts are separate from the REST API limit and still need network access.

## Included from 0.1.17 — Connection lifecycle and stream recovery

- **No false “connection closed” toast when changing folders.** Cancelling a background pre-warm no longer reports a failed conversation, drops its replacement, or starts a process after that warm-up was cancelled. Genuine foreground startup errors remain visible.
- **`terminated` now reflects actual recovery.** Pi already retries interrupted model streams with bounded backoff. The desktop now shows the retry count instead of a permanent red error while that retry runs. Recovered attempts become neutral notices, including after reopening the conversation. A final failure after retry exhaustion still appears as an error; stopping cancels the retry.
- **Reliable relay shutdown and diagnostics.** Exit records drain before the attach process closes; the real Pi exit code, signal and stderr are preserved. Missing executables are reported promptly rather than left “running”. Malformed attach requests no longer crash the shared daemon.
- **Safer concurrent starts and stops.** Cold relay starts are serialized around stale-socket recovery. Stop acknowledgements wait for the old process to exit, with a forced-kill fallback, before a restart or file deletion proceeds. Failed or timed-out attaches release their transports.
- **Interrupt deadlines work even when abort hangs.** The four-second decision deadline now includes waiting for the abort RPC, followed by bounded process shutdown if necessary.
- **Failed forks cannot endanger the source.** A fork is published only after Pi confirms it has a separate session file. Cancellation does not leave a second conversation record pointing at the original file.
- **Keychain errors preserve saved keys.** A locked/denied Keychain no longer causes the master key to be replaced or legacy encrypted entries to be deleted. First-time creation cannot overwrite an item created by another launch.
- **Quitting closes model tunnels.** Active CONNECT sockets are explicitly closed so a live model connection cannot hold app shutdown indefinitely.
- **Regression coverage and release gate.** Added isolated lifecycle tests, real HTTP reset/premature-EOF recovery tests, and UI checks. Release packaging now waits for both CI suites, then verifies signatures and smoke-tests the packaged app.

A remote provider or gateway can still drop a stream. This release makes recovery observable and distinguishes it from a final failure; it does not promise to eliminate upstream outages. It does not modify your provider settings or delete existing conversation history.
