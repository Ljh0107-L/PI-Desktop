# Subagents

Pi Desktop 0.1.20 adds a model-callable `subagent` tool. Ask the parent agent to delegate work in ordinary language, for example:

> Use two subagents to review the backend and renderer independently. Do not edit files, run local tests, or launch apps. Reconcile their findings and report the important issues.

For implementation, assign disjoint files and explicit constraints:

> Delegate the documentation update and the isolated parser change to separate subagents. Tell each which files it owns. Do not change their files concurrently; review both results before integrating. Verification must run in CI, not on this computer.

## Tool contract

```json
{
  "tasks": [
    { "name": "Backend review", "task": "Review core/ and app/main/ for lifecycle bugs. Return paths and evidence. Read only; no tests." },
    { "name": "Renderer review", "task": "Review app/renderer/ for state and UI bugs. Return paths and evidence. Read only; no tests." }
  ],
  "context": "Keep existing behavior. Do not run local tests or open GUI apps. Return blockers to the parent.",
  "timeoutSeconds": 300
}
```

- 1–6 tasks per call; up to 3 active model/tool loops across all calls in the parent session.
- Calls wait for the batch. Use a later call for a dependent stage rather than treating this as a persistent chat/spawn-and-send API.
- Each task gets the current model and thinking level, parent system instructions, bounded excerpts of user messages, explicit task/context, and its own new conversation. Parent assistant/tool history is not copied. Include all relevant constraints explicitly: very long user history is excerpted.
- Coding tools are forwarded through the parent `ctx.executeTool()` pipeline, retaining validation, tool hooks and existing tool permissions. Only available `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools can be exposed. This does not activate tools disabled in the parent.
- Subagents cannot call `subagent`, `ask_user`, or goal tools. A blocker/question goes back to the parent.
- Default batch deadline is 300 seconds, including queued tasks; callers can choose 1–900 seconds. Each task is limited to 12 model turns and two transient model retries. Completed tools are not replayed to retry a failed model response.
- Final output per child is bounded to about 8 KB and marked when truncated. Task failures, cancellation, timeouts and non-complete model responses remain explicit.

## Desktop behavior

Subagent progress and summaries appear inside the parent Subagents tool. Expand it for per-task status, output, model, turns and usage. They do not create sidebar conversations, app windows or extra Pi subprocesses.

Delegated write/edit paths appear in Outputs. Child-model token usage contributes to the session totals and Usage ledger; it does not get divided by the main model's generation window to inflate TPS. The detailed results persist with the parent tool result, so reopening the parent keeps them.

Each subagent runs on the same machine as the parent. SSH sessions delegate on the SSH host using its existing provider connectivity. Disconnecting or quitting the desktop does not cancel the parent relay's work. Stop cancels active and queued subagents; session shutdown also signals cancellation.

## Boundaries

Independent context is **not** filesystem or OS isolation. Subagents share the parent's working directory and can use its available coding tools. Permission and user restrictions still apply; the prompts do not create a new sandbox. Assign disjoint files to concurrent writers and inspect results before integrating. The parent remains responsible for verification and the final answer.

The built-in prompts are `SUBAGENT_PROMPT` and `CHILD_PROMPT` in `agent/pidesk-subagent.mjs`; the bridge injects delegation guidance as a structured system-prompt section before each run. They cover useful task selection, context transfer, user restrictions, shared-file coordination and verification.

There is no separate durable child-session service in this version. If the parent Pi process crashes, its in-memory child contexts stop with it; completed results remain in the parent's session file. Existing Pi processes kept alive across a desktop update retain the old bridge until replaced. Start a new conversation to use the new extension without stopping ongoing work.

## CI coverage

`test/subagent.test.mjs` exercises isolated contexts, inherited constraints, concurrent batches, parent tool forwarding, retry without duplicate tool execution, limits, cancellation, usage and output persistence. Protocol tests delegate with real Pi locally and through SSH; Electron E2E covers uploaded SSH extension dependencies, result cards, Outputs and the absence of extra windows/conversations. These suites run in GitHub CI; no local test application is needed.
