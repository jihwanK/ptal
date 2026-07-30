import * as vscode from 'vscode';
import { fetchReviewSet, gitDir, localContains, repoRoot, replyToThread, resolveThread, unresolveThread, viewer } from './github';
import { mapAnchor } from './lineMapper';
import { CommentUI, MappedThread } from './commentUI';

function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n', 1)[0].slice(0, 80);
}

// bounded fan-out: a 100-thread PR must not spawn 100 git processes at once
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('PTAL');
  const ui = new CommentUI();
  ui.setShowResolved(context.workspaceState.get<boolean>('ptal.showResolved', true));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'ptal.nextUnresolved';
  context.subscriptions.push(out, ui, status);

  let statusBase: { label: string; title: string; behind: boolean } | null = null;
  let statusError: string | null = null;

  const updateStatus = () => {
    if (statusError) {
      // a dead-looking extension is worse than a visible error
      status.text = '$(warning) PTAL';
      status.tooltip = `PTAL error: ${statusError}\nClick to retry.`;
      status.command = 'ptal.refresh';
      status.show();
      return;
    }
    status.command = 'ptal.nextUnresolved';
    if (!statusBase) {
      status.hide();
      return;
    }
    const { unresolved, total } = ui.counts();
    status.text = `${statusBase.behind ? '$(warning) ' : ''}$(comment-discussion) ${statusBase.label}: ${unresolved}/${total}`;
    status.tooltip = `${statusBase.title}\n${unresolved} unresolved review comment(s) — click to jump to the next one`;
    if (statusBase.behind) {
      status.tooltip += '\n⚠ Local checkout is behind the PR head — run git pull for accurate positions.';
    }
    status.show();
  };

  // stale-refresh guard: branch watcher, manual refresh, and activation can
  // overlap — only the latest invocation may touch the UI
  let refreshGen = 0;

  const refresh = async () => {
    const gen = ++refreshGen;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    out.appendLine(`[${new Date().toLocaleTimeString()}] refreshing…`);
    try {
      const root = await repoRoot(folder.uri.fsPath);
      const set = await fetchReviewSet(root);
      if (gen !== refreshGen) {
        return; // superseded by a newer refresh
      }
      if (!set) {
        ui.clear();
        statusBase = null;
        statusError = null;
        updateStatus();
        out.appendLine('no open PR for the current branch');
        return;
      }

      const mapped: MappedThread[] = await mapLimit(set.threads, 8, async (thread) => ({
        thread,
        anchor: await mapAnchor({
          cwd: root,
          path: thread.path,
          anchorSha: thread.anchorSha,
          anchorLine: thread.anchorLine,
          anchorStartLine: thread.anchorStartLine,
          snippet: thread.comments[0]?.snippet ?? '',
        }),
      }));
      if (gen !== refreshGen) {
        return; // superseded while mapping
      }
      ui.render(root, mapped);

      const unresolved = mapped.filter((m) => !m.thread.isResolved).length;
      const behind = !(await localContains(root, set.headSha));
      if (gen !== refreshGen) {
        return;
      }
      statusError = null;
      statusBase = { label: set.label, title: set.title, behind };
      updateStatus();
      if (behind) {
        out.appendLine('warning: local checkout does not contain the PR head commit — pull to map positions accurately');
      }
      if (set.openPrCount > 1) {
        // same head branch, different bases (e.g. backport PRs) — never hide that we picked one
        out.appendLine(`warning: ${set.openPrCount} open PRs share this branch — showing the oldest (${set.label}); PR selection is on the backlog`);
        void vscode.window.showWarningMessage(`PTAL: this branch has ${set.openPrCount} open PRs — showing ${set.label}.`);
      }

      out.appendLine(`${set.label} "${set.title}" — threads: ${mapped.length} (unresolved: ${unresolved})`);
      for (const { thread, anchor } of mapped) {
        const mark = thread.isResolved ? '✓' : '•';
        const outdated = thread.isOutdated ? ' (outdated)' : '';
        const head = thread.comments[0];
        const conf = anchor.confidence === 'lost' ? `lost:${anchor.reason}` : anchor.confidence;
        out.appendLine(
          `  ${mark} ${thread.path}:${anchor.line ?? '?'} [${conf}]${outdated} — ${head?.author}: ${firstLine(head?.body)}`,
        );
      }
    } catch (e) {
      out.appendLine(`error: ${e instanceof Error ? e.message : String(e)}`);
      if (gen === refreshGen) {
        statusError = e instanceof Error ? e.message : String(e);
        updateStatus();
      }
    }
  };

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  context.subscriptions.push(
    vscode.commands.registerCommand('ptal.refresh', async () => {
      out.show(true);
      await refresh();
    }),
    vscode.commands.registerCommand('ptal.nextUnresolved', () => ui.nextUnresolved()),
    vscode.commands.registerCommand('ptal.toggleResolved', async () => {
      const next = !ui.resolvedShown();
      ui.setShowResolved(next);
      await context.workspaceState.update('ptal.showResolved', next);
      updateStatus();
      vscode.window.setStatusBarMessage(`PTAL: resolved comments ${next ? 'shown' : 'hidden'}`, 2000);
    }),
    vscode.commands.registerCommand('ptal.reply', async (reply: vscode.CommentReply) => {
      const data = ui.threadData(reply.thread);
      if (!data || !reply.text.trim()) {
        return;
      }
      try {
        await replyToThread(data.id, reply.text);
        // optimistic append: no full refresh, so the thread stays open and nothing flickers
        const me = await viewer();
        reply.thread.comments = [
          ...reply.thread.comments,
          {
            author: { name: me.login, iconPath: me.avatarUrl ? vscode.Uri.parse(me.avatarUrl) : undefined },
            mode: vscode.CommentMode.Preview,
            body: new vscode.MarkdownString(reply.text),
            timestamp: new Date(),
          },
        ];
      } catch (e) {
        // never lose what the user wrote
        await vscode.env.clipboard.writeText(reply.text);
        void vscode.window.showErrorMessage(`PTAL: reply failed (${msg(e)}) — your text was copied to the clipboard.`);
      }
    }),
    vscode.commands.registerCommand('ptal.resolve', async (thread: vscode.CommentThread) => {
      const data = ui.threadData(thread);
      if (!data) {
        return;
      }
      try {
        await resolveThread(data.id);
        // optimistic: collapse in place, drop from navigation/highlights, no flicker
        ui.setResolved(thread, true);
        updateStatus();
      } catch (e) {
        void vscode.window.showErrorMessage(`PTAL: resolve failed (${msg(e)})`);
      }
    }),
    vscode.commands.registerCommand('ptal.unresolve', async (thread: vscode.CommentThread) => {
      const data = ui.threadData(thread);
      if (!data) {
        return;
      }
      try {
        await unresolveThread(data.id);
        ui.setResolved(thread, false);
        updateStatus();
      } catch (e) {
        void vscode.window.showErrorMessage(`PTAL: unresolve failed (${msg(e)})`);
      }
    }),
  );

  // branch-switch detection: watch HEAD in the actual git dir (worktree-safe)
  void (async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    try {
      const dir = await gitDir(folder.uri.fsPath);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), 'HEAD'),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 500); // HEAD writes come in bursts
      };
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      context.subscriptions.push(watcher);
    } catch {
      // not a git repo — nothing to watch
    }
  })();

  void refresh();
}

export function deactivate() {}
