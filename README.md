# PTAL

> **P**lease **T**ake **A**nother **L**ook — the thing you say after handling every review comment. This extension gets you there without leaving your code.

<!-- TODO: demo GIF — comment click → exact line jump → reply/resolve in place (M3 이후 촬영) -->

## Why

You work in your terminal and VS Code. But the moment you open a PR, you're forced onto the GitHub web UI — where review comments are pinned to diff snippets, there's no go-to-definition, and finding the function a comment refers to means scrolling and guessing.

VS Code is great at exactly that: jumping to definitions, tracing code across files. It just can't show your PR review comments. PTAL fixes that:

- Review comments appear **inline, on the right line of your working tree** — even after you've pushed more commits and GitHub marks them "outdated"
- Jump between unresolved comments, **reply and resolve without opening a browser**
- Zero configuration: install, sign in to GitHub once, done

**The official GitHub Pull Requests extension removes the browser. PTAL removes the context switch.** The official extension shows comments frozen at review time; PTAL follows your code as it changes — which is exactly when you need it, because changing the code is what handling a review means.

## Status

🚧 Under development — not yet published.

## Limits (honest ones)

- When a comment's target line can't be confidently located (heavy rebases, deleted code), PTAL anchors it at the top of the file with an explicit "location unknown" badge and shows the original review-time snippet — it never silently points at the wrong line.
- GitHub.com only for now (no GHES). GitLab/Bitbucket may come later.

## License

MIT
