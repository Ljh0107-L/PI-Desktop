Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Later versions install themselves: an **Update** button appears next to Settings.

**In this release**
- Conversations open at once: their history is read straight from the session file while Pi starts in the background, instead of waiting for Pi (a cold start took seconds). The spinner only shows while there is truly nothing to show.
- Hovering a conversation in the sidebar starts its Pi ahead of time.
- Fork is near-instant: a spare Pi kept running in the open conversation's folder takes the fork over (about 30 ms here, 100 ms over SSH, instead of most of a second).
- Pi processes no longer pile up: an idle Pi unused for 20 minutes, or beyond six idle ones per machine, is stopped (never the conversation on screen, one that is working, waiting on a question, or pursuing a goal). It restarts on its next use.
