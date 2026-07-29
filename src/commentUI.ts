// Renders review threads inline via the native Comments API and provides
// unresolved-comment navigation. Knows nothing about GitHub — consumes
// neutral ReviewThread + MappedAnchor data only.
import * as vscode from 'vscode';
import { join } from 'path';
import { ReviewThread } from './github';
import { MappedAnchor } from './lineMapper';

export interface MappedThread {
  thread: ReviewThread;
  anchor: MappedAnchor;
}

function snippetTail(snippet: string, max = 8): string {
  const lines = snippet.split('\n');
  return lines.slice(Math.max(0, lines.length - max)).join('\n');
}

export class CommentUI implements vscode.Disposable {
  private controller = vscode.comments.createCommentController('ptal', 'PTAL');
  private rendered: vscode.CommentThread[] = [];
  private meta = new Map<vscode.CommentThread, ReviewThread>();
  private targets: { uri: vscode.Uri; line: number; path: string }[] = [];
  private cursor = -1;

  constructor() {
    this.controller.options = { placeHolder: 'Reply — posted to the review thread on GitHub', prompt: '' };
  }

  /** Neutral thread data behind a rendered VS Code thread (for reply/resolve commands). */
  threadData(t: vscode.CommentThread): ReviewThread | undefined {
    return this.meta.get(t);
  }

  render(root: string, mapped: MappedThread[]): void {
    this.clear();

    for (const { thread, anchor } of mapped) {
      const uri = vscode.Uri.file(join(root, thread.path));
      const line = anchor.line ?? 1; // lost → anchor at top of file, flagged by label
      const range = new vscode.Range(line - 1, 0, line - 1, 0);

      const comments: vscode.Comment[] = [];
      if (anchor.confidence !== 'exact' && thread.comments[0]?.snippet) {
        // GitHub-style frozen context: when the position is approximate or lost,
        // show what the reviewer was actually looking at, plus an escape hatch.
        const why =
          anchor.confidence === 'lost'
            ? "PTAL couldn't find this spot in your current code."
            : anchor.confidence === 'approx'
              ? 'The code changed here since the review — position is approximate.'
              : 'Position was recovered by content matching — double-check it.';
        comments.push({
          author: { name: 'PTAL' },
          mode: vscode.CommentMode.Preview,
          body: new vscode.MarkdownString(
            `**Code as the reviewer saw it** — ${why}\n` +
              '```diff\n' +
              snippetTail(thread.comments[0].snippet, 4) +
              '\n```\n' +
              `[Open this comment on GitHub](${thread.comments[0].url})`,
          ),
        });
      }
      for (const c of thread.comments) {
        comments.push({
          author: {
            name: c.author,
            iconPath: c.authorAvatar ? vscode.Uri.parse(c.authorAvatar) : undefined,
          },
          mode: vscode.CommentMode.Preview,
          body: new vscode.MarkdownString(c.body),
          timestamp: new Date(c.createdAt),
        });
      }

      const t = this.controller.createCommentThread(uri, range, comments);
      t.canReply = true;
      t.contextValue = thread.isResolved ? 'resolved' : 'unresolved';
      this.meta.set(t, thread);
      t.state = thread.isResolved
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      t.collapsibleState = thread.isResolved
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;

      const labels: string[] = [];
      if (thread.isOutdated) labels.push('outdated');
      if (anchor.confidence === 'approx') labels.push('code changed here — approximate position');
      if (anchor.confidence === 'content') labels.push('position matched by content');
      if (anchor.confidence === 'lost') {
        labels.push(
          anchor.reason === 'anchor-missing'
            ? `local checkout behind the PR? (was line ${thread.anchorLine ?? '?'}) — try git pull`
            : `original code no longer found (was line ${thread.anchorLine ?? '?'})`,
        );
      }
      t.label = labels.length ? `⚠ ${labels.join(' · ')}` : undefined;

      this.rendered.push(t);
      if (!thread.isResolved) {
        this.targets.push({ uri, line, path: thread.path });
      }
    }

    this.targets.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    this.cursor = -1;
  }

  async nextUnresolved(): Promise<void> {
    if (this.targets.length === 0) {
      void vscode.window.showInformationMessage('PTAL: no unresolved review comments 🎉');
      return;
    }
    this.cursor = (this.cursor + 1) % this.targets.length;
    const target = this.targets[this.cursor];
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(Math.min(target.line - 1, doc.lineCount - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  clear(): void {
    for (const t of this.rendered) t.dispose();
    this.rendered = [];
    this.meta.clear();
    this.targets = [];
    this.cursor = -1;
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}
