# Changelog

All notable changes to PTAL will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Status bar unified into a single PTAL block; clicking opens an action menu (next unresolved / refresh / review summaries / show-hide resolved / open PR on GitHub), and the block's icon spins while a refresh runs

### Fixed

- Replies posted from the editor no longer vanish when the view re-renders (e.g. toggling resolved comments) before the next refresh
- Manual refresh no longer forces the Output panel open — results stay in the editor, errors still surface in the status bar
- Errors (auth, network, git) now surface in the status bar with click-to-retry instead of hiding in the output channel
- Threads with more than 50 comments load fully instead of being silently truncated
- Position mapping on large PRs no longer spawns one git process per thread at once (bounded to 8)

### Added

- Fork-based PRs work: when your `origin` is a fork and the PR lives upstream, PTAL finds it through the `upstream` remote (matching your fork's branch, not same-named branches from other forks)
- "Open review-time diff" link on degraded threads — when a comment's position is approximate or lost, one click diffs the review-time file version against your working tree, no browser needed
- PR-level review summaries (the body sent with Approve / Request Changes — where AI reviewers like Codex put their main findings) readable in a markdown preview, via the status-bar menu or `PTAL: Show Review Summaries`
- Auto-refresh when the window regains focus (throttled to once per 30s) — new review comments appear when you come back from the browser
- Status-bar refresh button next to the counter
- `PTAL: Show/Hide Resolved Comments` — focus mode that hides resolved threads from the editor (default: shown, remembered per workspace)
- Inline review threads mapped to the current working tree (3-stage fallback: diff arithmetic → content matching → honest failure)
- Comments follow edited code with an approximate-position badge; review-time snippet shown when a position degrades
- Reply and resolve/unresolve from the editor, with optimistic in-place updates
- Multi-line review ranges, subtle highlights on unresolved lines, overview-ruler marks
- Status bar with unresolved count, next-unresolved navigation
- Branch-switch detection, stale-checkout (behind PR head) warning, multi-PR-per-branch warning
