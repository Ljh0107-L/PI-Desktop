Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Existing installations can use **Check for Updates…**, then the **Update** button next to Settings.

## 0.1.21 — Inspect subagent execution

- **Click into a task's execution.** Subagents now have a standalone summary card in the main conversation and a task list on the right. Select a task to see its live tool calls, commands/arguments, text output, error states, durations and public messages, with its assignment and final result.
- **A cleaner right panel.** Removed Environment and Outputs. Context and Usage remain alongside the Subagents list. Files are still accessible through the header's Files button and Open file links in execution steps; no workspace files are removed.
- **No window or focus surprises.** Inspection happens in the existing, resizable right panel. New activity does not switch away from an open file preview. The selected task stays selected across updates, and manual scrolling pauses following until Latest activity is clicked.
- **Execution history stays available.** Completed traces are saved with the parent result and can be reopened after restarting the app. Per-child traces are bounded to 80 steps / 64 KiB, with explicit truncation/omission notices and throttled live updates. Hidden thinking, inherited prompts and image bodies are not added to the trace.
- **Older tasks remain readable.** A task from 0.1.20 that saved only its result displays that result with an explanatory notice; missing execution history is not invented.

New trace recording requires a Pi process running the updated extension. Start a new conversation after updating if the old conversation's Pi has been kept alive. All regression, UI and packaging checks run in GitHub CI.

## Included from 0.1.20 — Subagents and delegation guidance

- **Delegate focused subtasks.** The new `subagent` tool accepts 1–6 named tasks, with at most 3 active subagents per parent session, including overlapping calls. Each uses an independent context, the parent's selected model/reasoning level and its available coding tools.
- **No extra app windows or Pi subprocesses.** Agents run inside the owning Pi process. Tool calls go through the parent tool pipeline, on the parent's machine and working directory; subagents cannot call the delegation, goal or question tools.
- **Progress and results in the conversation.** Expand the Subagents tool to inspect each task's state, output, turns and token usage. Delegated writes appear in Outputs, and child-model usage is included without inflating the main model's TPS.
- **Cancellation and bounded work.** Stop and session shutdown cancel active/queued work. A batch defaults to a five-minute timeout (configurable up to fifteen minutes), each task has a twelve-model-turn limit and at most two retries for transient model failures. Failure/truncation remains visible instead of being reported as success.
- **Prompt support is built in.** The main system prompt explains when to delegate, what context and user constraints to pass, how to avoid overlapping file edits, and how to verify/integrate results. Child prompts preserve parent instructions and include user-context excerpts, while excluding the parent assistant/tool transcript.

Subagents share files and are not isolated worktrees or an OS sandbox. Use focused tasks with disjoint ownership; passing a task to another agent never grants additional permission to test locally, launch GUI apps or publish. Existing Pi processes kept alive across app updates retain their loaded extensions: start a new conversation to use the new tool without interrupting ongoing work.

## Included from 0.1.19 — One No folder sidebar group per machine

- **No folder conversations stay together.** All projectless conversations on the same computer or SSH environment now appear under one No folder group, even when their working directories differ. Previously each generated directory produced another identically named group.
- **No conversation or file migration.** Each chat keeps its own history, workspace and outputs. Existing projectless chats and forks are grouped immediately; ordinary projects remain grouped by directory, including real folders named “No folder”.
- **Stable grouping and regression coverage.** Collapsing the group hides all its chats together; its identity stays stable when the newest chat changes. Added unit and Electron UI tests covering multiple chats, reload, archive, separate environments and independent histories/directories.

## Included from 0.1.18 — Updates without GitHub API quota

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
