# Cursor SDK sessions

Pi Desktop's **Settings → Cursor SDK** is a client for the official [Cursor CLI ACP interface](https://cursor.com/docs/cli/acp). It is a separate agent engine, not a Cursor-to-model-API bridge. Cursor manages its model context, tools, authentication and account limits; Pi sessions are unchanged.

## Setup

1. Install the [official Cursor CLI](https://cursor.com/docs/cli/installation) on each machine where conversations will run. A saved API key replaces the manual `agent login` step; the CLI executable itself is still required.
2. Enable **Cursor SDK** in Settings and paste a user API key from **Cursor Dashboard → API Keys**. The password field clears after a successful save; leaving it blank preserves the saved key. Use **Remove saved key** to clear it explicitly. The executable path is under **Advanced**, normally `~/.local/bin/agent`; it is an executable, not a shell command or argument list, and `~` expands on the target machine.
3. Choose a machine and click **Check connection and models**. Discovery opens an empty ACP session to read the account's advertised model list; it sends no inference prompt.
4. Start a new conversation, choose **Cursor CLI** in the agent selector, and use the normal model menu. Local and SSH conversations run Cursor on their respective machines using the saved key. Without a saved key, an existing CLI login remains supported.

The key is encrypted in the desktop's existing Keychain-backed secret store, separately from settings. Only key presence is returned to the renderer. Model discovery sends it on stdin; sessions use the relay's private boot record. The adapter removes the boot variable and supplies `CURSOR_API_KEY` to Cursor, never a command-line flag or a file on the SSH host. Pi provider keys and Electron's `ELECTRON_RUN_AS_NODE` are not passed into Cursor. Known API keys are redacted from CLI error diagnostics. Cursor controls its own child tools and credential handling.

Saving/replacing/removing a key does not interrupt active work. The next idle model lookup or prompt restarts the Cursor adapter with the updated credential and resumes the same native session/history. An attempt to refresh credentials while a turn or question is active asks you to finish or stop it first. No VMISS service or reverse-engineered provider endpoint is required.

## Conversation behavior

- Replies and tool activity use the normal conversation display; generated files use the same local/SSH file pane and terminal.
- Tool permission requests, questions and plan approvals appear in the conversation. They are not silently approved. Unknown blocking client methods fail explicitly rather than hanging indefinitely.
- Stop sends ACP `session/cancel`; an unresponsive CLI is terminated after a bounded grace period. A new message interrupts the previous turn through the normal desktop mechanism.
- The existing relay owns the adapter and Cursor process, so detaching or quitting the desktop does not itself stop the conversation. Transcript projection and the native Cursor session ID are saved separately under `agent/cursor-sessions`. Reopening uses `session/load`, never a new session disguised as the old one.
- The model menu uses the models advertised by Cursor, not a hard-coded list. Model changes during a running turn are rejected.

## Limits

Pi's goal loop, Pi subagent controls, history editing and fork are not Cursor ACP features and are disabled for Cursor sessions. Cursor controls its own compaction. Usage and context counts are not fabricated from elapsed time or text length when the CLI does not report them. Cursor todo/subagent/image extension notifications are not promoted into fake Pi task records. Tools may still have side effects even if a turn is cancelled.

Requires a CLI version advertising ACP protocol version 1, session loading and model selection. Updating the desktop does not update the separately installed CLI. Offline tests verify the documented protocol with a mock peer, local/SSH desktop sessions, model menus, tools, permissions, cancellation and restart; they do not prove live account/model availability. No real inference quota is consumed in CI.
