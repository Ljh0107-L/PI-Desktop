# History browsing behavior

History loading is an internal transport detail, not a separate conversation UI.

- Start at the latest content. Target visible conversation content rather than a tiny raw-record page. Fill a short opening window toward three viewport heights (at most eight extra pages), and prefetch the next two pages outside React state. Begin inserting ready history three viewports before the top on upward navigation.
- Warm unusually long prose in pending pages within a 1 MiB source-byte budget; do not prefetch full hidden tool outputs or large image attachments. Speculative reads must not change session focus or start Pi processes.
- Prepend by persisted identity and retain the visible entry's pixel offset. New live output must not move a reader who has scrolled away from the bottom.
- Keep the loaded window during overlapping tail refreshes. “Latest” scrolls to the tail instead of throwing the window away.
- Keep work grouped and disclosures keyed by tool identity. A deferred result must not insert its own row or split a work group.
- Hydrate visible prose and images automatically, and tool output, arguments, reasoning and compaction summaries when their normal disclosures open. Coalesce identical detail reads. A failure may offer Retry; ordinary browsing must not require Load full content buttons.
- Pagination and projection never rewrite the session file or change model context.

## Codex reference

Reviewed the public OpenAI Codex source at commit `748ab55ca7de0b647d9a7a9d9a8e70e00f28666d`:

- [`app/history_pagination.rs`](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/tui/src/app/history_pagination.rs): bounded pending requests, identity-based prepend, preservation of events received in flight, and joining activity groups across pages.
- [`transcript_view/bookmark.rs`](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/tui/src/transcript_view/bookmark.rs) and [`mutations.rs`](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/tui/src/transcript_view/mutations.rs): retained reading identity/offset, separation of following from reading, and keeping displayed groups stable through page joins.
- [`transcript_view/disclosure.rs`](https://github.com/openai/codex/blob/748ab55ca7de0b647d9a7a9d9a8e70e00f28666d/codex-rs/tui/src/transcript_view/disclosure.rs): expansion follows retained tool identities rather than transient rendered groups.
- App-server `ThreadTurnsListParams` / `ThreadItemsListParams`: opaque cursors, bounded pages and separate summary/full item views.

These are public app-server and TUI implementations, not a claim to have inspected the proprietary desktop frontend. Pi Desktop uses the same interaction principles with DOM bookmarks, its existing file reader and React disclosures.

## Regression coverage

`test/history-ui.mjs` also delays page transport by 800 ms to check that two pages are ready before upward navigation, prepared prose does not show loading placeholders, and a tool-heavy first page is filled into a useful reading window. `test/composer-stability-ui.mjs` records painted frames, focus, caret position and textarea style mutations while typing, streaming and inserting history. The focused editor is never collapsed to measure its height.

`test/history-ui.mjs` uses a tens-of-MB transcript with continuous tool calls and large results. It checks complete visible replies without load buttons, no idle backward paging, detail loading on normal disclosure, anchored upward paging, preservation under live output, and image previews. `test/file-preview-ui.mjs` exercises image resources and actual two-page PDF rendering over both local and SSH reads.
