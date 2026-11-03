# Cursor SDK sessions

Pi Desktop's **Settings → Cursor SDK** is a client for the official [Cursor CLI ACP interface](https://cursor.com/docs/cli/acp). It is a separate agent engine, not a Cursor-to-model-API bridge. Cursor manages its model context, tools, authentication and account limits; Pi sessions are unchanged.

## Setup

1. Install the [official Cursor CLI](https://cursor.com/docs/cli/installation) on the machine where the conversation will run. Run `agent login` there in a terminal.
2. Enable **Cursor SDK** in Settings. Set the executable path, normally `~/.local/bin/agent`. This is an executable, not a shell command or argument list. `~` expands on the target machine.
3. Choose a machine and click **Check connection and models**. Discovery opens an empty ACP session to read the account's advertised model list; it sends no inference prompt.
4. Start a new conversation, choose **Cursor CLI** in the agent selector, and use the normal model menu. Local and SSH conversations run Cursor on their respective machines. Each machine needs its own working CLI/login; Pi Desktop does not silently copy credentials or install the CLI.

Cursor credentials stay with its CLI. Pi API-provider credentials and Electron's `ELECTRON_RUN_AS_NODE` are not passed into Cursor. No VMISS service or reverse-engineered provider endpoint is required.

## Conversation behavior

- Replies and tool activity use the normal conversation display; generated files use the same local/SSH file pane and terminal.
- Tool permission requests, questions and plan approvals appear in the conversation. They are not silently approved. Unknown blocking client methods fail explicitly rather than hanging indefinitely.
- Stop sends ACP `session/cancel`; an unresponsive CLI is terminated after a bounded grace period. A new message interrupts the previous turn through the normal desktop mechanism.
- The existing relay owns the adapter and Cursor process, so detaching or quitting the desktop does not itself stop the conversation. Transcript projection and the native Cursor session ID are saved separately under `agent/cursor-sessions`. Reopening uses `session/load`, never a new session disguised as the old one.
- The model menu uses the models advertised by Cursor, not a hard-coded list. Model changes during a running turn are rejected.

## Limits

Pi's goal loop, Pi subagent controls, history editing and fork are not Cursor ACP features and are disabled for Cursor sessions. Cursor controls its own compaction. Usage and context counts are not fabricated from elapsed time or text length when the CLI does not report them. Cursor todo/subagent/image extension notifications are not promoted into fake Pi task records. Tools may still have side effects even if a turn is cancelled.

Requires a CLI version advertising ACP protocol version 1, session loading and model selection. Updating the desktop does not update the separately installed CLI. Offline tests verify the documented protocol with a mock peer, local/SSH desktop sessions, model menus, tools, permissions, cancellation and restart; they do not prove live account/model availability. No real inference quota is consumed in CI.
