# Agents (subagents)

The coordinating agent can start agents that work in their own context windows and report back. Their main purpose is to keep the conversation's context on what matters: an agent may read tens of thousands of tokens of files and logs, but only its report enters the conversation. Independent work can also run in parallel.

Pi delegates sparingly, the way Claude Code does. By default (Settings → Agents: When asked) it starts agents only when you, the project's instructions or a skill ask for them, and otherwise does the work itself, however large. With When useful it decides for itself: the main task, ordinary searches and edits still stay with the coordinating agent, and agents are for a broad read-only sweep of a large codebase, independent work large enough to run in parallel, or a second opinion on finished work. Each agent gets one small, bounded task, briefed in full the first time.

Ask in ordinary language, for example:

> Have an explore agent find where sessions are restored after a restart and report the call path with file paths. Meanwhile, fix the typo in the README.

> Fork a side task: draft unit tests for the parser change we just made. Keep working on the renderer.

> Use two agents in separate worktrees to try both approaches to the cache fix, then compare their diffs.

## Agent types

| Type | Starts with | Tools |
|---|---|---|
| `general` (default) | its own prompt, the user's and the project's instructions (AGENTS.md and the like), the session's runtime notes, the working directory, and the brief | read, write, edit, bash, grep, find, ls |
| `explore` | its own read-only prompt, the user's instructions, the runtime notes, and the brief (no project instruction files) | read, grep, find, ls, and bash for read-only commands |
| `fork` | the whole conversation so far, with the coordinating agent's system prompt, tools and model | the same tools; starting agents, asking the user and the goal tools return an error |
| custom | the body of its definition file, plus the user's and project's instructions | from its definition |

A non-fork agent sees nothing of the conversation: the coordinating agent writes a brief with the goal, what is known or ruled out, the paths involved, the scope, every user instruction that applies, and what to report. A fork needs only the task. Because a fork declares exactly the coordinating agent's prompt and tools and continues its message history, its first request reuses the conversation's prompt cache.

Every agent uses the session's model and reasoning effort unless a custom definition names others.

## Running, reports, follow-ups

- **Background by default.** The `subagent` call returns at once with each agent's id. When an agent finishes, its report arrives in the conversation as a message ("Automated message from Pi Desktop, not from the user…") that starts the coordinating agent's next turn if it is idle. If it is busy, the report reaches it after its current step; reports in a row share one card in the conversation. After a Stop they are recorded without starting a turn.
- **Waiting.** `background: false` makes the call wait for the reports, up to `waitSeconds` (default 600). Agents still running then carry on in the background and report later; nothing is killed for taking long.
- **Follow-ups.** `subagent_message { id, message }` continues an agent with its context intact. A finished agent starts another run; a working one reads the message within its current run. The last 24 finished agents stay available.
- **Stop.** `subagent_stop { id }`, or **Stop** in the inspector, cancels an agent. A stopped agent cannot be continued.
- **How many.** One message can start at most 2 new agents (Settings → Agents: Off; When asked, up to 2; When useful, up to 5). Follow-ups to existing agents don't count. A call over the limit starts none of its agents and tells the model to do the work itself; its card says Not started. Off removes the tools and their guidance.
- **Limits.** Up to 8 tasks per call; up to 5 agents work at once per session, the rest queue. There is no time limit and no turn limit. An agent whose model gives no response for 10 minutes (while no tool is running) is stopped as stalled. Each report is bounded to about 8 KB.

Reports are the agent's claims: the coordinating agent is told to check what matters before relying on them and to relay what matters to you. Delegation grants no extra permission; your restrictions apply to agents too.

## Worktrees

A task with `isolation: "worktree"` works in its own git worktree: `git worktree add -b pi-agent/<id> <git dir>/pi-worktrees/<id> HEAD`. It starts from the last commit, so uncommitted changes in the main checkout are not in it. The agent's file paths (relative, or absolute inside the main checkout) are mapped into the worktree, and its shell commands run there. The report gives the branch, the path, and how many files and commits changed; review and merge or copy the changes yourself. A worktree with no changes is removed together with its branch.

## Custom agents

Markdown files with YAML frontmatter, the same format as Claude Code's agents, in:

1. `.pi/agents/` and `.claude/agents/` in the working directory and at the git root;
2. `~/.pi/agents/` and `~/.claude/agents/`.

The first definition of a name wins (project before user, `.pi` before `.claude`); the built-in names cannot be redefined.

```markdown
---
name: reviewer
description: Reviews a diff for bugs and risky changes. Use after non-trivial edits.
tools: Read, Grep, Glob, Bash
model: inherit
effort: high
---

You review code changes. Run git diff, read the changed files, and list problems by severity
with file paths and line numbers. Don't edit anything.
```

- `name`, `description` (required): the description tells the coordinating agent when to use it; all custom agents are listed in its instructions.
- `tools`: Claude Code names (Read, Write, Edit, MultiEdit, Bash, Grep, Glob, LS) or Pi names; default all coding tools. `disallowedTools` removes some.
- `model`: `inherit` (default), `provider/id`, or a model id configured in Pi Desktop. Others (such as `sonnet`) fall back to the session's model, with a note in the agent's activity.
- `effort`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` (`max` = `xhigh`).
- `isolation: worktree`: always run in its own worktree.
- `omitClaudeMd: true`: leave out the project's instruction files.

## In the app

- A delegation is a card in the conversation; while background agents work it says so. Each report is one row in the conversation, followed by the coordinating agent's reply; clicking it opens the agent.
- Click a task in the card or in the right panel's Subagents list to open its activity: the brief, then its public messages and tool calls (the same renderer as the main conversation), messages sent to it later, its type and its worktree.
- While an agent works, **Stop** cancels it. A message box under its activity sends it a message from you; it continues with its context and reports again.
- Clear (in the list, or for one finished task) hides finished records; it never deletes the conversation, usage or files.
- Agents run inside the session's Pi on the session's machine, with its provider connectivity and tool pipeline. On an SSH host they keep working while the desktop is disconnected or closed, and their reports start the next turn there. Agents on this Mac stop when you quit, like every local Pi. The idle sweep never stops a Pi whose agents are working.
- If a session's Pi ends while its agents work, the next start records them as stopped; they can't be continued.
- Agent token usage counts in the session's Usage and in Settings → Usage, once per run, and never feeds the main model's TPS.

## Internals

`agent/pidesk-subagent.mjs` holds the runtime and the prompts (`subagentPrompt(mode)` for the coordinating agent, the agent prompts, and the fork directive); the bridge registers the `subagent`, `subagent_message` and `subagent_stop` tools and adds the guidance, with the list of agent types, as a system-prompt section before each run. Coding tools go through the parent's `ctx.executeTool()` pipeline (validation, hooks, permissions). Bash timeouts default to 120 seconds when omitted. The execution trace keeps public text and tool steps only (at most 80 steps and 64 KiB per agent), never hidden thinking, credentials or inherited prompts. Output-limit recovery (once per run) and transient retries (twice per run) are unchanged from earlier versions.

Live state reaches the desktop as the `pidesk-agents` status line (throttled to one update a second, and resent every 30 seconds while agents work); reports are `pidesk-agent` custom messages saved in the session file; each run's usage is reported exactly once as `details.agentRuns`.

## CI coverage

`test/agents.test.mjs`: background reports and their re-sending after a Stop cleared Pi's queue, follow-ups during and after a run, stop, the fork's prompt-cache prefix, explore tools, custom definitions, worktrees in a real git repository, interrupted agents, live publishing. `test/agents-desktop.test.mjs`: history, the idle sweep, usage, the merged view. `test/subagent*.test.mjs`: trace bounds, retries, output-limit recovery, cancellation. The Electron E2E covers delegation cards, the inspector, clearing, SSH drops, a background report starting the next turn, and messaging and stopping an agent from the inspector.
