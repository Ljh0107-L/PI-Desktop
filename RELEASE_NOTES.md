Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Later versions install themselves: an **Update** button appears next to Settings.

**In this release**
- **Usage card matches TPS:** when Cursor reports an implausibly low output count, the Output figure now uses the same visible-text estimate as the speed, instead of showing 1 next to a ~47 tok/s reading.
- **Failed turns do not reset Usage:** an aborted or errored turn no longer becomes the “Last turn” with Input 0 / Output 0; the last completed turn stays visible.
- **Interrupt is now Codex-style:** Stop aborts the running command, clears queued steering/follow-up messages, and hard-stops a Pi that ignores the abort signal after 4 seconds instead of waiting for the command to finish.
- **Compaction reserve follows max output:** Pi Desktop now sets each model's compaction reserve to its max output length, so it compacts when `context - input < max output` instead of letting a 1M-context model overflow first.
- **TPS for tool calls:** tool-call arguments count toward the generation window, while a large write body can no longer be mistaken for a missing token count and inflate the speed.
- Model output limits were reviewed and tightened for the configured DeepSeek, Qwen and Cursor models.
- The Context meter now refreshes after every model call, on the same boundary as the Usage/TPS card, instead of waiting for the whole agent run to settle.
- Interrupting a run no longer leaves a red “This operation was aborted” error box; user stops are shown as a neutral “Interrupted” notice. Real provider failures still show as errors.
- Cursor bridge streams now report a clear error instead of closing the socket when an internal exception occurs, so Pi no longer surfaces an opaque “terminated” transport failure.
- Speed is measured over the generation window (first token → last token), so time spent waiting for the first token or queueing is not counted. Replies with no stored timing fall back to the full API duration, and dense relay replays fall back too instead of producing artificial spikes.
- When a gateway reports fewer output tokens than the visible answer contains — seen with Cursor's Gemini path — the speed is estimated from the text and marked with `~` instead of showing a misleading low number.
- Provider-reported reasoning tokens are shown in Usage when the provider supplies them.
