import * as vscode from 'vscode';
import { fetchReviewSet, repoRoot } from './github';
import { mapAnchor } from './lineMapper';
import { CommentUI, MappedThread } from './commentUI';

function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n', 1)[0].slice(0, 80);
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('PTAL');
  const ui = new CommentUI();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'ptal.nextUnresolved';
  context.subscriptions.push(out, ui, status);

  const refresh = async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    out.appendLine(`[${new Date().toLocaleTimeString()}] refreshing…`);
    try {
      const root = await repoRoot(folder.uri.fsPath);
      const set = await fetchReviewSet(root);
      if (!set) {
        ui.clear();
        status.hide();
        out.appendLine('no open PR for the current branch');
        return;
      }

      const mapped: MappedThread[] = await Promise.all(
        set.threads.map(async (thread) => ({
          thread,
          anchor: await mapAnchor({
            cwd: root,
            path: thread.path,
            anchorSha: thread.anchorSha,
            anchorLine: thread.anchorLine,
            snippet: thread.comments[0]?.snippet ?? '',
          }),
        })),
      );
      ui.render(root, mapped);

      const unresolved = mapped.filter((m) => !m.thread.isResolved).length;
      status.text = `$(comment-discussion) ${set.label}: ${unresolved}/${mapped.length}`;
      status.tooltip = `${set.title}\n${unresolved} unresolved review comment(s) — click to jump to the next one`;
      status.show();

      out.appendLine(`${set.label} "${set.title}" — threads: ${mapped.length} (unresolved: ${unresolved})`);
      for (const { thread, anchor } of mapped) {
        const mark = thread.isResolved ? '✓' : '•';
        const outdated = thread.isOutdated ? ' (outdated)' : '';
        const head = thread.comments[0];
        out.appendLine(
          `  ${mark} ${thread.path}:${anchor.line ?? '?'} [${anchor.confidence}]${outdated} — ${head?.author}: ${firstLine(head?.body)}`,
        );
      }
    } catch (e) {
      out.appendLine(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('ptal.refresh', async () => {
      out.show(true);
      await refresh();
    }),
    vscode.commands.registerCommand('ptal.nextUnresolved', () => ui.nextUnresolved()),
  );

  void refresh();
}

export function deactivate() {}
