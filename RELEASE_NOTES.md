Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Later versions install themselves: an **Update** button appears next to Settings.

**In this release**
- No more Keychain password prompt after every update: API keys are now encrypted with a key kept in a Keychain item that stays readable across updates. This update asks one last time while it moves your saved keys over; choose Always Allow.
- Folded steps now match Claude: only reasoning and tool calls fold; what Pi writes to you always stays in the conversation. Rows are plain text with an inline triangle, no icons, no hover highlight; the summary names a single edited file and shows "(N failed)" and +/− line counts.
- Speed and "Last turn" in Usage are per turn again, where a turn is one model call, and update as each call finishes.
