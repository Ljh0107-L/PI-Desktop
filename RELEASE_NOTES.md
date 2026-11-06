Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Existing installations can use **Check for Updates…**, then the **Update** button next to Settings.

## 0.2.0 — Ultra

- **Ultra mode.** Turn on Ultra under the message box, hand Pi a request and walk away: it works on it on its own until it is done, for hours if it takes that, with your full trust. It never stops to ask; a question gets "nobody is here: decide and note the assumption". While the request is unfinished it starts its next turn itself, and it waits out provider errors, 30 seconds growing to 10 minutes, for as long as they last. It keeps a progress log (done, next, assumptions) that is carried into every turn, so nothing is lost when the context is compacted. To finish, it audits its work against the request and then has to pass an independent review: a fresh agent that runs the checks but can't edit, and whose findings send it back to work. If its turns stop making progress it gets a nudge, then stops as stalled.
- **Working with an Ultra task.** A message you send while it works joins the task instead of interrupting it. A banner shows what Pi is working on and for how long, with Stop, Resume and its latest progress on hover; a notification says when it is done. On this Mac, the Mac stays awake while a task runs and quitting asks first; a task picks up again when its conversation is opened. On an SSH host it carries on whatever the Mac does.
- **Model, speed and effort changes always apply.** A model or effort chosen while a conversation was connecting or reconnecting was only saved, so Pi kept the old one, and switching models let Pi reset the effort to its own default. A change now shows at once, reaches Pi as soon as it is connected and again before every message, and the chosen effort is set after each model switch.
- **The speed in Usage refreshes with every reply.** It stayed on an earlier reply whenever the later ones were short. Each reply now shows its own speed when it can be timed, short replies from fast models included, and a reply without any reasoning is shown as Generation rather than Answer generation.
- **No more small print.** Menus, the / command list, the ⌘K palette and Settings → Agents no longer show gray descriptions under their items; details such as a model's id or a command's description appear on hover.

## 0.1.46 — Fast and Ultrafast, and a truer speed in Usage

- **Fast and Ultrafast.** For models whose provider sells faster processing, a ⚡ control next to Effort under the message box picks the speed: **Fast** for OpenAI's GPT-5.6 and GPT-6 models and for Claude Opus 5.5 (and Opus 5 and 4.8 in preview), at 2× the price, and **Ultrafast** for GPT-6 Astra and GPT-6.1 Sol, at 6×. In our runs Claude Opus 5.5 went from about 105 to 264 tokens per second with Fast, and GPT-6.1 Sol from about 55 to 75 with Fast and to 265–750 with Ultrafast, which varies from request to request. A speed applies to its conversation and the agents it starts, from the next request, also while Pi is working; a new conversation starts at the speed you last sent with.
- **What each reply ran at.** Usage shows the speed the provider reports for each reply, and its cost is counted at that speed (Anthropic's fast mode and Ultrafast were counted at standard prices). When the faster speed is rate limited or out of capacity, requests go one step slower for five minutes instead of the run failing; switching back on every request would also miss the prompt cache each time.
- **A truer speed in Usage.** A few-token reply such as "done" after a tool call dropped the speed to a few tokens per second. Usage now keeps the model's latest reply long enough to time, says that it comes from an earlier reply, and leaves such replies out of the trend. With hidden or summarized reasoning (OpenAI, Anthropic) the speed is the answer's generation rate, which the reasoning shares: in real streams the wait before the answer also held reading the prompt and summarizing the reasoning, at about half the answer's rate at standard speed and a seventh at Ultrafast, so it is no measure of speed. When the answer is too short to time, the speed is estimated from when the provider began its output, no longer from the whole request.

## 0.1.45 — Fewer, smaller subagents

- **Pi does the main work itself.** In real sessions the model handed its main task to agents a few tool calls in, and one request started seven of them. The delegation guidance now leads with doing the work, as in Claude Code: the main task, searches and edits stay with the model, which looks at the code itself first. It delegates only a broad read-only sweep of a large codebase, independent work big enough to run in parallel, or a review, and gives each agent one small, bounded task.
- **A limit per message.** One message can start at most 2 new agents; sending an existing agent more instructions doesn't count. A call over the limit starts none of its agents and tells the model to do the work itself; its card says Not started.
- **Settings → Agents.** Choose Off (no subagents: the tools and their guidance are gone), Limited (2 per message, the default) or More (5 per message). Running conversations apply a change before their next message.

## 0.1.44 — Downloads

- **Download files from the file pane.** A file open in the file pane has a Download button, and the tree's right-click menu has Download too. It saves the file to this Mac through a save dialog that starts in Downloads, also from an SSH host, where the file is streamed byte for byte (any size, any content). An interrupted transfer never leaves a partial file under the chosen name. When it finishes, a notice offers Show in Finder.
- **Files the model hands you.** A new `present_files` tool lets the model give you finished files (a report, an export, a generated image, an archive) as cards in the conversation, like Claude: click a card to open the file, or Download to save it. The model is told to use it for deliverables, not for scratch files or files it only read. Cards stay after a restart; agents report file paths and the main agent presents them.

## 0.1.43 — Agents that work in the background

- **Agents run in the background.** Starting an agent no longer stops the conversation until it finishes: the call returns at once, the model carries on (or ends its turn), and each agent's report arrives later as a message that starts its next turn. Reports that come in while the model is busy wait for its turn to end; after you press Stop they are kept but start nothing. Asking to wait is still possible, and an agent that runs past the wait carries on in the background instead of being killed. There is no batch time limit any more; only an agent whose model stops responding for 10 minutes is stopped.
- **Right context for each agent.** `explore` agents search and read without changing anything; `general` agents have the coding tools; a `fork` starts from the whole conversation with the same prompt, tools and model, so it needs no briefing and reuses the conversation's prompt cache. Fresh agents now get their brief, your instructions and the project's instruction files, instead of the coordinating agent's whole system prompt and an excerpt of every message you sent. Custom agents can be defined as Markdown files in `.pi/agents` or `.claude/agents` (Claude Code's format: tools, model, effort, isolation).
- **Follow-ups and Stop.** The model can send an agent more instructions and it continues with its context; it can also stop one. In the agent's activity panel you can stop it, or send it a message yourself.
- **Worktrees.** An agent can work in its own git worktree on its own branch, so parallel writers don't touch your checkout; its report says what changed, and a worktree without changes is removed.
- **Better delegation guidance.** The model is told when delegating pays (searches, independent parallel work, context-heavy side tasks) and when it doesn't, how to brief an agent, not to redo delegated work or guess results, and to verify reports before relying on them.
- Agent usage is counted once per run in Usage and Settings → Usage. Messages from extensions, such as these reports, now also appear after a conversation is reopened. The idle sweep never stops a Pi whose agents are working.

## 0.1.42 — Math in replies

- **LaTeX math renders.** Formulas in replies and Markdown previews are typeset with KaTeX: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` as display math. Before, they showed as raw TeX, and Markdown even turned `\[ … \]` into plain brackets. Prices such as `$5 and $10`, escaped `\$`, and code stay text; a formula that does not parse shows its source in red. Wide formulas scroll sideways, and the fonts ship with the app, so math also renders offline.

## 0.1.41 — An aligned command menu

- **The / command menu is aligned.** In the menu that opens when you type `/` (for example `/goal`), a command's name and description sat at the top of their row; they are now centred in it.

## 0.1.40 — New conversations on this Mac start with No folder

- **No folder by default on this Mac.** A new conversation here no longer starts in the most recent folder; pick a folder from the folder menu, where recent folders are still listed. A new conversation on an SSH host still starts in that host's most recent folder.

## 0.1.39 — Base URLs with or without /v1

- **Custom endpoints accept the base URL with or without `/v1`.** An Anthropic-compatible URL ending in `/v1` sent requests to `/v1/v1/messages`, because the SDK adds `/v1/messages` itself; the `/v1` is now dropped, also for providers saved before. For OpenAI-compatible endpoints the version belongs in the URL, but servers differ (OpenAI serves only `/v1/…`, Perplexity only the root), so saving checks which form the server answers on and adds or removes `/v1` only when just the other form works. A pasted endpoint URL (`…/v1/messages`, `…/chat/completions`, `…/responses`) works too, and *Choose models* tries both forms.

## 0.1.38 — Pi only, nothing left running, a speed for every reply

- **Cursor CLI is removed.** Pi Desktop runs Pi conversations only; the Cursor SDK settings, engine choice and Cursor model and effort controls are gone. Existing Cursor conversations stay in the sidebar as read-only history (read, copy, delete). The saved Cursor API key and the Cursor runtime and downloads the app installed (about 800 MB on this Mac, and `~/.pidesk/cursor-sdk` on SSH hosts) are deleted, and Cursor processes still running from earlier versions are stopped.
- **Nothing keeps running after you quit.** On this Mac the relay and every local Pi now stop with the app, and its shared SSH connections close, instead of staying in the background. A relay still running from an earlier version is ended at the first quit too. Local conversations resume from their session files when you open them again. Sessions on SSH hosts still keep running there while the app is closed.
- **A generation speed for every reply.** Usage showed *Speed unavailable* whenever it could not measure a clean generation window: replies a relay delivered in one burst, single-chunk or short replies, hidden reasoning and older timing. It now shows **Generation (estimated)** instead, from the observed output window when it is long enough, or else from output tokens over the whole response time (time to first token included, so it errs low). Clean windows are still measured exactly as before.

## 0.1.37 — Cursor conversations start ready

- **No wait after pressing Enter.** The new-conversation screen now starts the whole Cursor conversation ahead: its session is opened in the final directory (No folder: a provisional `new-chat` one) with the draft's model and effort already applied, and changes in the draft are applied as you make them. Sending only publishes it. Before, Cursor still opened the session and applied the effort after you sent (a round trip to Cursor's servers each, 2–5 s), or the whole 6–7 s start-up if it had not finished warming.
- **The next one is ready too.** After each new Cursor conversation, the next is started ahead in the same place. An unused one stops after ten minutes and removes its empty directory and history file.

## 0.1.36 — Cursor on hosts behind a proxy

- **Cursor CLI works on SSH hosts that reach the internet through a proxy.** The desktop passed Cursor only a minimal environment, without the host's `HTTPS_PROXY`/`NO_PROXY` and CA settings. On a company host Cursor then could not connect, and a new conversation stayed at *Starting Cursor…* while each step waited out its connection timeouts. Cursor now gets the same proxy and CA settings as any program on the host; Pi provider keys are still never passed.
- **Failures show sooner.** A pre-started Cursor CLI that cannot load its account services is dropped at once, so the first message starts afresh and reports the real error instead of waiting for several timeouts in a row.

## 0.1.35 — Fast first replies, Agent-mode Cursor and one effort control

- **Pi starts in a fraction of a second.** The bridge extension sat inside the app's own ES-module package, so Pi's extension loader imported it natively and compiled a second, unbundled copy of Pi from `node_modules` on every start: 1–6 s before the first reply, a new conversation, a fork or a model catalogue. It is now staged in the app's data folder and binds to Pi's already-loaded modules (about 0.2 s), as SSH hosts always did. A regression test checks the loading path.
- **Cursor CLI is ready before you send.** With Cursor CLI selected for a new conversation, the desktop starts Cursor in advance and loads its account services (about 5 s of Cursor's start-up). The first message then only opens the session, in its own directory for No folder. Idle Cursor conversations keep running for an hour instead of 20 minutes, since a restart delays the next reply.
- **Agent mode only.** Cursor conversations always run in Agent mode; the Mode menu is gone and a CLI that starts in Ask/Plan is switched to Agent.
- **One effort control.** Cursor's reasoning effort uses the same control as Pi's and is available before a new conversation starts, with the efforts Cursor lists for the chosen model. Models that split reasoning into a thinking switch and a level (Claude) get one list: Off, then the levels. Each conversation keeps its own effort although Cursor stores one per model, and your last choice is reused for the next conversation.
- **Context for Cursor.** Cursor reports no usage over ACP, so Context shows a clearly marked estimate (`~`) of the conversation's own text and tool output, with no invented window or percentage.
- **Cleaner Cursor SDK settings.** On/Off, API key, models and connection are separate groups with aligned actions and a clear status line.

## 0.1.34 — Reliable drafts and Cursor controls

- **Session drafts stay separate.** Text and images survive navigation. Late image reads cannot leak into the next new conversation or resurrect a deleted draft. Drafts remain in memory, not across app restarts.
- **Safe failed-send recovery.** Text and attachments restore as one message. If you have already edited the next draft, a Recover saved message button keeps both messages separate instead of mixing new text with old images.
- **Cursor configuration is real and race-safe.** Reasoning, Fast and other controls use only advertised ACP options. Overlapping configuration changes or prompts are explicitly rejected while a configuration change is pending; the draft is retained for retry. Model labels and reported context usage are corrected, with unknown usage shown honestly.
- **Official YOLO mode.** Desktop-launched local and SSH Cursor processes use `--force` (`--yolo`), respecting Cursor's explicit deny rules. Standalone CLI settings and MCP approval policy are unchanged. Existing running Cursor processes must restart to adopt the launch flag.
- **Cleaner UI and more reliable interruption.** Removes the redundant Cursor information card, prevents optional Cursor installation from blocking ordinary Pi connections, and fixes busy/settled races when sending a replacement prompt.
- **CI regressions.** Added draft lifetime, atomic recovery, delayed configuration and prompt overlap coverage. Tests, app builds and packaging run only in GitHub CI, never on the user's workstation. Official CLI startup probes do not validate real-account tool approval behavior.

## 0.1.33 — A compact Cursor setup and your own model shortlist

- **Less setup text.** Cursor settings are now one card: On/Off, API key, selected models, machine, and one collapsed Advanced row. The long explanatory paragraphs are gone; required information appears only when it matters.
- **Choose a shortlist, not the whole catalogue.** The first model load opens a searchable checklist. Tick the few models you actually use; the conversation model menu shows only those. Unselected models no longer flood the picker.
- **Fast reopening.** The advertised model list is cached and reused across menus, app restarts and local/SSH sessions. Menus open from the cached shortlist without launching Cursor. A refresh replaces the cache only after a successful load; check connection still performs a fresh query.
- **Safer loading state.** Cached models remain usable while a background refresh runs, with Done no longer blocked. Saving a new key clears stale account models while retaining your chosen model shortlist. Changing the shortlist does not invalidate the cache.
- **Regression coverage.** Electron tests verify the compact layout stays readable, only selected models reach the conversation menu, the chosen subset survives key rotation, and loading/removal flows remain correct. Local/SSH sessions, tools, permissions, cancellation, restart and the real official CLI/API-key routing tests all pass in GitHub CI.

No tests, builds or Cursor launches were run on the user's workstation. Existing Pi conversations and saved keys remain unchanged.

## Included from 0.1.32 — Correct Cursor API-key routing and legacy Pi controls

- **Do not invoke browser login for API keys.** The official Cursor CLI recognizes supplied API keys/auth tokens and existing CLI credentials during startup. Pi no longer unconditionally calls ACP `authenticate(cursor_login)`: that method checks browser-login credentials and could enter an interactive login flow even when an API key was already supplied, producing a generic `Invalid params` error.
- **Legacy Pi sessions stay Pi.** Conversations without an engine field now explicitly display as Pi. Their model menu, reasoning controls and slash commands never inherit a Cursor selection from the unrelated new-conversation draft. Selecting Cursor for a new chat does not convert an existing Pi conversation.
- **Readable composer controls.** Long model identifiers shrink/ellipsis within narrow panes, leave the engine/effort controls visible, and expose the full identifier in a tooltip.
- **Errors identify their stage.** RPC errors retain the method, numeric code and safe error detail while redacting the supplied key, rather than discarding the useful part of `Invalid params`.
- **Targeted CI coverage.** The mock peer rejects inappropriate browser-login calls for API-key sessions. The real pinned CLI verifies the pre-authenticated route with a synthetic invalid key using only `initialize` and local session listing, on this computer and over SSH. No real account/key validation, model session creation or inference is part of that probe. Electron regressions switch a Cursor draft back to a legacy Pi conversation and verify the correct menus and narrow-pane layout.

Existing saved keys and conversations are retained. Start a new conversation and select Cursor CLI to use Cursor; existing Pi chats are not migrated. Tests, app launches and packaging run only in GitHub CI.

## Included from 0.1.31 — Cursor authentication without a remote keychain

- **API-key auth stays in memory inside Cursor.** Supplied API keys/auth tokens select the official CLI's `memory` credential store. This avoids macOS login-keychain access in SSH sessions and avoids enabling plaintext CLI credential persistence. The desktop's saved key remains encrypted and is supplied again when a Cursor process restarts.
- **Actual SSH verification.** GitHub CI now uploads the real pinned Cursor package through the actual SSH installer and initializes its ACP server over SSH without a TTY, credentials or an inference request. This caught the keychain requirement that mock-only tests could not expose. Local official CLI startup, alias preservation, checksum checks and normal local/SSH UI flows remain covered.
- **Bounded shutdown.** Cursor/SSH shutdown closes inherited pipes after the grace period, so detached helpers or an SSH control master cannot leave the desktop waiting indefinitely after the direct process exits.
- **Automatic setup included.** No manual Cursor CLI install is needed: leave the advanced path blank, enter the API key and check models. Local/SSH private installations and the agent/Grok collision protection from 0.1.30 are included below.

The authentication policy applies to newly started/restarted Cursor processes; running work is not force-stopped and existing CLI credential caches are not deleted. If an earlier generic `agent` entry pointed to Grok or another program, update first and then rotate the Cursor API key as a precaution.

## Included from 0.1.30 — Managed Cursor SDK, without agent/Grok collisions

- **No manual CLI installation.** Enable Cursor SDK, enter the API key, and leave the advanced path blank. Pi downloads and verifies the official Cursor package into its private local directory. Enabled managed SDKs are also prepared when connecting SSH hosts, with the package downloaded on the Mac and uploaded over SSH. Download/upload progress is shown and healthy installs are reused.
- **Do not touch global aliases.** The upstream shell installer is not executed because it replaces `~/.local/bin/agent`. Pi's installation leaves Grok, global agent commands and shell profiles unchanged. Cursor's self-updater is disabled; the tested runtime version and per-platform size/SHA-256 are pinned in the desktop.
- **Verify the program before sending a key.** The old generic `agent` default now selects managed setup. Custom executables must identify a complete official Cursor runtime package before any key-bearing process is spawned. A path pointing to Grok or another program now gives an actionable error instead of `Device not configured`.
- **Real CLI regression coverage.** In addition to offline account/model and local/SSH UI fixtures, GitHub CI downloads the real pinned Cursor CLI and initializes ACP over pipes without credentials or inference. It checks that a pre-existing Grok alias is unchanged before and after startup. Installation, checksum failures, retries and remote path quoting are also covered.

**Credential precaution:** if the generic `agent` path used by 0.1.28/0.1.29 pointed to a different program, those versions may have supplied the saved Cursor API key in that program's environment. Update and rotate that key; Pi cannot establish whether the other program read or stored it.

The managed package currently supports macOS/Linux on arm64/x64 and needs at least 1 GB free during setup. SSH hosts do not need access to the package download host, but Cursor still needs access to its service for actual account/model use. No tests, builds or Cursor launches run on the user's workstation.

## Included from 0.1.29 — Enter a Cursor API Key directly

- **API Key first.** Settings → Cursor SDK now has a password field for a Cursor user API key. The CLI executable setting is tucked under Advanced. With a saved key there is no need to run `agent login`; the official CLI still needs to be installed on the target machine.
- **Encrypted and never echoed back.** Keys use the existing Keychain-backed secret store, not settings.json. The UI receives only a saved-key flag and clears the input after saving. Blank saves preserve the key; Remove saved key explicitly clears it. Failed storage writes retain the previous credential.
- **Local and SSH authentication.** The key travels through private stdin/relay boot data and is supplied as `CURSOR_API_KEY` to Cursor, never a command-line flag or desktop-written remote key file. Known credential strings are redacted from CLI error diagnostics. Cursor itself manages its child tools and authentication behavior.
- **Safe key changes.** Replacing/removing a key does not interrupt active work. At the next idle prompt or model lookup, the adapter restarts with the updated credentials and resumes the same native Cursor session/history. Existing CLI login remains a fallback when no key is saved.
- **CI regressions.** Coverage includes encryption and write failures, blank-save/remove behavior, stdin transport, diagnostic redaction, local/SSH authentication, key rotation after desktop restart, and preserved conversation identity. Verification and packaging run only in GitHub CI, using offline Cursor fixtures rather than real account quota.

## Included from 0.1.28 — Independent Cursor CLI sessions

- **Cursor SDK in Settings.** Configure the official Cursor CLI executable, check a local or SSH machine, and discover its account models without an inference prompt. Authentication stays with Cursor; install the CLI and run `agent login` on each machine first. The desktop does not install it or transfer credentials silently.
- **Cursor in the normal conversation UI.** New conversations can select Pi or Cursor CLI. Cursor replies, tool activity, permissions, questions and plan approvals display in the existing interface; files open in the same local/SSH preview. Model selection supports both ACP model catalogs and standard model config options, including grouped models.
- **Separate agent, no private bridge.** Cursor owns its context and tools. Pi API keys are not passed to it. The former VMISS quota bridge has been stopped and disabled separately; desktop updates do not restart it. Existing Pi conversations are not converted.
- **Durable sessions and honest limits.** Cursor runs behind the existing relay and resumes its native session after reconnecting. Stop uses ACP cancellation with bounded process cleanup. Unsupported Pi-only goals, fork, history editing and Pi subagent controls are disabled; missing usage/context counts stay unavailable instead of being fabricated.
- **CI-only verification.** Offline ACP tests and real Electron local/SSH workflows cover setup, model switching, tool/file links, permissions, cancellation, reload and restart. Regression tests include macOS symlinked install paths. This verifies the documented protocol, not live Cursor account/model access; no real model quota is consumed and no tests/builds/app launches run on the user's workstation.

See [Cursor SDK setup and limitations](https://github.com/Ljh0107-L/PI-Desktop/blob/v0.1.37/docs/cursor.md). Includes all file-preview and delegation-prompt fixes from 0.1.27 below.

## Included from 0.1.27 — Reliable file previews

- **Markdown images on the right machine.** Resolve SVG/PNG and other supported images relative to the document and read them through the session's local/SSH file API. Encoded spaces and Chinese paths work; large images fit the pane, refresh reloads image bytes, and missing/corrupt images show readable errors. SVG stays in an image element, never injected as active inline markup.
- **File browsing review fixes.** Switching tabs/sessions no longer shows stale content. Markdown links resolve from their document; heading anchors scroll the preview. Literal `%`/`#` filenames survive opening, normalized paths do not create duplicate tabs, and unknown-extension source no longer silently loses everything after 200K characters.
- **Safer local and SSH reads.** Remote home expansion and directory symlinks work; JSON/base64 transport preserves Unicode and newline filenames. Bounded reads respect short reads, reject non-regular files, preserve read errors, and avoid introducing malformed UTF-8 at the preview limit.
- **Less automatic delegation.** The main agent defaults to completing work directly. Subagents are for clearly bounded, substantial independent tasks with a concrete benefit, not routine discovery or small fixes.
- **Verified in GitHub CI only.** Local/SSH Electron regression fixtures and file-reading/path unit tests pass alongside the existing protocol, relay and backend suites. No tests, builds, installs or app launches were run on the user's workstation.

The file-preview fixes are included in 0.1.28; Cursor CLI support is new in 0.1.28.

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
