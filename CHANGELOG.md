# Changelog

All notable changes to PTAL will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Inline review threads mapped to the current working tree (3-stage fallback: diff arithmetic → content matching → honest failure)
- Comments follow edited code with an approximate-position badge; review-time snippet shown when a position degrades
- Reply and resolve/unresolve from the editor, with optimistic in-place updates
- Multi-line review ranges, subtle highlights on unresolved lines, overview-ruler marks
- Status bar with unresolved count, next-unresolved navigation
- Branch-switch detection, stale-checkout (behind PR head) warning, multi-PR-per-branch warning
