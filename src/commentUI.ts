// Renders review threads inline via the native Comments API and provides
// unresolved-comment navigation. Knows nothing about GitHub — consumes
// neutral ReviewThread + MappedAnchor data only.
import * as vscode from 'vscode';
import { join } from 'path';
import { ReviewComment, ReviewThread } from './github';
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
  private rendered: { t: vscode.CommentThread; highlightable: boolean }[] = [];
  private meta = new Map<vscode.CommentThread, ReviewThread>();
  private targets: { uri: vscode.Uri; line: number; path: string }[] = [];
  private cursor = -1;
  // "focus mode": hide resolved threads entirely; default keeps them visible (collapsed)
  private showResolved = true;
  private totals = { unresolved: 0, total: 0 };
  private lastRoot: string | null = null;
  private lastMapped: MappedThread[] = [];

  // Subtle, theme-aware highlight on lines with unresolved threads.
  // Theme color variables keep it readable in both light and dark themes.
  private highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentUnresolvedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private highlightRanges = new Map<string, vscode.Range[]>();
  private editorListener: vscode.Disposable;

  constructor() {
    this.controller.options = { placeHolder: 'Reply — posted to the review thread on GitHub', prompt: '' };
    this.editorListener = vscode.window.onDidChangeVisibleTextEditors(() => this.applyHighlights());
  }

  /** Neutral thread data behind a rendered VS Code thread (for reply/resolve commands). */
  threadData(t: vscode.CommentThread): ReviewThread | undefined {
    return this.meta.get(t);
  }

  counts(): { unresolved: number; total: number } {
    return { ...this.totals }; // truthful even while resolved threads are hidden
  }

  resolvedShown(): boolean {
    return this.showResolved;
  }

  setShowResolved(show: boolean): void {
    this.showResolved = show;
    if (this.lastRoot !== null) {
      this.render(this.lastRoot, this.lastMapped);
    }
  }

  render(root: string, mapped: MappedThread[]): void {
    this.clear();
    this.lastRoot = root;
    this.lastMapped = mapped;
    this.totals = {
      unresolved: mapped.filter((m) => !m.thread.isResolved).length,
      total: mapped.length,
    };

    for (const { thread, anchor } of mapped) {
      if (!this.showResolved && thread.isResolved) {
        continue;
      }
      const uri = vscode.Uri.file(join(root, thread.path));
      const line = anchor.line ?? 1; // lost → anchor at top of file, flagged by label
      // multi-line review ranges span startLine..line; single-line comments collapse to one line
      const start = anchor.line !== null && anchor.startLine !== undefined ? anchor.startLine : line;
      const range = new vscode.Range(start - 1, 0, line - 1, 0);

      const comments: vscode.Comment[] = [];
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
      if (anchor.confidence !== 'exact' && thread.comments[0]?.snippet) {
        // GitHub-style frozen context: when the position is approximate or lost,
        // show what the reviewer was actually looking at, plus an escape hatch.
        // Appended LAST: the Comments panel summarizes a thread by its first
        // comment, which must stay the reviewer's words — not our context block.
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

      this.rendered.push({ t, highlightable: anchor.line !== null });
    }

    this.rebuildNavigation();
  }

  /**
   * Optimistically append a reply to both the rendered thread and the neutral
   * data behind it. The neutral ReviewThread is shared with lastMapped, so the
   * reply survives cached re-renders (resolved toggle etc.) until the next real
   * refresh replaces it with the server's copy.
   */
  appendComment(t: vscode.CommentThread, c: ReviewComment): void {
    const data = this.meta.get(t);
    if (!data) {
      return;
    }
    data.comments.push(c);
    const rendered: vscode.Comment = {
      author: { name: c.author, iconPath: c.authorAvatar ? vscode.Uri.parse(c.authorAvatar) : undefined },
      mode: vscode.CommentMode.Preview,
      body: new vscode.MarkdownString(c.body),
      timestamp: new Date(c.createdAt),
    };
    // the PTAL frozen-context block stays last — insert the reply before it
    const comments = [...t.comments];
    const ptalIdx = comments.findIndex((x) => x.author.name === 'PTAL');
    if (ptalIdx === -1) {
      comments.push(rendered);
    } else {
      comments.splice(ptalIdx, 0, rendered);
    }
    t.comments = comments;
  }

  /** Flip a thread's resolved state in place — no full refresh, no flicker. */
  setResolved(t: vscode.CommentThread, resolved: boolean): void {
    const data = this.meta.get(t);
    if (!data) {
      return;
    }
    data.isResolved = resolved;
    this.totals.unresolved += resolved ? -1 : 1;
    if (resolved && !this.showResolved) {
      // focus mode: a freshly resolved thread leaves the editor immediately
      t.dispose();
      this.meta.delete(t);
      this.rendered = this.rendered.filter((r) => r.t !== t);
      this.rebuildNavigation();
      return;
    }
    t.state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    t.contextValue = resolved ? 'resolved' : 'unresolved';
    t.collapsibleState = resolved
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    this.rebuildNavigation();
  }

  /** Recompute jump targets and highlights from current thread states. */
  private rebuildNavigation(): void {
    this.targets = [];
    this.highlightRanges.clear();
    for (const { t, highlightable } of this.rendered) {
      const data = this.meta.get(t);
      if (!data || data.isResolved || !t.range) {
        continue;
      }
      this.targets.push({ uri: t.uri, line: t.range.start.line + 1, path: data.path });
      if (highlightable) {
        const key = t.uri.toString();
        const ranges = this.highlightRanges.get(key) ?? [];
        ranges.push(t.range);
        this.highlightRanges.set(key, ranges);
      }
    }
    this.targets.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    this.cursor = -1;
    this.applyHighlights();
  }

  private applyHighlights(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.highlight, this.highlightRanges.get(editor.document.uri.toString()) ?? []);
    }
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
    for (const { t } of this.rendered) t.dispose();
    this.rendered = [];
    this.meta.clear();
    this.targets = [];
    this.cursor = -1;
    this.lastRoot = null;
    this.lastMapped = [];
    this.totals = { unresolved: 0, total: 0 };
    this.highlightRanges.clear();
    this.applyHighlights();
  }

  dispose(): void {
    this.clear();
    this.highlight.dispose();
    this.editorListener.dispose();
    this.controller.dispose();
  }
}
