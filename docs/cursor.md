# Cursor SDK sessions

Pi Desktop's **Settings → Cursor SDK** is a client for the official [Cursor CLI ACP interface](https://cursor.com/docs/cli/acp). It is a separate agent engine, not a Cursor-to-model-API bridge. Cursor manages its model context, tools, authentication and account limits; Pi sessions are unchanged.

## Setup

1. Enable **Cursor SDK** in Settings and paste a user API key from **Cursor Dashboard → API Keys**. No manual CLI installation or `agent login` is needed for key authentication.
2. Leave **Advanced → Cursor CLI executable** blank. Pi Desktop downloads a pinned official package, verifies its size/SHA-256 and installs it under its own `cursor-sdk` directory. Local installation lives under the app's user-data directory; SSH installation lives under that connection's Pi install root. Enabled managed SDKs are prepared alongside server connections, or on the first model check/session that needs them.
3. Choose a machine and click **Check connection and models**. Download/upload progress is shown. Discovery opens an empty ACP session to read account models; it sends no inference prompt. A healthy installation is reused without downloading again. Allow at least 1 GB free for setup.
4. Start a new conversation, choose **Cursor CLI**, and use the normal model menu. The password field clears after a successful save; blank saves preserve the key and **Remove saved key** clears it. Without a saved key, an existing CLI login remains supported.

Pi never runs the upstream shell installer: that installer overwrites global `agent` aliases. Managed setup leaves `~/.local/bin/agent`, Grok and shell profiles untouched. The old generic `agent` default now selects managed setup. Advanced custom paths must identify a complete official `cursor-agent` runtime package; identity checks happen before launching any process with a key. Cursor's self-updater is disabled for these launches so runtime updates stay under Pi's control.

**Existing 0.1.28/0.1.29 users:** if `agent` pointed to a different program, those versions may have passed the saved Cursor key in that program's environment. Update and rotate that key as a precaution; the desktop cannot establish whether another program read or stored it.

The key is encrypted in the desktop's existing Keychain-backed secret store, separately from settings. Only key presence is returned to the renderer. Model discovery sends it on stdin; sessions use the relay's private boot record. The adapter removes the boot variable and supplies `CURSOR_API_KEY` to Cursor, never a command-line flag or a desktop-written key file on the SSH host. Supplied API keys/auth tokens select the official `AGENT_CLI_CREDENTIAL_STORE=memory` mode: Cursor does not need an unlocked remote macOS login keychain and keeps authentication ephemeral. The encrypted desktop key is supplied again when a session restarts; login fallback without a supplied key retains the CLI's normal credential store. Pi provider keys and Electron's `ELECTRON_RUN_AS_NODE` are not passed into Cursor. Known API keys are redacted from CLI error diagnostics. Cursor controls its own child tools and credential handling.

Saving/replacing/removing a key does not interrupt active work. The next idle model lookup or prompt restarts the Cursor adapter with the updated credential and resumes the same native session/history. An attempt to refresh credentials while a turn or question is active asks you to finish or stop it first. No VMISS service or reverse-engineered provider endpoint is required.

## Conversation behavior

- Replies and tool activity use the normal conversation display; generated files use the same local/SSH file pane and terminal.
- Tool permission requests, questions and plan approvals appear in the conversation. They are not silently approved. Unknown blocking client methods fail explicitly rather than hanging indefinitely.
- Stop sends ACP `session/cancel`; an unresponsive CLI is terminated after a bounded grace period. A new message interrupts the previous turn through the normal desktop mechanism.
- The existing relay owns the adapter and Cursor process, so detaching or quitting the desktop does not itself stop the conversation. Transcript projection and the native Cursor session ID are saved separately under `agent/cursor-sessions`. Reopening uses `session/load`, never a new session disguised as the old one.
- The model menu uses the models advertised by Cursor, not a hard-coded list. Model changes during a running turn are rejected.

## Limits

Pi's goal loop, Pi subagent controls, history editing and fork are not Cursor ACP features and are disabled for Cursor sessions. Cursor controls its own compaction. Usage and context counts are not fabricated from elapsed time or text length when the CLI does not report them. Cursor todo/subagent/image extension notifications are not promoted into fake Pi task records. Tools may still have side effects even if a turn is cancelled.

Requires ACP protocol version 1, session loading and model selection. The managed package version is pinned in `core/cursor-release.mjs` and updated through desktop releases; custom installations remain the user's responsibility. Offline tests verify account/model behavior with a mock peer, while a separate GitHub CI probe downloads the real official package and performs only an unauthenticated ACP `initialize` over pipes. It verifies installation and non-TTY startup without accessing a real account or consuming inference quota. Local/SSH desktop regression tests cover model menus, tools, permissions, cancellation and restart.
