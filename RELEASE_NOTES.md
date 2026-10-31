Pi Desktop runs [Pi](https://github.com/earendil-works/pi) sessions on this Mac and on SSH hosts side by side, with any model from any provider.

**Install:** download the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel), drag Pi Desktop to Applications, then right-click → Open the first time (the app is ad-hoc signed, not notarized). Later versions install themselves: an **Update** button appears next to Settings.

**In this release**
- Cleaner step rows: each step gets an icon and reads plainly (file name with its folder in grey, edits with +/− counts); failures say "Failed"; a command and its output show as one console.
- Diffs use clear, saturated red and green, and edits show a real line diff instead of old-then-new.
- Lists indent as you type: "1. " or "- " at the start of a line moves in, Tab / Shift+Tab nest and un-nest, Shift+Enter continues; sent messages keep each level's indent.
- The speed and "Last turn" figures in Usage update once per turn, not with every model call inside it.
- The paperclip is gone from the message box: paste or drop files and images instead.
- Consistent chevrons everywhere; reply actions appear on the latest reply and on hover.
