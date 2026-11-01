Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Later versions install themselves: an **Update** button appears next to Settings.

**In this release**
- **A new message interrupts the active reply:** sending while Pi works now stops the current model call and its tools, then starts a fresh turn with the new message. Previously it was queued as a steering message until the current turn and its tool calls finished, so a long answer could not be interrupted. The message appears immediately, the waiting row says “Interrupting…”, and the timer/token count starts from the new message instead of the previous turn.
- **No folder works like Codex’s projectless chats:** each new conversation gets its own directory, `~/Pi/<YYYY-MM-DD>/<name from the first message>/` (`~/pi/…` on SSH hosts), with `work/` for scratch files and `outputs/` for deliverables, and the model is told how to use them. A Pi is still kept warm on the new-session screen and moves into the new directory when you send, so starting a No-folder conversation stays instant. Existing conversations keep their folder.
- **Usage card matches TPS:** when Cursor reports an implausibly low output count, the Output figure now uses the same visible-text estimate as the speed, instead of showing 1 next to a ~47 tok/s reading.
- **Cursor cache hits are reported correctly:** the Cursor gateway now converts its total-prompt `input_tokens` to Anthropic’s uncached remainder and carries the previous prompt across tool-call turns, so a 99% cached turn no longer shows as 50% (or 0% on tool rounds).
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
