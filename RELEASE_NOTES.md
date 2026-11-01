Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Later versions install themselves: an **Update** button appears next to Settings.

**In this release**
- Messages you send while Pi works appear at once and reach Pi before its next model call, instead of waiting silently for the whole run to end.
- Expanded steps stay open, and the conversation no longer jumps to the bottom while you read; a "Latest" button takes you back.
- The "files changed" row no longer disappears and comes back while Pi is still working.
- tok/s is measured from Pi's own timing of each API call, so it no longer spikes to 1000+ when output arrives in bursts.
- Reasoning tokens show next to "Thought" whenever the provider reports them.
- Delete takes effect immediately; cleanup continues in the background.
- Opening a conversation shows a centred spinner instead of a "Starting Pi" line.
- The sidebar, the file pane and its file tree can be resized by dragging their edges (double-click to reset).
- Pi's notes about resized images no longer show in your messages.
- Settings: no model count / URL under providers; Usage has no cost card or footnote.
