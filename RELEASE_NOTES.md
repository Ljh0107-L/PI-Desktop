Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Existing installations can use **Check for Updates…**, then the **Update** button next to Settings.

## 0.1.27 — Reliable file previews

- **Markdown images on the right machine.** Resolve SVG/PNG and other supported images relative to the document and read them through the session's local/SSH file API. Encoded spaces and Chinese paths work; large images fit the pane, refresh reloads image bytes, and missing/corrupt images show readable errors. SVG stays in an image element, never injected as active inline markup.
- **File browsing review fixes.** Switching tabs/sessions no longer shows stale content. Markdown links resolve from their document; heading anchors scroll the preview. Literal `%`/`#` filenames survive opening, normalized paths do not create duplicate tabs, and unknown-extension source no longer silently loses everything after 200K characters.
- **Safer local and SSH reads.** Remote home expansion and directory symlinks work; JSON/base64 transport preserves Unicode and newline filenames. Bounded reads respect short reads, reject non-regular files, preserve read errors, and avoid introducing malformed UTF-8 at the preview limit.
- **Less automatic delegation.** The main agent defaults to completing work directly. Subagents are for clearly bounded, substantial independent tasks with a concrete benefit, not routine discovery or small fixes.
- **Verified in GitHub CI only.** Local/SSH Electron regression fixtures and file-reading/path unit tests pass alongside the existing protocol, relay and backend suites. No tests, builds, installs or app launches were run on the user's workstation.

Cursor CLI integration is being developed separately; it is not included in this file-preview release.

## Included from 0.1.26 — Generation-only TPS

- **No request-average fallback.** Usage measures only source-observed first→last generation time, excluding TTFT, tool execution and completion trailers. The first chunk's estimated share of output is excluded too, rather than dividing already-arrived tokens by the remaining window.
- **Reasoning and answer windows match their tokens.** Fully streamed reasoning counts once. Hidden, summarized or redacted reasoning uses a separate **Answer generation** window and excludes reasoning tokens; unknown answer counts are explicitly estimated. An answer window spanning interleaved thinking is unavailable rather than mixing reasoning time with answer tokens.
- **Unknown stays unknown.** Old timing without first-chunk counters, short/buffered output and incomplete windows show `—`, never a request average or a previous call's speed. `~` denotes approximate client-observed throughput, not a provider's server-side decode measurement. Provider usage/cost totals remain unchanged, and trends compare matching generation scopes.
- **CI regressions.** Coverage includes long TTFT, delayed completion, first-chunk bursts, hidden/summary reasoning, replay/history, tool gaps and Usage card updates. Tests and UI launches run only in GitHub CI.

New counters require a newly started Pi process after updating; kept-alive processes are not force-restarted. Existing histories remain readable, but missing generation timing cannot be reconstructed.

## Included from 0.1.25 — Recover output-limited subagents and expose the bundled runtime

- **Output limits are not process crashes.** Subagents now identify `length` as the model response-token limit (reasoning included), retain per-response output/reasoning counts and the configured cap, and label the failure **Output limit**. Hidden-only exhaustion still produces an actionable diagnostic. Unexpected reasoning on a model configured with `reasoning: false` is reported, not silently reconfigured.
- **One safe, bounded recovery.** A length-truncated response always ends its low-level loop. The child may recover once with guidance to use smaller complete operations, preserving earlier successful tool results, model/thinking settings and the original deadline. Only the exact truncated turn is removed from its in-memory model context. A second limit stops clearly; no unlimited retries or larger hidden budgets. Clipped tool calls never execute and appear as **not executed**, not as running edits. Recovery remains best-effort when a gateway spends the whole cap on hidden reasoning.
- **Node is available to coding tools.** Local Electron-backed sessions expose a private `node` fallback using the bundled helper in Node mode; SSH sessions expose their actual Node runtime. Existing PATH entries retain precedence, and `"$PI_NODE"` explicitly selects Pi's runtime. No system Node/npm installation or shell-profile modification is performed. npm/npx are not supplied. Runtime facts are included in the prompt without granting permission to run local tests or GUI apps.
- **Bounded shell discovery.** Compatible child bash tools default to a 120-second timeout only when omitted; explicit timeouts and replacement-tool contracts are preserved. The batch deadline still wins and waits for actual cleanup. Timeout reports identify a blocked tool versus waiting on a model, and prompts discourage unbounded filesystem scans.
- **Strict tasks stay required.** A context-only call remains invalid; clearer guidance asks for `tasks: [{name, task}]` and incremental work rather than blindly repeating a failed large task.

Verification uses offline model streams and isolated GitHub CI runners, including an Electron app with system Node directories absent from PATH. No real model-quota test, local workstation test, service restart, user model-setting change or modification to the functional-test game's files is part of this release. New runtime/recovery logic requires a newly started Pi session; old records are not automatically rerun.

## Included from 0.1.24 — Subagent conversations and clearable task history

- **The same conversation interface.** Subagent details now reuse the main conversation renderer: the assignment is a message bubble, public replies are ordinary Markdown, and tools fold into compact work groups with the same disclosure and scrolling behavior. Removed the separate stack of large per-tool cards. This is a read-only execution view, not a new chat/model session.
- **Recorded arguments remain honest.** Expand tools to see the recorded command/arguments, output and file link. Truncated JSON is retained as recorded, not repaired into invented arguments or file diffs. Older result-only tasks and omitted trace records remain explicitly labelled.
- **Clear finished records.** The list's Clear button removes finished tasks from this session's task history; the detail header clears one finished task. Both ask for confirmation. Running/queued tasks cannot be cleared through the UI and remain visible even if stale clearing metadata mentions them.
- **Persistent, non-destructive cleanup.** Cleared rows and inspector entries stay cleared after reload/restart, and old delegation cards retain a neutral cleared-history summary. Main conversation/tool records, token usage and generated files are unchanged. This clears presentation history, not the underlying session JSONL. A failed settings save does not optimistically hide records.
- **Regression coverage.** CI covers trace projection, legacy data, malformed/truncated input, stable task identity after clearing, persistence/save failures, the shared conversation UI, confirmation cancellation and file/history preservation.

All tests and app launches run in GitHub CI, not on the user's workstation. Existing recorded subagents use the new interface after updating; missing execution history is not fabricated.

## Included from 0.1.23 — Let subagents finish useful work

- **No fixed model-turn cap.** Removed the 12-turn cutoff that could mark a healthy multi-step review or implementation as failed before it returned its report. The displayed turn count is informational only.
- **Cancellation and deadlines remain.** Tasks still stop on user cancellation, session shutdown, the selected batch deadline or a genuine terminal provider failure. Turn boundaries yield to cancellation timers, and new model requests are blocked once cancelled, even if a provider returns a late tool call. The concurrency limit and bounded transient retry policy are unchanged; completed tools are never replayed just to retry the model.
- **Collapsible Subagents list.** Click its plain-text heading to expand/collapse it like Usage. The small disclosure arrow remains, but the leading fork icon and empty-state helper text do not. Collapsing only hides the list; work and progress continue without reopening it automatically.
- **Regression coverage.** Offline CI covers a 26-turn successful task, a transient failure after 15 tool calls, cancellation after 12 turns, and deadline cancellation of an endless tool loop.

Start a new conversation after updating to load the new subagent implementation. Already failed tasks are not automatically rerun, and live sessions are not force-restarted.

## Included from 0.1.22 — Faster setup and trustworthy speed metrics

- **Less repeated connection work.** Revalidate cached SSH installation paths instead of rediscovering every Node installation and disk after an app restart. Matching installations skip npm/registry probes; changed bridge files upload in one operation. Remote setup overlaps catalog discovery and concurrent starts share one preparation. Provider changes remain serialized, and reconnects retain an existing model-egress tunnel.
- **Connection phases are visible.** Distinguish remote preparation, starting Pi and restoring session configuration rather than labelling all of them Connecting. Unchanged provider/model/thinking configuration avoids redundant RPCs; changed credentials cannot silently fall back to old keys.
- **Speed has an explicit denominator.** Capture generation counters inside Pi before SSH buffering and persist them with the final message. Usage distinguishes approximate **Stream avg** from full **Request avg**; replay, missing timing, hidden/summarized reasoning and one-chunk responses no longer masquerade as generation-only TPS. The trend compares the same model and timing basis. Estimates do not overwrite provider-reported totals.
- **Cursor bridge provenance.** The separately deployed bridge preserves reported zero cache/output counts, stops fabricating cached prefixes, and labels missing-usage estimates. Desktop records that metadata before SDK normalization, marks estimates and displays unknown cache measurements as `—`.
- **Cursor bridge reliability.** EOF/resets/deadlines before completion surface as errors rather than successful answers. Long reasoning is not ended by a 30-second socket read timeout. Send-window stalls are bounded, tool translation preserves required fields and binary safety, and independent requests do not share first-prompt-derived hidden state. The bridge source and offline Python tests now live under `integrations/cursor-quota-bridge`; desktop installation alone does not deploy it.
- **Plain Subagents heading.** Match Context/Usage typography, remove the fork icon and the empty-state helper text. Task inspection remains available.

Source timing/provenance recording requires a Pi process with the new extension: start a new conversation after updating. Older kept-alive processes and history use explicitly labelled request averages when source timing is unavailable; no running session is force-restarted. Private upstream protocol semantics and true server decode-only TPS cannot be independently verified by the desktop. Tests, UI checks and packaging run in GitHub CI, not on the user's workstation.

## Included from 0.1.21 — Inspect subagent execution

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
- **Cancellation and bounded work.** Stop and session shutdown cancel active/queued work. A batch defaults to a five-minute timeout (configurable up to fifteen minutes), with at most two retries for transient model failures. The original twelve-model-turn cap was removed in 0.1.23. Failure/truncation remains visible instead of being reported as success.
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
