Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Later versions install themselves: an **Update** button appears next to Settings.

**In this release**
- Speed is measured over the generation window (first token → last token), so time spent waiting for the first token or queueing is not counted. Replies with no stored timing fall back to the full API duration, and dense relay replays fall back too instead of producing artificial spikes.
- When a gateway reports fewer output tokens than the visible answer contains — seen with Cursor's Gemini path — the speed is estimated from the text and marked with `~` instead of showing a misleading low number.
- Provider-reported reasoning tokens are shown in Usage when the provider supplies them.
