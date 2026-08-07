import * as vscode from 'vscode';
import { join } from 'path';
import { fetchReviewSet, fileAtRevision, gitDir, localContains, repoRoot, replyToThread, resolveThread, unresolveThread, viewer, ReviewSummary } from './github';
import { mapAnchor } from './lineMapper';
import { CommentUI, MappedThread } from './commentUI';
import { summariesMarkdown } from './summaryMarkdown';

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
  // one block, one identity: a single status item whose click opens the action
  // menu (refresh lives there). Deliberately NOT an SCM provider — a second
  // provider displaces git's branch UI (#36), and PTAL should read as its own
  // app, not a git appendage; #9 will give it a dedicated view instead.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'ptal.menu';
  context.subscriptions.push(out, ui, status);

  let statusBase: { label: string; title: string; url: string; behind: boolean } | null = null;
  let statusError: string | null = null;
  let lastSummaries: ReviewSummary[] = [];
  let refreshing = false;

  // Review summaries live in a read-only virtual doc rendered as a markdown
  // preview — no dirty untitled buffer, and an open preview updates on refresh.
  const summaryUri = vscode.Uri.from({ scheme: 'ptal', path: '/Review Summaries.md' });
  const summaryEmitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    summaryEmitter,
    vscode.workspace.registerTextDocumentContentProvider('ptal', {
      onDidChange: summaryEmitter.event,
      provideTextDocumentContent: () =>
        summariesMarkdown(statusBase?.label ?? 'PTAL', statusBase?.title ?? 'no open PR', lastSummaries),
    }),
    // review-time file versions for diff views — uri.path names the tab,
    // uri.query carries what git needs
    vscode.workspace.registerTextDocumentContentProvider('ptal-rev', {
      provideTextDocumentContent: (uri) => {
        const { cwd, sha, path } = JSON.parse(uri.query) as { cwd: string; sha: string; path: string };
        return fileAtRevision(cwd, sha, path);
      },
    }),
  );

  const updateStatus = () => {
    if (statusError) {
      // a dead-looking extension is worse than a visible error
      status.text = '$(warning) PTAL';
      status.tooltip = `PTAL error: ${statusError}\nClick to retry.`;
      status.command = 'ptal.refresh';
      status.show();
      return;
    }
    status.command = 'ptal.menu';
    if (!statusBase) {
      status.hide();
      return;
    }
    const { unresolved, total } = ui.counts();
    // the block's icon doubles as in-flight feedback while a refresh runs
    const icon = refreshing ? '$(sync~spin)' : '$(comment-discussion)';
    status.text = `${statusBase.behind ? '$(warning) ' : ''}${icon} ${statusBase.label}: ${unresolved}/${total}`;
    status.tooltip = `${statusBase.title}\n${unresolved} unresolved review comment(s) — click for actions`;
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
    refreshing = true;
    updateStatus();
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
        lastSummaries = [];
        summaryEmitter.fire(summaryUri);
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
      statusBase = { label: set.label, title: set.title, url: set.url, behind };
      lastSummaries = set.summaries;
      summaryEmitter.fire(summaryUri); // keep an already-open preview current
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
    } finally {
      if (gen === refreshGen) {
        refreshing = false; // a superseding refresh owns the spinner now
        updateStatus();
      }
    }
  };

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  context.subscriptions.push(
    vscode.commands.registerCommand('ptal.refresh', () => refresh()),
    vscode.commands.registerCommand('ptal.nextUnresolved', () => ui.nextUnresolved()),
    vscode.commands.registerCommand('ptal.menu', async () => {
      type Item = vscode.QuickPickItem & { action: 'next' | 'refresh' | 'toggle' | 'open' | 'summaries' };
      const items: Item[] = [
        { label: '$(arrow-right) Go to next unresolved comment', action: 'next' },
        { label: '$(refresh) Refresh review comments', action: 'refresh' },
        { label: `$(eye) ${ui.resolvedShown() ? 'Hide' : 'Show'} resolved comments`, action: 'toggle' },
      ];
      if (lastSummaries.length > 0) {
        items.splice(1, 0, { label: `$(book) Review summaries (${lastSummaries.length})`, action: 'summaries' });
      }
      if (statusBase?.url) {
        items.push({ label: '$(link-external) Open PR on GitHub', action: 'open' });
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: statusBase ? `${statusBase.label} — ${statusBase.title}` : 'PTAL',
      });
      switch (pick?.action) {
        case 'next':
          await ui.nextUnresolved();
          break;
        case 'refresh':
          await refresh();
          break;
        case 'toggle':
          await vscode.commands.executeCommand('ptal.toggleResolved');
          break;
        case 'summaries':
          await vscode.commands.executeCommand('ptal.reviewSummaries');
          break;
        case 'open':
          if (statusBase?.url) {
            void vscode.env.openExternal(vscode.Uri.parse(statusBase.url));
          }
          break;
      }
    }),
    vscode.commands.registerCommand('ptal.reviewSummaries', () =>
      vscode.commands.executeCommand('markdown.showPreview', summaryUri),
    ),
    // full review-time context without the browser: review-time version ↔ working tree
    vscode.commands.registerCommand(
      'ptal.openReviewDiff',
      async (args: { path: string; sha: string; line: number | null }) => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          return;
        }
        try {
          const root = await repoRoot(folder.uri.fsPath);
          if (!(await localContains(root, args.sha))) {
            // honest failure: the review-time commit simply isn't here yet
            void vscode.window.showErrorMessage(
              `PTAL: commit ${args.sha.slice(0, 7)} is not in your local history — run git fetch (or git pull) and try again.`,
            );
            return;
          }
          const left = vscode.Uri.from({
            scheme: 'ptal-rev',
            path: '/' + args.path,
            query: JSON.stringify({ cwd: root, sha: args.sha, path: args.path }),
          });
          const right = vscode.Uri.file(join(root, args.path));
          const title = `${args.path} (review @ ${args.sha.slice(0, 7)} ↔ working tree)`;
          const options = args.line
            ? { selection: new vscode.Range(args.line - 1, 0, args.line - 1, 0) }
            : undefined;
          await vscode.commands.executeCommand('vscode.diff', left, right, title, options);
        } catch (e) {
          void vscode.window.showErrorMessage(`PTAL: couldn't open the review-time diff (${msg(e)})`);
        }
      },
    ),
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
        // optimistic append: no full refresh, so the thread stays open and nothing
        // flickers — goes through CommentUI so the neutral data is updated too and
        // the reply survives cached re-renders (#22)
        const me = await viewer();
        ui.appendComment(reply.thread, {
          id: `optimistic-${Date.now()}`,
          author: me.login,
          authorAvatar: me.avatarUrl,
          body: reply.text,
          url: data.comments[0]?.url ?? '',
          snippet: '',
          createdAt: new Date().toISOString(),
        });
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

  // refresh once when the window regains focus (reviews land while you're in the
  // browser) — throttled hard so alt-tabbing never turns into polling
  let lastFocusRefresh = Date.now();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused && Date.now() - lastFocusRefresh > 30_000) {
        lastFocusRefresh = Date.now();
        void refresh();
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
