import * as vscode from 'vscode';
import { fetchReviewSet } from './github';

function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n', 1)[0].slice(0, 80);
}

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('PTAL');
  context.subscriptions.push(out);

  const refresh = async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    out.appendLine(`[${new Date().toLocaleTimeString()}] refreshing…`);
    try {
      const set = await fetchReviewSet(folder.uri.fsPath);
      if (!set) {
        out.appendLine('no open PR for the current branch');
        return;
      }
      const unresolved = set.threads.filter((t) => !t.isResolved).length;
      out.appendLine(`${set.label} "${set.title}" — threads: ${set.threads.length} (unresolved: ${unresolved})`);
      for (const t of set.threads) {
        const mark = t.isResolved ? '✓' : '•';
        const outdated = t.isOutdated ? ' (outdated)' : '';
        const head = t.comments[0];
        out.appendLine(`  ${mark} ${t.path}:${t.anchorLine ?? '?'}${outdated} — ${head?.author}: ${firstLine(head?.body)}`);
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
  );

  void refresh();
}

export function deactivate() {}
